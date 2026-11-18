import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { noteIssueWrite } from '../issue-raise.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { providerFor, type TrackerConnection } from './connections.js'
import { emitIssueChanged } from './flow-events.js'
import { absoluteGitlabLinks, projectWebUrl } from './gitlab-text.js'
import { trackerUserId } from './identity.js'
import { readMapped } from './labels.js'
import { addMember, LINKS, MEMBERS, mirrorFields, projectPathFrom } from './link-store.js'
import { OUTBOX } from './outbox.js'
import { IMPORTED_SOURCE, sourceOn } from './source-switch.js'
import type { RemoteIssue } from './types.js'

/**
 * GitLab → Nivaro for issues nobody linked: with `sync.import_new_issues` on, an issue a person
 * opens directly in GitLab (in one of the connection's projects) becomes an issue-log entry,
 * linked exactly like one Nivaro sent (link row `created_via 'imported'` + one issue member), so
 * close/reopen, labels, priority/lanes and comments sync from then on through inbound.ts.
 *
 * Which issues:
 *  - open, not confidential, in the connection's default project or a project one of its
 *    enabled rules creates in (`importProjects`);
 *  - carrying `sync.import_label` when one is set;
 *  - opened after the switch was turned on (`sync.import_since`, set by the server) — or, by
 *    webhook, an older open issue the moment someone adds the import label to it.
 *
 * Never an issue Nivaro opened itself (Nivaro's create can be answered by the webhook BEFORE its
 * link row is stored): skipped when the description carries a Nivaro marker
 * (`<!-- nivaro:issue|ticket|record:… -->`), when a queued / sending outbox create for the same
 * project has the same title, and when the author is the connection token's own GitLab user.
 *
 * Once only: the link row (unique on connection + project + iid) is inserted FIRST as the claim;
 * a second delivery (redelivery, webhook racing the reconcile pass) loses that insert and does
 * nothing. A failure after the claim removes it again, so the next delivery tries afresh.
 */

type Row = Record<string, unknown>

export interface ImportContext {
  source?: 'webhook' | 'reconcile'
  /** Webhook `object_attributes.action` (open, update, close, reopen). */
  action?: string
  /** Labels before this event, when the webhook says the labels changed. */
  labelsPrevious?: string[]
  /** Webhook `user` (who did it; on `open` that is the author). */
  actor?: { id?: number; username?: string; name?: string } | null
}

export interface ImportOutcome {
  result: 'applied' | 'ignored'
  reason: string
  linked: boolean
}

/** Any Nivaro create marker, anywhere in the description (a person may have edited below it). */
export const NIVARO_MARKER = /<!--\s*nivaro:(?:issue|ticket|record):/i
/** An imported issue's title / details caps (the issue log's own: POST /issues). */
const TITLE_MAX = 500
const DETAILS_MAX = 8000
/** The token's own GitLab user is read again after this long. */
const WHOAMI_TTL_MS = 10 * 60_000

const lc = (s: string) => s.trim().toLowerCase()
const asTime = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}
const idOf = (inserted: unknown[]): number => {
  const first = inserted[0]
  return Number(typeof first === 'object' && first !== null ? (first as { id: unknown }).id : first)
}
const parse = (v: unknown): Row => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Row
  if (typeof v !== 'string' || !v) return {}
  try {
    const p = JSON.parse(v)
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Row) : {}
  } catch {
    return {}
  }
}
/** Plain text: control characters other than tab / newline dropped. */
const plain = (s: string) =>
  Array.from(s.replace(/\r\n?/g, '\n'))
    .filter((ch) => {
      const c = ch.charCodeAt(0)
      return c === 9 || c === 10 || (c >= 32 && c !== 127)
    })
    .join('')

/** Is bringing in new GitLab issues on for this connection (and the issue log synced)? */
export function importOn(conn: TrackerConnection | null | undefined): boolean {
  return (
    !!conn?.is_active &&
    conn.sync.import_new_issues === true &&
    !!conn.sync.import_since &&
    sourceOn(conn, 'issue')
  )
}

/**
 * The connection's own projects: its default project and every project one of its enabled rules
 * creates issues in (`action.project_id`). Webhooks from any other project are never imported.
 */
export async function importProjects(conn: TrackerConnection): Promise<number[]> {
  const out = new Set<number>()
  if (conn.default_project_id != null && Number.isSafeInteger(Number(conn.default_project_id)))
    out.add(Number(conn.default_project_id))
  const rules = (await db('nivaro_tracker_rules')
    .where({ connection: conn.id, enabled: true })
    .select('action', 'paused_reason')) as Row[]
  for (const r of rules) {
    if (r.paused_reason != null && r.paused_reason !== '') continue
    const project = Number(parse(r.action).project_id)
    if (Number.isSafeInteger(project) && project > 0) out.add(project)
  }
  return [...out]
}

// ── The token's own GitLab user (echo guard) ─────────────────────────────────

const whoamiCache = new Map<string, { id: number | null; username: string; at: number }>()

/** Tests: forget the cached token users. */
export function resetImportState(): void {
  whoamiCache.clear()
}

async function tokenUser(
  conn: TrackerConnection
): Promise<{ id: number | null; username: string }> {
  const key = `${currentTenantKey()}:${conn.id}`
  const hit = whoamiCache.get(key)
  if (hit && Date.now() - hit.at < WHOAMI_TTL_MS) return hit
  const me = await (await providerFor(conn.id)).whoami()
  const id = Number(me.id)
  const entry = {
    id: Number.isSafeInteger(id) ? id : null,
    username: String(me.username ?? ''),
    at: Date.now()
  }
  whoamiCache.set(key, entry)
  return entry
}

/** A create Nivaro queued (or is sending right now) for this project with this title. */
async function pendingOwnCreate(conn: TrackerConnection, issue: RemoteIssue): Promise<boolean> {
  const rows = (await db(OUTBOX)
    .where({ connection: conn.id, op: 'create' })
    .whereIn('status', ['pending', 'sending'])
    .select('payload')) as Row[]
  const title = lc(String(issue.title ?? ''))
  return rows.some((r) => {
    const p = parse(r.payload)
    return (
      Number(p.project_id) === Number(issue.project_id) &&
      lc(String(parse(p.input).title ?? '')) === title
    )
  })
}

/** Why this unlinked issue is not brought in, or null when it should be. */
async function refusal(
  conn: TrackerConnection,
  issue: RemoteIssue,
  ctx: ImportContext
): Promise<string | null> {
  if (issue.state !== 'opened') return 'it is closed'
  if (issue.confidential) return 'it is confidential'
  if (!(await importProjects(conn)).includes(Number(issue.project_id)))
    return "its project is not one of this connection's projects"

  const label = conn.sync.import_label
  const current = new Set((issue.labels ?? []).map(lc))
  if (label && !current.has(lc(label))) return `it does not carry the "${label}" label`

  const since = asTime(conn.sync.import_since) ?? Number.POSITIVE_INFINITY
  const created = asTime(issue.created_at)
  const isNew =
    created != null ? created >= since : ctx.source === 'webhook' && ctx.action === 'open'
  const labelJustAdded =
    !!label &&
    ctx.source === 'webhook' &&
    Array.isArray(ctx.labelsPrevious) &&
    !ctx.labelsPrevious.map(lc).includes(lc(label))
  if (!isNew && !labelJustAdded)
    return 'it was opened before bringing in new issues was switched on'

  // Echo guards: Nivaro's own creates, whatever order the webhook and the link row arrive in.
  if (NIVARO_MARKER.test(String(issue.description ?? ''))) return 'Nivaro opened it'
  if (await pendingOwnCreate(conn, issue)) return 'Nivaro is opening it'
  const author = {
    id: issue.author?.id ?? (ctx.action === 'open' ? ctx.actor?.id : undefined),
    username: issue.author?.username || (ctx.action === 'open' ? (ctx.actor?.username ?? '') : '')
  }
  if (author.id != null || author.username) {
    // A GitLab failure here throws: the delivery is marked failed and reconcile tries again.
    const me = await tokenUser(conn)
    if (
      (author.id != null && me.id != null && Number(author.id) === me.id) ||
      (!!author.username && !!me.username && lc(author.username) === lc(me.username))
    )
      return "it was opened with this connection's own GitLab token"
  }
  return null
}

/** The status / severity an imported issue starts with. */
function startValues(conn: TrackerConnection, labels: string[]) {
  let status: 'open' | 'in_progress' = 'open'
  if (conn.sync.lanes_two_way) {
    const lane = readMapped(labels, labels, conn.sync.lane_map)
    if (lane === 'in_progress') status = 'in_progress'
  }
  let severity = 'medium'
  if (conn.sync.priority_two_way) {
    const key = readMapped(labels, labels, conn.sync.priority_map)
    if (key) severity = key
  }
  return { status, severity }
}

function detailsOf(
  conn: TrackerConnection,
  issue: RemoteIssue,
  projectPath: string,
  ctx: ImportContext
): string {
  const author =
    issue.author?.username || issue.author?.name
      ? issue.author
      : ctx.action === 'open'
        ? ctx.actor
        : null
  const who = author
    ? author.name && author.username
      ? `${author.name} (@${author.username})`
      : author.username
        ? `@${author.username}`
        : String(author.name ?? '')
    : ''
  const head = [
    `Opened in GitLab${who ? ` by ${plain(who).slice(0, 200)}` : ''}`,
    issue.web_url ? `GitLab issue: ${plain(issue.web_url).slice(0, 800)}` : null
  ]
    .filter(Boolean)
    .join('\n')
  const body = plain(
    absoluteGitlabLinks(
      String(issue.description ?? ''),
      projectWebUrl({ web_url: issue.web_url, project_path: projectPath }, conn)
    )
  ).trim()
  return (body ? `${head}\n\n${body}` : head).slice(0, DETAILS_MAX)
}

/**
 * Bring in an unlinked GitLab issue. null = importing is off for this connection (the caller
 * keeps its own "not linked" answer); otherwise what happened, and why when nothing did.
 */
export async function importUnlinked(
  conn: TrackerConnection,
  issue: RemoteIssue,
  ctx: ImportContext = {}
): Promise<ImportOutcome | null> {
  if (!importOn(conn)) return null
  const why = await refusal(conn, issue, ctx)
  if (why)
    return {
      result: 'ignored',
      reason: `GitLab issue #${issue.iid} is not linked and was not brought in: ${why}`,
      linked: false
    }
  return createImported(conn, issue, ctx)
}

async function createImported(
  conn: TrackerConnection,
  issue: RemoteIssue,
  ctx: ImportContext
): Promise<ImportOutcome> {
  const key = {
    connection: conn.id,
    project_id: Number(issue.project_id),
    external_iid: Number(issue.iid)
  }
  const projectPath = projectPathFrom(issue.web_url, conn.base_url)
  const now = new Date()

  // The claim: the link row first (unique connection + project + iid).
  let linkId: number
  try {
    linkId = idOf(
      (await db(LINKS)
        .insert({
          ...key,
          project_path: projectPath.slice(0, 300),
          ...mirrorFields(issue),
          fingerprint: null,
          created_via: 'imported',
          rule_id: null,
          created_by: null,
          created_at: now
        })
        .returning('id')) as unknown[]
    )
  } catch (err) {
    if (await db(LINKS).where(key).first('id'))
      return { result: 'ignored', reason: 'Already brought in', linked: true }
    throw err
  }

  let issueId: number | null = null
  let machine: string
  try {
    machine = await trackerUserId()
    const { status, severity } = startValues(conn, issue.labels ?? [])
    const title =
      plain(String(issue.title ?? ''))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TITLE_MAX) || `GitLab issue #${issue.iid}`
    issueId = idOf(
      (await db('nivaro_issues')
        .insert({
          title,
          severity,
          status,
          source: IMPORTED_SOURCE,
          details: detailsOf(conn, issue, projectPath, ctx),
          occurrence_count: 1,
          last_seen_at: now,
          raised_by: machine,
          created_at: now,
          updated_at: now
        })
        .returning('id')) as unknown[]
    )
    if (!Number.isSafeInteger(issueId)) throw new Error('The new issue has no id')
    await addMember(linkId, conn.id, issueId, 'lead')
  } catch (err) {
    // Undo the claim so the next delivery (or reconcile) brings it in afresh.
    if (issueId != null && Number.isSafeInteger(issueId)) {
      await db(MEMBERS)
        .where({ link: linkId })
        .delete()
        .catch(() => {})
      await db('nivaro_issues')
        .where({ id: issueId })
        .delete()
        .catch(() => {})
    }
    await db(LINKS)
      .where({ id: linkId })
      .delete()
      .catch(() => {})
    throw err
  }

  // A new issue like any other: the issue-write funnel (hit counters, listeners — the rule engine
  // and recurrence handling skip source 'gitlab') and the activity log.
  noteIssueWrite(issueId, 'raised', { hits: [{ userId: null, at: now }] })
  await logActivity({
    action: 'create',
    user: machine,
    collection: 'nivaro_issues',
    item: String(issueId),
    comment: `Brought in from GitLab issue #${issue.iid}`,
    origin: 'integration'
  })
  emitIssueChanged({
    connection: conn.id,
    link: linkId,
    project_id: key.project_id,
    iid: key.external_iid,
    change: 'imported',
    state: 'opened',
    members: [{ kind: 'issue', id: String(issueId) }]
  })
  return {
    result: 'applied',
    reason: `Brought in as issue #${issueId}`,
    linked: true
  }
}

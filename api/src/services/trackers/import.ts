import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { noteIssueWrite } from '../issue-raise.js'
import type { TrackerConnection } from './connections.js'
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
 * (`<!-- nivaro:issue|ticket|record:… -->`); while a queued / sending outbox create for the same
 * project has the same title it is read again later. The token's author is NOT a guard: with a
 * personal token an admin's own hand-made GitLab issues must still come in.
 *
 * Once only: the link row (unique on connection + project + iid) is inserted FIRST as the claim;
 * a second delivery (redelivery, webhook racing the reconcile pass) loses that insert, waits for
 * the winner's issue and then applies its own change as a linked one. A failure after the claim
 * removes it again; a claim a crash left without its issue is removed by tracker-sweep.
 * Unlinking an imported issue keeps its link as `created_via 'declined'` with no members, so the
 * same GitLab issue is never brought in again (links.ts unlink).
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
  /** Another delivery brought it in meanwhile: apply this change as a linked one now. */
  rerun?: boolean
}

/**
 * Not now, maybe later: thrown on the reconcile pass so it keeps its cursor on this issue and
 * reads it again (a webhook delivery answers "ignored" instead — the next reconcile reads it).
 */
export class ImportRetryLater extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportRetryLater'
  }
}

/** How long a delivery that lost the claim waits for the winner's issue (L1). */
const CLAIM_WAIT_MS = 2_000
const CLAIM_POLL_MS = 100
/** A claimed link still without its issue after this long was left by a crash (sweep). */
export const STUCK_CLAIM_MS = 10 * 60_000
/** The created_via of an imported link whose issue was unlinked: kept so it never comes back. */
export const DECLINED_VIA = 'declined'

/** Any Nivaro create marker, anywhere in the description (a person may have edited below it). */
export const NIVARO_MARKER = /<!--\s*nivaro:(?:issue|ticket|record):/i
/** An imported issue's title / details caps (the issue log's own: POST /issues). */
const TITLE_MAX = 500
const DETAILS_MAX = 8000

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
 * The connection's own projects: its default project and every project one of its enabled
 * issue-log rules creates issues in (`action.project_id`; ticket rules do not count). Webhooks from any other project are never imported.
 */
export async function importProjects(conn: TrackerConnection): Promise<number[]> {
  const out = new Set<number>()
  if (conn.default_project_id != null && Number.isSafeInteger(Number(conn.default_project_id)))
    out.add(Number(conn.default_project_id))
  const rules = (await db('nivaro_tracker_rules')
    .where({ connection: conn.id, enabled: true })
    .select('action', 'paused_reason', 'applies_to')) as Row[]
  for (const r of rules) {
    if (r.paused_reason != null && r.paused_reason !== '') continue
    // issue-log rules only: a ticket rule's project is where support requests go
    if (r.applies_to != null && r.applies_to !== '' && r.applies_to !== 'issue') continue
    const project = Number(parse(r.action).project_id)
    if (Number.isSafeInteger(project) && project > 0) out.add(project)
  }
  return [...out]
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

/**
 * Why this unlinked issue is not brought in (`retry`: it may be later — reconcile reads it again),
 * or null when it should be.
 */
async function refusal(
  conn: TrackerConnection,
  issue: RemoteIssue,
  ctx: ImportContext
): Promise<{ why: string; retry?: boolean } | null> {
  const no = (why: string) => ({ why })
  if (issue.state !== 'opened') return no('it is closed')
  if (issue.confidential) return no('it is confidential')
  if (!(await importProjects(conn)).includes(Number(issue.project_id)))
    return no("its project is not one of this connection's projects")

  const label = conn.sync.import_label
  const current = new Set((issue.labels ?? []).map(lc))
  if (label && !current.has(lc(label))) return no(`it does not carry the "${label}" label`)

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
    return no('it was opened before bringing in new issues was switched on')

  // Echo guards: Nivaro's own creates, whatever order the webhook and the link row arrive in.
  // Every Nivaro create carries its marker; while one is queued or being sent, a same-titled
  // issue may be it — read again later (by then its link exists, or the create is gone).
  if (NIVARO_MARKER.test(String(issue.description ?? ''))) return no('Nivaro opened it')
  if (await pendingOwnCreate(conn, issue))
    return { why: 'Nivaro may be opening it (a create with this title is under way)', retry: true }
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
  const no = await refusal(conn, issue, ctx)
  if (no) {
    const reason = `GitLab issue #${issue.iid} is not linked and was not brought in: ${no.why}`
    if (no.retry && ctx.source === 'reconcile') throw new ImportRetryLater(reason)
    return {
      result: 'ignored',
      reason: no.retry ? `${reason}; read again on the next reconcile` : reason,
      linked: false
    }
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
    const other = (await db(LINKS).where(key).first('id')) as Row | undefined
    if (!other) throw err
    // Another delivery holds the claim: wait for its issue, then apply this change as linked.
    const ready = await waitForImportedIssue(Number(other.id), issue.iid, ctx.source)
    return ready
      ? { result: 'ignored', reason: 'Already brought in', linked: true, rerun: true }
      : {
          result: 'ignored',
          reason: `GitLab issue #${issue.iid} is still being brought in; read again on the next reconcile`,
          linked: true
        }
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
    if ((await addMember(linkId, conn.id, issueId, 'lead')) !== 'added')
      throw new Error('The new issue could not be added to its GitLab link')
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

/**
 * A link another delivery claimed for an import has no issue yet: wait (≤ 2 s) for it. True = it
 * is there, apply the change as linked. Not there: the reconcile pass throws ImportRetryLater (its
 * cursor stays on this issue), a webhook delivery gets false (the next reconcile reads it again).
 */
export async function waitForImportedIssue(
  linkId: number,
  iid: number,
  source: ImportContext['source']
): Promise<boolean> {
  const deadline = Date.now() + CLAIM_WAIT_MS
  for (;;) {
    if (await db(MEMBERS).where({ link: linkId }).first('id')) return true
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, CLAIM_POLL_MS))
  }
  if (source === 'reconcile')
    throw new ImportRetryLater(`GitLab issue #${iid} is still being brought in`)
  return false
}

/**
 * tracker-sweep: an imported link whose issue never arrived (a crash between the claim and the
 * member) is removed, so the next webhook or reconcile brings the issue in. Only claims between
 * 10 minutes and a day old are looked at (the sweep runs every 5 minutes); a declined link
 * (`created_via 'declined'`, its issue unlinked on purpose) is never touched.
 */
export async function sweepStuckImports(now = new Date()): Promise<number> {
  const rows = (await db(LINKS)
    .where({ created_via: 'imported' })
    .where('created_at', '<', new Date(now.getTime() - STUCK_CLAIM_MS))
    .where('created_at', '>=', new Date(now.getTime() - 86_400_000))
    .select('id')) as Row[]
  let removed = 0
  for (const r of rows) {
    if (await db(MEMBERS).where({ link: r.id }).first('id')) continue
    removed += Number(await db(LINKS).where({ id: r.id, created_via: 'imported' }).delete()) || 0
  }
  return removed
}

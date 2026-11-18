import { randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import {
  type IssueActor,
  type IssueStatus,
  setIssueSeverity,
  setIssueStatus
} from '../issue-status.js'
import { announceRecordAspect, emitRecordEvent } from '../record-events.js'
import { getConnection, markBroken, providerFor, type TrackerConnection } from './connections.js'
import { trackersEnabled } from './feature.js'
import { trackerUserId } from './identity.js'
import { normalizePriority, readMapped } from './labels.js'
import { LINKS, MEMBERS, mirrorFields, SOURCE_ISSUE } from './link-store.js'
import { OUTBOX } from './outbox.js'
import type { SeverityName } from './rules.js'
import { type RemoteIssue, type RemoteNote, TrackerError } from './types.js'

/**
 * GitLab → Nivaro: the appliers the webhook (routes/tracker-hooks.ts) and the reconcile pass share.
 *
 * - An issue change refreshes the link's mirror columns, then moves the member issues: a close sets
 *   `sync.status_map.closed` on every member still open, a reopen opens every resolved/closed
 *   member; with `lanes_two_way` an added lane label sets that status (a state change in the same
 *   event wins); with `priority_two_way` an added priority label sets `severity`. Every write goes
 *   through services/issue-status.ts as the GitLab machine user.
 * - A note becomes a `nivaro_comments` row on every member issue (when `sync.comments`).
 *
 * Echo rules: a target value a member already has is skipped; a label change that is exactly what
 * our own last 'labels' outbox op did (within 60 s) is skipped; notes carrying our own comment,
 * example, roll-up or seen-again marker on their last line, system notes and notes already stored are
 * skipped.
 */

export const OWN_COMMENT_MARKER = /<!-- nivaro:comment:([0-9a-f-]{36}) -->/i
const EXAMPLE_MARKER = /^<!-- nivaro:example:\d+ -->$/i
/** The last line of a "seen again" note (outbound-sync.ts seenMarker). */
const SEEN_MARKER = /^<!-- nivaro:seen:\d+ -->$/i
/** The last line of an example roll-up note (examples.ts rollupMarker). */
const ROLLUP_MARKER = /^<!-- nivaro:rollup:\d+ -->$/i
/** Our own label op this recent still explains a label event. */
export const LABEL_ECHO_MS = 60_000
/** Reconcile looks back this far the first time (no last_reconcile_at yet). */
const FIRST_RECONCILE_MS = 24 * 3_600_000
/** Links touched within this window (or open on either side) are reconciled. */
const RECONCILE_WINDOW_MS = 30 * 86_400_000
/** updatedIssues answers at most this many per project (gitlab.ts MAX_UPDATED). */
const UPDATED_CAP = 500
/** A mirrored GitLab comment longer than this is cut. */
const NOTE_MAX = 100_000

export const EVENTS = 'nivaro_tracker_events'
const CONNECTIONS = 'nivaro_tracker_connections'
const DONE: IssueStatus[] = ['resolved', 'closed']

type Row = Record<string, unknown>
export type InboundResult = 'applied' | 'ignored'
export interface InboundOutcome {
  result: InboundResult
  reason: string
  /** The GitLab issue is linked on this connection. */
  linked: boolean
}

/** What the webhook knows about the event beyond the issue itself. */
export interface IssueEventContext {
  /** Labels before this event (`changes.labels.previous`); default: the link's mirrored labels. */
  labelsPrevious?: string[]
  /** This event closed or reopened the issue; default: compared with the mirrored state. */
  stateChanged?: boolean
  /** false: the payload carries no milestone title — keep the mirrored one. */
  milestoneKnown?: boolean
  /** reconcile: only changes strictly newer than `remote_updated_at` apply. */
  source?: 'webhook' | 'reconcile'
}

const strList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v !== 'string' || !v) return []
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p.map(String) : []
  } catch {
    return []
  }
}

const lc = (s: string) => s.trim().toLowerCase()
const asDate = (v: unknown): Date | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}
const short = (err: unknown) =>
  (err instanceof Error ? err.message : String(err ?? 'Unknown error')).slice(0, 500)

/** A GitLab webhook time ("2026-11-17 14:03:11 UTC" or ISO) as ISO, '' when unreadable. */
export function gitlabTime(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  let d = new Date(s)
  if (Number.isNaN(d.getTime())) d = new Date(s.replace(/ UTC$/, 'Z').replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

/** Label names from a webhook label list (objects with `title`) or plain strings. */
export function labelTitles(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((l) => (typeof l === 'string' ? l : (l as { title?: unknown; name?: unknown })?.title))
    .filter((l): l is string => typeof l === 'string' && l.trim() !== '')
}

async function findLink(connection: number, projectId: number, iid: number) {
  if (!Number.isFinite(projectId) || !Number.isFinite(iid)) return undefined
  return (await db(LINKS)
    .where({ connection, project_id: projectId, external_iid: iid })
    .first()) as Row | undefined
}

interface MemberIssue {
  id: number
  status: string
  severity: string
}

async function memberIssues(linkId: number): Promise<MemberIssue[]> {
  const rows = (await db(MEMBERS)
    .where({ link: linkId, source_kind: SOURCE_ISSUE })
    .select('source_id')) as Row[]
  const ids = [...new Set(rows.map((r) => Number(r.source_id)).filter(Number.isFinite))]
  if (!ids.length) return []
  const issues = await selectInChunks(
    ids,
    500,
    async (chunk) =>
      (await whereInList(db('nivaro_issues'), 'id', chunk).select(
        'id',
        'status',
        'severity'
      )) as Row[]
  )
  return issues.map((r) => ({
    id: Number(r.id),
    status: String(r.status ?? ''),
    severity: String(r.severity ?? '')
  }))
}

/**
 * True when this label change is what our own most recent 'labels' op for the link did (sent in
 * the last 60 s): every added label is one it added, every removed label one it removed, and the
 * result holds its adds and none of its removes.
 */
async function ownLabelEcho(
  linkId: number,
  previous: string[],
  current: string[],
  now = new Date()
): Promise<boolean> {
  const since = new Date(now.getTime() - LABEL_ECHO_MS)
  const op = (await db(OUTBOX)
    .where({ link: linkId, op: 'labels' })
    .whereIn('status', ['done', 'sending'])
    .where((w: any) => w.where('done_at', '>=', since).orWhere('created_at', '>=', since))
    .orderBy('id', 'desc')
    .first('payload')) as Row | undefined
  if (!op) return false
  let payload: Row = {}
  try {
    payload = typeof op.payload === 'string' ? JSON.parse(op.payload) : ((op.payload as Row) ?? {})
  } catch {
    return false
  }
  const add = new Set(strList(payload.add_labels).map(lc))
  const remove = new Set(strList(payload.remove_labels).map(lc))
  const prev = new Set(previous.map(lc))
  const cur = new Set(current.map(lc))
  const added = [...cur].filter((l) => !prev.has(l))
  const removed = [...prev].filter((l) => !cur.has(l))
  if (!added.length && !removed.length) return false
  return (
    added.every((l) => add.has(l)) &&
    removed.every((l) => remove.has(l)) &&
    [...add].every((l) => cur.has(l)) &&
    [...remove].every((l) => !cur.has(l))
  )
}

const statusWord: Record<string, string> = {
  open: 'open',
  in_progress: 'in progress',
  resolved: 'resolved',
  closed: 'closed'
}

/** applyIssueEvent with the reason (the webhook's event row stores it). */
export async function applyIssueEventDetailed(
  connection: number,
  issue: RemoteIssue,
  actor: string | null,
  ctx: IssueEventContext = {}
): Promise<InboundOutcome> {
  const conn = await getConnection(connection)
  if (!conn) return { result: 'ignored', reason: 'Connection not found', linked: false }
  const link = await findLink(connection, Number(issue.project_id), Number(issue.iid))
  if (!link)
    return { result: 'ignored', reason: `GitLab issue #${issue.iid} is not linked`, linked: false }
  const linkId = Number(link.id)

  const at = asDate(issue.updated_at)
  const stored = asDate(link.remote_updated_at)
  if (at && stored) {
    const stale =
      ctx.source === 'reconcile'
        ? at.getTime() <= stored.getTime()
        : at.getTime() < stored.getTime()
    if (stale) return { result: 'ignored', reason: 'Older than the last change seen', linked: true }
  }

  const previous = ctx.labelsPrevious ?? strList(link.remote_labels)
  const current = issue.labels ?? []
  const prevState = String(link.remote_state ?? '')
  const stateChanged = ctx.stateChanged ?? (prevState !== '' && prevState !== issue.state)

  // Mirror first: anything comparing Nivaro with GitLab after the member writes below sees the
  // new GitLab state and labels, so a change read from GitLab is never sent back.
  const mirror = mirrorFields(issue)
  if (ctx.milestoneKnown === false) delete mirror.remote_milestone
  if (!at) delete mirror.remote_updated_at
  if (!issue.web_url) delete mirror.web_url
  if (!issue.id) delete mirror.external_id
  await db(LINKS).where({ id: linkId }).update(mirror)

  const members = await memberIssues(linkId)
  if (!members.length)
    return { result: 'ignored', reason: 'No Nivaro issues on this link', linked: true }

  const who = actor ? 'GitLab' : 'GitLab (sync)'
  const by = actor ? ` by @${actor}` : ''

  // Status: a state change wins over a lane label in the same event.
  let status: { to: IssueStatus; only?: (m: MemberIssue) => boolean; note: string } | null = null
  if (stateChanged && issue.state === 'closed') {
    const to = conn.sync.status_map.closed
    status = {
      to,
      only: (m) => !DONE.includes(m.status as IssueStatus),
      note: `${who}: closed${by}`
    }
  } else if (stateChanged && issue.state === 'opened') {
    status = {
      to: 'open',
      only: (m) => DONE.includes(m.status as IssueStatus),
      note: `${who}: reopened${by}`
    }
  }

  const prevSet = new Set(previous.map(lc))
  const added = current.filter((l) => !prevSet.has(lc(l)))
  const curSet = new Set(current.map(lc))
  const labelsChanged = added.length > 0 || previous.some((l) => !curSet.has(lc(l)))
  const echo = labelsChanged && (await ownLabelEcho(linkId, previous, current))

  if (!status && !echo && conn.sync.lanes_two_way && added.length) {
    const lane = readMapped(added, current, conn.sync.lane_map) as IssueStatus | null
    if (lane) {
      const label = conn.sync.lane_map[lane] ?? lane
      status = { to: lane, note: `${who}: moved to ${label} (${statusWord[lane]})${by}` }
    }
  }
  let severity: { to: SeverityName; note: string } | null = null
  if (!echo && conn.sync.priority_two_way && added.length) {
    const key = readMapped(added, current, conn.sync.priority_map) as SeverityName | null
    if (key) {
      const label = conn.sync.priority_map[key] ?? key
      severity = { to: key, note: `${who}: priority ${key} (${label})${by}` }
    }
  }

  let moved = 0
  let reprioritised = 0
  try {
    const machine: IssueActor = { userId: await trackerUserId(), via: 'gitlab' }
    for (const m of members) {
      if (status && m.status !== status.to && (!status.only || status.only(m))) {
        await setIssueStatus(m.id, status.to, machine, status.note)
        moved++
      }
      if (severity && normalizePriority(m.severity) !== severity.to) {
        await setIssueSeverity(m.id, severity.to, machine, severity.note)
        reprioritised++
      }
    }
  } catch (err) {
    // Put the mirror back so the next delivery or reconcile sees this change as new again.
    const back: Row = {}
    for (const k of Object.keys(mirror)) back[k] = link[k] ?? null
    await db(LINKS)
      .where({ id: linkId })
      .update(back)
      .catch(() => {})
    throw err
  }

  if (!moved && !reprioritised)
    return {
      result: 'ignored',
      reason: echo ? 'Our own label change' : 'Nothing to change',
      linked: true
    }
  const parts: string[] = []
  if (moved) parts.push(`${moved} issue(s) → ${statusWord[status?.to ?? ''] ?? status?.to}`)
  if (reprioritised) parts.push(`${reprioritised} issue(s) → ${severity?.to}`)
  return { result: 'applied', reason: parts.join('; '), linked: true }
}

export async function applyIssueEvent(
  connection: number,
  issue: RemoteIssue,
  actor: string | null,
  ctx: IssueEventContext = {}
): Promise<InboundResult> {
  return (await applyIssueEventDetailed(connection, issue, actor, ctx)).result
}

const lastLine = (body: string): string =>
  body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .pop() ?? ''

/** Our own comment, example, roll-up or seen-again marker on the note's last non-empty line. */
export function isOwnNote(body: unknown): boolean {
  const last = lastLine(String(body ?? ''))
  if (!last) return false
  const m = OWN_COMMENT_MARKER.exec(last)
  return (
    (!!m && m[0] === last) ||
    EXAMPLE_MARKER.test(last) ||
    SEEN_MARKER.test(last) ||
    ROLLUP_MARKER.test(last)
  )
}

/** The start of a mirrored comment's meta (key order fixed so it can be found by prefix). */
const metaPrefix = (linkId: number, noteId: number) =>
  `{"tracker":{"link":${linkId},"note_id":${noteId},`

/** applyNoteEvent with the reason. */
export async function applyNoteEventDetailed(
  connection: number,
  projectId: number,
  iid: number,
  note: RemoteNote
): Promise<InboundOutcome> {
  const conn = await getConnection(connection)
  if (!conn) return { result: 'ignored', reason: 'Connection not found', linked: false }
  if (!conn.sync.comments)
    return { result: 'ignored', reason: 'Comment sync is off', linked: false }
  if (note.system) return { result: 'ignored', reason: 'A GitLab system note', linked: false }
  if (note.internal) return { result: 'ignored', reason: 'An internal GitLab note', linked: false }
  if (isOwnNote(note.body)) return { result: 'ignored', reason: 'Our own comment', linked: false }
  const noteId = Number(note.id)
  if (!Number.isSafeInteger(noteId))
    return { result: 'ignored', reason: 'The note has no id', linked: false }
  const link = await findLink(connection, Number(projectId), Number(iid))
  if (!link)
    return { result: 'ignored', reason: `GitLab issue #${iid} is not linked`, linked: false }
  const linkId = Number(link.id)

  const seen = await db('nivaro_comments')
    .where({ collection: 'nivaro_issues' })
    .where('meta', 'like', `${metaPrefix(linkId, noteId)}%`)
    .first('id')
  if (seen) return { result: 'ignored', reason: 'Already stored', linked: true }

  const members = await memberIssues(linkId)
  if (!members.length)
    return { result: 'ignored', reason: 'No Nivaro issues on this link', linked: true }

  const username = String(note.author?.username ?? '').trim()
  const name = String(note.author?.name ?? '').trim()
  const author = username ? (name ? `${name} (@${username})` : `@${username}`) : name || 'GitLab'
  const meta = `${metaPrefix(linkId, noteId)}"author":${JSON.stringify(author)}}}`
  const text = String(note.body ?? '').slice(0, NOTE_MAX)
  const userId = await trackerUserId()
  const created = asDate(note.created_at) ?? new Date()
  for (const m of members) {
    await db('nivaro_comments').insert({
      id: randomUUID(),
      collection: 'nivaro_issues',
      item: String(m.id),
      user: userId,
      text,
      meta,
      created_at: created,
      updated_at: new Date()
    })
    // Lists showing a comment count and open threads refresh (as POST /comments does).
    announceRecordAspect('nivaro_issues', m.id, '$comments')
    emitRecordEvent('nivaro_issues', m.id, 'record:comment', { user: userId })
  }
  return { result: 'applied', reason: `Comment added to ${members.length} issue(s)`, linked: true }
}

export async function applyNoteEvent(
  connection: number,
  projectId: number,
  iid: number,
  note: RemoteNote
): Promise<InboundResult> {
  return (await applyNoteEventDetailed(connection, projectId, iid, note)).result
}

// ── Webhook deliveries ───────────────────────────────────────────────────────

export interface Delivery {
  connection: number
  uuid: string | null
  /** X-Gitlab-Event header, else the body's object_kind. */
  kind: string
  body: unknown
}

const objOf = (v: unknown): Row =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {}

function iidOf(body: Row): number | null {
  const kind = String(body.object_kind ?? '')
  const n =
    kind === 'note' ? Number(objOf(body.issue).iid) : Number(objOf(body.object_attributes).iid)
  return Number.isSafeInteger(n) ? n : null
}

const idOf = (inserted: unknown[]): number => {
  const first = inserted[0]
  return Number(typeof first === 'object' && first !== null ? (first as { id: unknown }).id : first)
}

/**
 * Note a delivery before it is answered (the uuid is unique, so a second delivery of the same
 * event loses the insert). Returns the event row id, or 'duplicate'.
 */
export async function recordDelivery(d: Delivery): Promise<number | 'duplicate'> {
  const uuid = d.uuid ? d.uuid.slice(0, 64) : null
  if (uuid) {
    const seen = await db(EVENTS).where({ event_uuid: uuid }).first('id')
    if (seen) return 'duplicate'
  }
  const row = {
    connection: d.connection,
    event_uuid: uuid,
    kind: d.kind.slice(0, 30) || 'unknown',
    external_iid: iidOf(objOf(d.body)),
    received_at: new Date(),
    status: 'received'
  }
  try {
    return idOf((await db(EVENTS).insert(row).returning('id')) as unknown[])
  } catch (err) {
    if (uuid && (await db(EVENTS).where({ event_uuid: uuid }).first('id'))) return 'duplicate'
    throw err
  }
}

/** The issue in an Issue Hook payload, with what the event says changed. */
export function issueFromHook(body: Row): { issue: RemoteIssue; ctx: IssueEventContext } {
  const a = objOf(body.object_attributes)
  const changes = objOf(body.changes)
  const labelChange = changes.labels ? objOf(changes.labels) : null
  const milestone = objOf(a.milestone)
  const issue: RemoteIssue = {
    id: Number(a.id) || 0,
    iid: Number(a.iid),
    project_id: Number(objOf(body.project).id ?? a.project_id),
    web_url: typeof a.url === 'string' ? a.url : '',
    title: String(a.title ?? ''),
    state: a.state === 'closed' ? 'closed' : 'opened',
    labels: labelTitles(labelChange?.current ?? body.labels ?? a.labels),
    assignees: (Array.isArray(body.assignees) ? body.assignees : []).map((x) => {
      const u = objOf(x)
      return { id: Number(u.id), username: String(u.username ?? ''), name: String(u.name ?? '') }
    }),
    milestone: milestone.title
      ? { id: Number(milestone.id), title: String(milestone.title) }
      : null,
    updated_at: gitlabTime(a.updated_at),
    description: typeof a.description === 'string' ? a.description : null
  }
  const action = String(a.action ?? '')
  const ctx: IssueEventContext = {
    source: 'webhook',
    milestoneKnown: !!milestone.title || a.milestone_id === null
  }
  if (labelChange) ctx.labelsPrevious = labelTitles(labelChange.previous)
  if (action === 'close' || action === 'reopen' || changes.state_id) ctx.stateChanged = true
  return { issue, ctx }
}

/** The note in a Note Hook payload (on an issue). */
export function noteFromHook(body: Row): { projectId: number; iid: number; note: RemoteNote } {
  const a = objOf(body.object_attributes)
  const user = objOf(body.user)
  return {
    projectId: Number(objOf(body.project).id ?? a.project_id),
    iid: Number(objOf(body.issue).iid),
    note: {
      id: Number(a.id),
      body: String(a.note ?? ''),
      author: { username: String(user.username ?? ''), name: String(user.name ?? '') },
      created_at: gitlabTime(a.created_at),
      system: a.system === true,
      internal: a.internal === true || a.confidential === true
    }
  }
}

/** Process one recorded delivery (after the 200): apply it, then store the outcome on its row. */
export async function processDelivery(eventId: number | null, d: Delivery): Promise<void> {
  let outcome: { result: InboundResult | 'failed'; reason: string }
  try {
    await db(CONNECTIONS)
      .where({ id: d.connection })
      .update({ last_webhook_at: new Date() })
      .catch(() => {})
    const body = objOf(d.body)
    const kind = String(body.object_kind ?? '')
    if (!(await trackersEnabled())) outcome = { result: 'ignored', reason: 'GitLab sync is off' }
    else if (kind === 'issue') {
      const { issue, ctx } = issueFromHook(body)
      const actor = String(objOf(body.user).username ?? '').trim() || null
      outcome = await applyIssueEventDetailed(d.connection, issue, actor, ctx)
    } else if (kind === 'note' && objOf(body.object_attributes).noteable_type === 'Issue') {
      const { projectId, iid, note } = noteFromHook(body)
      outcome = await applyNoteEventDetailed(d.connection, projectId, iid, note)
    } else {
      outcome = { result: 'ignored', reason: `Not handled: ${d.kind || kind || 'unknown'}` }
    }
  } catch (err) {
    outcome = { result: 'failed', reason: short(err) }
  }
  if (eventId == null) return
  await db(EVENTS)
    .where({ id: eventId })
    .update({ status: outcome.result, reason: outcome.reason.slice(0, 500) })
    .catch(() => {})
}

// ── Reconcile ────────────────────────────────────────────────────────────────

/** Projects with links touched in the last 30 days or open on either side. */
async function projectsToReconcile(connection: number, now: Date): Promise<number[]> {
  const cutoff = now.getTime() - RECONCILE_WINDOW_MS
  const links = (await db(LINKS)
    .where({ connection })
    .select('id', 'project_id', 'remote_state', 'last_synced_at', 'created_at')) as Row[]
  const projects = new Set<number>()
  const unsure = new Map<number, number>()
  for (const l of links) {
    const project = Number(l.project_id)
    if (!Number.isFinite(project) || projects.has(project)) continue
    const touched = Math.max(
      asDate(l.last_synced_at)?.getTime() ?? 0,
      asDate(l.created_at)?.getTime() ?? 0
    )
    if (l.remote_state === 'opened' || touched >= cutoff) projects.add(project)
    else unsure.set(Number(l.id), project)
  }
  // Closed in GitLab and quiet: still reconciled while a Nivaro member is open.
  const pending = [...unsure.entries()].filter(([, p]) => !projects.has(p))
  if (pending.length) {
    const members = await selectInChunks(
      pending.map(([id]) => id),
      500,
      async (chunk) =>
        (await whereInList(db(MEMBERS), 'link', chunk)
          .where({ source_kind: SOURCE_ISSUE })
          .select('link', 'source_id')) as Row[]
    )
    const issueIds = [...new Set(members.map((m) => Number(m.source_id)).filter(Number.isFinite))]
    const open = new Set(
      (
        await selectInChunks(
          issueIds,
          500,
          async (chunk) =>
            (await whereInList(db('nivaro_issues'), 'id', chunk)
              .whereIn('status', ['open', 'in_progress'])
              .select('id')) as Row[]
        )
      ).map((r) => Number(r.id))
    )
    for (const m of members) {
      if (!open.has(Number(m.source_id))) continue
      const p = unsure.get(Number(m.link))
      if (p != null) projects.add(p)
    }
  }
  return [...projects]
}

/** Reconcile runs an issue that keeps failing may hold the cursor back before it is skipped. */
export const RECONCILE_HOLD_RUNS = 3
/** At most one reconcile failure line per this long per process (reconcileAll). */
export const RECONCILE_LOG_EVERY_MS = 10 * 60_000

/** connection:project:iid → consecutive reconcile runs in which applying that issue failed. */
const issueFailures = new Map<string, number>()
const reconcileLog = { lastAt: 0, since: 0 }

/** Tests: forget held issues and the log limiter. */
export function resetReconcileState(): void {
  issueFailures.clear()
  reconcileLog.lastAt = 0
  reconcileLog.since = 0
}

function warn(line: string): void {
  // biome-ignore lint/suspicious/noConsole: a sync that stopped moving must show in the log
  console.warn(`[trackers] ${line}`.slice(0, 600))
}

/** A failed reconcile of one connection (reconcileAll): logged at most once per 10 minutes. */
export function noteReconcileFailure(connection: number, err: unknown, now = Date.now()): void {
  reconcileLog.since++
  if (reconcileLog.lastAt && now - reconcileLog.lastAt < RECONCILE_LOG_EVERY_MS) return
  const n = reconcileLog.since
  reconcileLog.lastAt = now
  reconcileLog.since = 0
  warn(
    `GitLab reconcile failed for connection ${connection} (${n} failure${n === 1 ? '' : 's'} since the last report): ${short(err)}`
  )
}

/** A problem reconcile cannot fix by retrying: shown on the connection (not marked broken). */
async function noteConnectionError(conn: TrackerConnection, message: string): Promise<void> {
  const text = message.slice(0, 1000)
  if (conn.last_error === text) return // already shown and logged
  conn.last_error = text
  warn(`connection ${conn.id}: ${text}`)
  await db(CONNECTIONS)
    .where({ id: conn.id })
    .update({ last_error: text, updated_at: new Date() })
    .catch(() => {})
}

async function projectLabel(connection: number, project: number): Promise<string> {
  const row = (await db(LINKS)
    .where({ connection, project_id: project })
    .first('project_path')
    .catch(() => undefined)) as Row | undefined
  const path = typeof row?.project_path === 'string' ? row.project_path.trim() : ''
  return path || String(project)
}

/**
 * Read what changed in GitLab since the last reconcile and apply it like the webhook does
 * (actor null: activity says "GitLab (sync)"). last_reconcile_at moves to the newest GitLab
 * `updated_at` seen, never to now, and never past: a project that failed for a reason a retry may
 * fix, a project whose answer hit the 500 cap (its newest), an issue that failed (just before it,
 * for at most 3 runs). A project GitLab will not answer (deleted, no access, refused) and an issue
 * that keeps failing are skipped past, logged and shown as the connection's last_error.
 */
export async function reconcileConnection(
  id: number,
  now = new Date()
): Promise<{ checked: number; applied: number }> {
  const tally = { checked: 0, applied: 0 }
  if (!(await trackersEnabled())) return tally
  const conn: TrackerConnection | null = await getConnection(id)
  if (!conn?.is_active || conn.status !== 'ok') return tally
  const since = asDate(conn.last_reconcile_at) ?? new Date(now.getTime() - FIRST_RECONCILE_MS)

  const projects = await projectsToReconcile(id, now)
  if (!projects.length) return tally
  const provider = await providerFor(id)

  let newest = since.getTime()
  let ceiling = Number.POSITIVE_INFINITY
  for (const project of projects) {
    let issues: RemoteIssue[]
    try {
      issues = await provider.updatedIssues(project, since)
    } catch (err) {
      if (err instanceof TrackerError && err.kind === 'auth') {
        await markBroken(id, short(err)).catch(() => {})
        return tally
      }
      if (err instanceof TrackerError && (err.kind === 'not_found' || err.kind === 'invalid')) {
        // A retry will not help: skip it without holding the others back.
        await noteConnectionError(
          conn,
          `GitLab project ${await projectLabel(id, project)} could not be read: ${short(err)}`
        )
        continue
      }
      ceiling = since.getTime()
      continue
    }
    let projectNewest = since.getTime()
    for (const issue of issues) {
      tally.checked++
      const at = asDate(issue.updated_at)?.getTime()
      if (at != null && at > projectNewest) projectNewest = at
      const key = `${id}:${project}:${issue.iid}`
      try {
        const out = await applyIssueEventDetailed(id, issue, null, { source: 'reconcile' })
        if (out.result === 'applied') tally.applied++
        if (out.linked && conn.sync.comments) {
          const notes = await provider.notes(project, issue.iid, since)
          for (const note of notes) {
            if ((await applyNoteEvent(id, project, issue.iid, note)) === 'applied') tally.applied++
          }
        }
        issueFailures.delete(key)
      } catch (err) {
        if (err instanceof TrackerError && err.kind === 'auth') {
          await markBroken(id, short(err)).catch(() => {})
          return tally
        }
        // One issue failing must not hide the others; it is read again next pass — for at most
        // 3 runs, then it stops holding the cursor (a write that always fails would freeze it).
        const runs = (issueFailures.get(key) ?? 0) + 1
        if (runs <= RECONCILE_HOLD_RUNS) {
          issueFailures.set(key, runs)
          ceiling = Math.min(ceiling, at != null ? at - 1 : since.getTime())
        } else {
          issueFailures.delete(key)
          await noteConnectionError(
            conn,
            `GitLab issue #${issue.iid} in project ${await projectLabel(id, project)} could not be applied ${RECONCILE_HOLD_RUNS + 1} times and was skipped: ${short(err)}`
          )
        }
      }
    }
    if (issues.length >= UPDATED_CAP) ceiling = Math.min(ceiling, projectNewest)
    newest = Math.max(newest, projectNewest)
  }
  const next = Math.min(newest, ceiling)
  if (next > since.getTime())
    await db(CONNECTIONS)
      .where({ id })
      .update({ last_reconcile_at: new Date(next) })
  return tally
}

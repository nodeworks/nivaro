import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import { getConnection, listConnections, type TrackerConnection } from './connections.js'
import { trackersEnabled } from './feature.js'
import { TRACKER_EMAIL } from './identity.js'
import { issueVars, loadIssue, loadIssueLite } from './issue-body.js'
import { labelSwap, normalizePriority, safeLabels } from './labels.js'
import { LINKS, MEMBERS, type MemberKind, memberFor, SOURCE_ISSUE } from './link-store.js'
import { enqueue, type LabelsPayload, OUTBOX } from './outbox.js'
import { SEVERITIES } from './rules.js'
import { fingerprintLink, joinAsExample } from './similar.js'
import { ticketLane } from './source-body.js'
import { sourceOn } from './source-switch.js'
import { parseRecordId } from './sources/types.js'
import { sanitizeMarkdown } from './templates.js'

/**
 * Nivaro → GitLab for linked issues: comments, close/reopen, priority and lane label swaps, the
 * throttled "seen again" note and recurrences. Everything goes through the outbox (enqueue) and
 * every entry point is a no-op while GitLab sync is off, for an unlinked issue, or for a
 * connection that is turned off or broken.
 *
 * Echo guard: a change made by the GitLab machine user (`via: 'gitlab'`) is never sent back, a
 * comment mirrored from GitLab (`meta.tracker`) never goes out, and field comments never go out.
 * A GitLab issue a person wrote (`created_via 'linked'`) gets comments and notes only — no
 * close/reopen and no label swaps unless the connection's `push_to_linked` is on.
 */

type Row = Record<string, unknown>

const CLOSED_STATUSES = new Set(['resolved', 'closed'])
/** A member this new was joined on the write being handled: its example note is enough. */
const JUST_JOINED_MS = 2 * 60_000
const OPEN_STATUSES = new Set(['open', 'in_progress'])
/** A comment longer than this is cut on the way out (GitLab notes allow far more). */
const COMMENT_MAX = 50_000

const parseObj = (v: unknown): Row => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Row
  if (typeof v !== 'string' || !v) return {}
  try {
    const p = JSON.parse(v)
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Row) : {}
  } catch {
    return {}
  }
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

/** The last line of a seen-again note; inbound.ts isOwnNote skips notes ending with it. */
export const seenMarker = (linkId: number) => `<!-- nivaro:seen:${Math.floor(linkId)} -->`

/** The last line of a comment Nivaro sent; inbound.ts isOwnNote skips notes ending with it. */
export const commentMarker = (commentId: string) => `<!-- nivaro:comment:${commentId} -->`

/** Composer mentions `@[Jane Doe]` (optionally `@[Jane Doe](id)`) become the plain name. */
export function plainMentions(text: string): string {
  return String(text ?? '').replace(/@\[([^\]\r\n]+)\](?:\([^)\r\n]*\))?/g, '$1')
}

/**
 * The GitLab note for a Nivaro comment: `**<author>** (Nivaro): <text>` then the comment marker
 * as the last line. Mentions are made plain first, then everything goes through the markdown
 * sanitiser (quick actions, remaining `@` pings, forged markers).
 */
export function outgoingCommentBody(author: string, text: string, commentId: string): string {
  const who = sanitizeMarkdown(String(author ?? '').trim() || 'Someone', { singleLine: true })
  const body = sanitizeMarkdown(plainMentions(String(text ?? '')).slice(0, COMMENT_MAX))
  return `**${who}** (Nivaro): ${body}\n\n${commentMarker(commentId)}`
}

/** Active, healthy connection, else null. */
async function usableConnection(id: number): Promise<TrackerConnection | null> {
  const conn = await getConnection(id)
  return conn?.is_active && conn.status === 'ok' ? conn : null
}

/** The member rows (one per connection) holding this source. */
async function membershipsOf(kind: MemberKind, sourceId: string): Promise<Row[]> {
  return (await db(MEMBERS)
    .where({ source_kind: kind, source_id: sourceId })
    .select('link', 'connection')) as Row[]
}

async function linkRow(linkId: number): Promise<Row | undefined> {
  return (await db(LINKS).where({ id: linkId }).first()) as Row | undefined
}

/** State changes and label swaps reach a person-written GitLab issue only with push_to_linked. */
const mayChange = (link: Row, conn: TrackerConnection) =>
  link.created_via !== 'linked' || conn.sync.push_to_linked === true

/** Each linked issue's (link, connection) — only on active, healthy connections. */
async function linkedTargets(
  issueId: number
): Promise<Array<{ link: Row; conn: TrackerConnection }>> {
  return linkedSourceTargets(SOURCE_ISSUE, String(issueId))
}

/**
 * A source's (link, connection) pairs — only on active, healthy connections that sync this kind
 * of source (a source switched off is left alone, nothing deleted).
 */
async function linkedSourceTargets(
  kind: MemberKind,
  sourceId: string
): Promise<Array<{ link: Row; conn: TrackerConnection }>> {
  const out: Array<{ link: Row; conn: TrackerConnection }> = []
  for (const m of await membershipsOf(kind, sourceId)) {
    const conn = await usableConnection(Number(m.connection))
    if (!conn || !sourceOn(conn, kind)) continue
    const link = await linkRow(Number(m.link))
    if (!link || Number(link.connection) !== conn.id) continue
    out.push({ link, conn })
  }
  return out
}

/** Is this the GitLab machine user (whose changes came FROM GitLab)? */
async function isMachineUser(userId: unknown): Promise<boolean> {
  if (!userId) return false
  const row = (await db('nivaro_users').where({ email: TRACKER_EMAIL }).first('id')) as
    | Row
    | undefined
  return !!row && String(row.id).toLowerCase() === String(userId).toLowerCase()
}

/** A pending or in-flight outbox row of this op on this link (newest first), if any. */
async function pendingOp(linkId: number, op: 'state' | 'labels' | 'note_seen') {
  return (await db(OUTBOX)
    .where({ link: linkId, op })
    .whereIn('status', ['pending', 'sending'])
    .orderBy('id', 'desc')
    .first('id', 'payload')) as Row | undefined
}

/** The GitLab state once queued changes land: the newest queued state op, else the mirror. */
async function effectiveState(link: Row): Promise<'opened' | 'closed'> {
  const queued = await pendingOp(Number(link.id), 'state')
  if (queued) return parseObj(queued.payload).state === 'reopen' ? 'opened' : 'closed'
  return link.remote_state === 'closed' ? 'closed' : 'opened'
}

async function enqueueState(
  link: Row,
  issueId: number | string,
  state: 'close' | 'reopen',
  key: string,
  kind: MemberKind = SOURCE_ISSUE
): Promise<number> {
  return enqueue({
    connection: Number(link.connection),
    link: Number(link.id),
    ...(kind === SOURCE_ISSUE ? {} : { source_kind: kind }),
    source_id: String(issueId),
    op: 'state',
    payload: { project_id: Number(link.project_id), iid: Number(link.external_iid), state },
    key
  })
}

/** A recurrence reopens a link at most once an hour (the engine's join path shares this key). */
const recurReopenKey = (linkId: number, now = new Date()) =>
  `state:${linkId}:reopen:${now.toISOString().slice(0, 13)}`

// ── Comments ──────────────────────────────────────────────────────────────────

/**
 * Send one Nivaro comment to every GitLab issue its issue is linked to (when the connection syncs
 * comments). Skips field comments, comments mirrored from GitLab and the machine user's. Never
 * throws.
 */
export async function queueCommentOut(commentId: string): Promise<void> {
  try {
    if (!(await trackersEnabled())) return
    const c = (await db('nivaro_comments').where({ id: commentId }).first()) as Row | undefined
    if (!c) return
    const source = commentSource(c)
    if (!source) return
    if (c.field != null && String(c.field) !== '') return
    if (parseObj(c.meta).tracker !== undefined) return
    if (await isMachineUser(c.user)) return

    const targets = (await linkedSourceTargets(source.kind, source.id)).filter(
      (t) => t.conn.sync.comments
    )
    if (!targets.length) return
    const author = await authorName(c.user)
    const body = outgoingCommentBody(author, String(c.text ?? ''), String(c.id))
    for (const { link } of targets) {
      await enqueue({
        connection: Number(link.connection),
        link: Number(link.id),
        ...(source.kind === SOURCE_ISSUE ? {} : { source_kind: source.kind }),
        source_id: source.id,
        op: 'comment',
        payload: { project_id: Number(link.project_id), iid: Number(link.external_iid), body },
        key: `comment:${Number(link.id)}:${String(c.id)}`
      })
    }
  } catch (err) {
    logOnce('sending a comment', err)
  }
}

/**
 * The source a comment's thread belongs to: `nivaro_issues` → the issue, `nivaro_tasks` → the
 * support ticket, a business collection → the record. Other system threads → null.
 */
function commentSource(c: Row): { kind: MemberKind; id: string } | null {
  const collection = String(c.collection ?? '')
  const item = String(c.item ?? '')
  if (!item) return null
  if (collection === 'nivaro_issues') {
    const n = Number(item)
    return Number.isSafeInteger(n) ? { kind: SOURCE_ISSUE, id: String(n) } : null
  }
  if (collection === 'nivaro_tasks') {
    const n = Number(item)
    return Number.isSafeInteger(n) && n > 0 ? { kind: 'ticket', id: String(n) } : null
  }
  const rec = parseRecordId(`${collection}:${item}`)
  return rec ? { kind: 'record', id: `${rec.collection}:${rec.item}` } : null
}

async function authorName(userId: unknown): Promise<string> {
  if (!userId) return 'Someone'
  const u = (await db('nivaro_users')
    .where({ id: String(userId) })
    .first('first_name', 'last_name', 'email')) as Row | undefined
  const name = [u?.first_name, u?.last_name]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ')
  if (name) return name
  const email = String(u?.email ?? '').trim()
  return email ? email.split('@')[0] : 'Someone'
}

/** Fire-and-forget on the background pool (the comment request never waits or fails on it). */
export function scheduleCommentOut(commentId: string): void {
  void runInBackgroundPool(() => queueCommentOut(commentId)).catch(() => {})
}

// ── Status ──────────────────────────────────────────────────────────────────

/**
 * A person changed an issue's status: close the GitLab issue when `close_on_resolve` and every
 * member of the link is resolved/closed; reopen it when the issue moved to open/in progress and
 * GitLab is closed. Each status write has its own key (`at` = when it was written), and the
 * effective GitLab state (queued op, else mirror) collapses duplicate pushes, so close → reopen →
 * close ends closed. Never sent for a change that came from GitLab.
 */
export async function queueStateOut(
  issueId: number,
  status: string,
  actor?: { userId?: string; via?: 'user' | 'gitlab' },
  at: number = Date.now()
): Promise<void> {
  try {
    if (actor?.via === 'gitlab') return
    if (!(await trackersEnabled())) return
    if (actor?.userId && (await isMachineUser(actor.userId))) return
    // the row must hold this status now (a bulk change lists ids the caller could not change)
    const issue = await loadIssue(issueId)
    if (!issue || String(issue.status ?? '') !== status) return
    for (const { link, conn } of await linkedTargets(issueId)) {
      if (!mayChange(link, conn)) continue
      const linkId = Number(link.id)
      if (CLOSED_STATUSES.has(status)) {
        if (!conn.sync.close_on_resolve) continue
        if ((await effectiveState(link)) === 'closed') continue
        const members = await memberRows(linkId)
        if (!members.length || !members.every((r) => CLOSED_STATUSES.has(String(r.status ?? ''))))
          continue
        // support tickets on the same GitLab issue must be done / cancelled too (when synced)
        if (sourceOn(conn, 'ticket') && !(await ticketMembersClosed(linkId))) continue
        await enqueueState(link, issueId, 'close', `state:${linkId}:close:${at}`)
      } else if (OPEN_STATUSES.has(status)) {
        if ((await effectiveState(link)) !== 'closed') continue
        await enqueueState(link, issueId, 'reopen', `state:${linkId}:reopen:${at}`)
      }
    }
  } catch (err) {
    logOnce('sending a status change', err)
  }
}

/** The issue rows of a link's members (a member whose row is gone is left out). */
async function memberRows(linkId: number): Promise<Row[]> {
  const ids = (
    (await db(MEMBERS)
      .where({ link: linkId, source_kind: SOURCE_ISSUE })
      .select('source_id')) as Row[]
  )
    .map((r) => Number(r.source_id))
    .filter((n) => Number.isSafeInteger(n))
  if (!ids.length) return []
  return selectInChunks(
    ids,
    500,
    async (chunk) =>
      (await whereInList(db('nivaro_issues'), 'id', chunk).select(
        'id',
        'status',
        'severity'
      )) as Row[]
  )
}

// ── Labels ────────────────────────────────────────────────────────────────────

const LANE_ORDER = ['in_progress', 'open', 'resolved', 'closed'] as const

/**
 * The lane a GitLab issue holding these members stands in: any in progress → in_progress, else any
 * open → open, else any resolved → resolved, else closed. Null with no members.
 */
export function linkLane(members: Array<{ status?: unknown }>): string | null {
  const have = new Set(members.map((m) => String(m.status ?? '')))
  return LANE_ORDER.find((l) => have.has(l)) ?? (members.length ? 'closed' : null)
}

/** The highest priority among the members (aliases normalised). Null with no members. */
export function linkPriority(members: Array<{ severity?: unknown }>): string | null {
  let best = -1
  for (const m of members)
    best = Math.max(best, SEVERITIES.indexOf(normalizePriority(String(m.severity ?? ''))))
  return best >= 0 ? SEVERITIES[best] : null
}

const sameSet = (a: unknown, b: string[]) => {
  const x = (Array.isArray(a) ? a.map(String) : []).map((l) => l.trim().toLowerCase()).sort()
  const y = b.map((l) => l.trim().toLowerCase()).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** The newest queued labels op on this link that touches one of these labels, if any. */
async function pendingLabelsFor(linkId: number, labels: string[]): Promise<Row | null> {
  const mine = new Set(labels.map((l) => l.trim().toLowerCase()))
  const rows = (await db(OUTBOX)
    .where({ link: linkId, op: 'labels' })
    .whereIn('status', ['pending', 'sending'])
    .orderBy('id', 'desc')
    .select('id', 'payload')) as Row[]
  for (const r of rows) {
    const p = parseObj(r.payload)
    const touched = [...strList(p.add_labels), ...strList(p.remove_labels)]
    if (touched.some((l) => mine.has(l.trim().toLowerCase()))) return { ...r, payload: p }
  }
  return null
}

/**
 * Swap the mapped priority or lane label on every GitLab issue this issue is linked to. The value
 * follows the LINK, not one member: lane = linkLane of all members, priority = the highest member
 * priority. `expected` (the value the caller wrote) must still be on the row — a bulk change lists
 * ids the caller could not change. Nothing is queued when the map has no label for the value (a
 * closed GitLab issue keeps its lane when 'resolved' is not mapped) or the label is not
 * label-safe, when the newest queued label change for this map already does exactly this, or —
 * nothing queued — when the mirror already shows the result.
 */
export async function queueLabelSwap(
  issueId: number,
  kind: 'priority' | 'lane',
  actor?: { userId?: string; via?: 'user' | 'gitlab' },
  expected?: string,
  at: number = Date.now()
): Promise<void> {
  try {
    if (actor?.via === 'gitlab') return
    if (!(await trackersEnabled())) return
    if (actor?.userId && (await isMachineUser(actor.userId))) return
    const issue = await loadIssue(issueId)
    if (!issue) return
    if (expected !== undefined) {
      const now = String((kind === 'priority' ? issue.severity : issue.status) ?? '')
      if (now !== expected) return
    }
    for (const { link, conn } of await linkedTargets(issueId)) {
      if (!mayChange(link, conn)) continue
      const map = (kind === 'priority' ? conn.sync.priority_map : conn.sync.lane_map) as Record<
        string,
        string | undefined
      >
      const members = await memberRows(Number(link.id))
      const value = kind === 'priority' ? linkPriority(members) : linkLane(members)
      await enqueueSwap(
        link,
        conn,
        map,
        value,
        { kind: SOURCE_ISSUE, id: String(issueId) },
        kind,
        at
      )
    }
  } catch (err) {
    logOnce('sending a label change', err)
  }
}

/**
 * Queue one label swap on a link: `value`'s label in, every other label of the map out. Nothing
 * when the map has no label for the value or it is not label-safe, when the newest queued label
 * change for this map already does exactly this, or (nothing queued) when the mirror already
 * shows the result. One key per change: `labels:<link>:<keyKind>:<at>:<value>`.
 */
async function enqueueSwap(
  link: Row,
  conn: TrackerConnection,
  map: Record<string, string | undefined>,
  value: string | null,
  source: { kind: MemberKind; id: string },
  keyKind: string,
  at: number
): Promise<void> {
  const linkId = Number(link.id)
  if (!value || !(Object.hasOwn(map, value) && String(map[value] ?? '').trim())) return
  const swap = labelSwap(map, value)
  const add = safeLabels(swap.add)
  // the new label did not survive the label-safe cleaning: send nothing (keep the old one)
  if (!add.length) return
  const remove = safeLabels(swap.remove)
  const queued = await pendingLabelsFor(linkId, [...add, ...remove])
  if (queued) {
    const p = queued.payload as Row
    if (sameSet(p.add_labels, add) && sameSet(p.remove_labels, remove)) return
  } else {
    const current = new Set(strList(link.remote_labels).map((l) => l.trim().toLowerCase()))
    const done =
      add.every((l) => current.has(l.toLowerCase())) &&
      !remove.some((l) => current.has(l.toLowerCase()))
    if (done) return
  }
  const payload: LabelsPayload = {
    project_id: Number(link.project_id),
    iid: Number(link.external_iid),
    add_labels: add,
    remove_labels: remove
  }
  await enqueue({
    connection: conn.id,
    link: linkId,
    ...(source.kind === SOURCE_ISSUE ? {} : { source_kind: source.kind }),
    source_id: source.id,
    op: 'labels',
    payload,
    // one key per change (members of one bulk write share it; the value keeps two changes
    // in the same millisecond apart); repeats collapse through the queued-op / mirror checks
    // above, so A → B → A ends at A
    key: `labels:${linkId}:${keyKind}:${at}:${value}`
  })
}

/**
 * issue-status.ts calls this after a write by a person (never by the GitLab side): a status
 * change sends close/reopen + the lane swap, a severity change the priority swap. `at` = when the
 * write happened (the state op's key). Runs on the background pool; never throws, never slows the
 * writer (the returned promise is for tests).
 */
export function afterIssueChange(
  issueIds: number[],
  patch: Record<string, unknown>,
  actor: { userId?: string; via?: 'user' | 'gitlab' },
  at: number = Date.now()
): Promise<void> {
  if (actor.via !== 'user') return Promise.resolve()
  const status = typeof patch.status === 'string' ? patch.status : null
  const severity = typeof patch.severity === 'string' ? patch.severity : null
  if (!status && !severity) return Promise.resolve()
  return runInBackgroundPool(async () => {
    if (!(await trackersEnabled())) return
    for (const id of issueIds) {
      if (status) {
        await queueStateOut(id, status, actor, at)
        await queueLabelSwap(id, 'lane', actor, status, at)
      }
      if (severity) await queueLabelSwap(id, 'priority', actor, severity, at)
    }
  })
    .then(() => {})
    .catch(() => {})
}

// ── Support tickets ───────────────────────────────────────────────────────────

const TICKET_DONE = new Set(['done', 'cancelled'])
const TICKET_OPEN = new Set(['open', 'in_progress'])
const TICKET_LANE_ORDER = ['in_progress', 'open', 'done'] as const
const TICKET_PRIORITY_ORDER = ['low', 'normal', 'urgent'] as const

/** The ticket rows of a link's ticket members (a member whose row is gone is left out). */
async function ticketMemberRows(linkId: number): Promise<Row[]> {
  const ids = (
    (await db(MEMBERS).where({ link: linkId, source_kind: 'ticket' }).select('source_id')) as Row[]
  )
    .map((r) => Number(r.source_id))
    .filter((n) => Number.isSafeInteger(n))
  if (!ids.length) return []
  return selectInChunks(
    ids,
    500,
    async (chunk) =>
      (await whereInList(db('nivaro_tasks'), 'id', chunk).select(
        'id',
        'status',
        'priority'
      )) as Row[]
  )
}

/** Every support ticket on the link is done or cancelled (none = true). */
async function ticketMembersClosed(linkId: number): Promise<boolean> {
  return (await ticketMemberRows(linkId)).every((r) => TICKET_DONE.has(String(r.status ?? '')))
}

/** Every issue on the link is resolved or closed (none = true). */
async function issueMembersClosed(linkId: number): Promise<boolean> {
  return (await memberRows(linkId)).every((r) => CLOSED_STATUSES.has(String(r.status ?? '')))
}

/** The ticket lane a link stands in: any in progress → in_progress, else open, else done. */
export function ticketLinkLane(members: Array<{ status?: unknown }>): string | null {
  const have = new Set(members.map((m) => ticketLane(String(m.status ?? ''))))
  return TICKET_LANE_ORDER.find((l) => have.has(l)) ?? null
}

/** The highest ticket priority on a link (urgent > normal > low). */
export function ticketLinkPriority(members: Array<{ priority?: unknown }>): string | null {
  let best = -1
  for (const m of members)
    best = Math.max(
      best,
      (TICKET_PRIORITY_ORDER as readonly string[]).indexOf(String(m.priority ?? ''))
    )
  return best >= 0 ? TICKET_PRIORITY_ORDER[best] : null
}

/**
 * A person changed a support ticket's status: done / cancelled closes the GitLab issue (when
 * `close_on_resolve` and every ticket and issue on the link is closed); open / in progress
 * reopens a closed one. Same keys, echo guard and person-written-issue rule as issues.
 */
export async function queueTicketStateOut(
  ticketId: number,
  status: string,
  actor?: { userId?: string; via?: 'user' | 'gitlab' },
  at: number = Date.now()
): Promise<void> {
  try {
    if (actor?.via === 'gitlab') return
    if (!(await trackersEnabled())) return
    if (actor?.userId && (await isMachineUser(actor.userId))) return
    const t = (await db('nivaro_tasks').where({ id: ticketId }).first('id', 'status')) as
      | Row
      | undefined
    if (!t || String(t.status ?? '') !== status) return
    for (const { link, conn } of await linkedSourceTargets('ticket', String(ticketId))) {
      if (!mayChange(link, conn)) continue
      const linkId = Number(link.id)
      if (TICKET_DONE.has(status)) {
        if (!conn.sync.close_on_resolve) continue
        if ((await effectiveState(link)) === 'closed') continue
        if (!(await ticketMembersClosed(linkId))) continue
        // issues on the link count only while the issue log syncs on this connection
        if (sourceOn(conn, SOURCE_ISSUE) && !(await issueMembersClosed(linkId))) continue
        await enqueueState(link, ticketId, 'close', `state:${linkId}:close:${at}`, 'ticket')
      } else if (TICKET_OPEN.has(status)) {
        if ((await effectiveState(link)) !== 'closed') continue
        await enqueueState(link, ticketId, 'reopen', `state:${linkId}:reopen:${at}`, 'ticket')
      }
    }
  } catch (err) {
    logOnce('sending a support request status change', err)
  }
}

/** The ticket priority / lane label swap on every GitLab issue the ticket is linked to. */
export async function queueTicketLabelSwap(
  ticketId: number,
  kind: 'priority' | 'lane',
  actor?: { userId?: string; via?: 'user' | 'gitlab' },
  expected?: string,
  at: number = Date.now()
): Promise<void> {
  try {
    if (actor?.via === 'gitlab') return
    if (!(await trackersEnabled())) return
    if (actor?.userId && (await isMachineUser(actor.userId))) return
    const t = (await db('nivaro_tasks')
      .where({ id: ticketId })
      .first('id', 'status', 'priority')) as Row | undefined
    if (!t) return
    if (expected !== undefined) {
      const now = String((kind === 'priority' ? t.priority : t.status) ?? '')
      if (now !== expected) return
    }
    for (const { link, conn } of await linkedSourceTargets('ticket', String(ticketId))) {
      if (!mayChange(link, conn)) continue
      const map = (
        kind === 'priority' ? conn.sync.ticket_priority_map : conn.sync.ticket_lane_map
      ) as Record<string, string | undefined> | undefined
      if (!map) continue
      const members = await ticketMemberRows(Number(link.id))
      const value = kind === 'priority' ? ticketLinkPriority(members) : ticketLinkLane(members)
      await enqueueSwap(
        link,
        conn,
        map,
        value,
        { kind: 'ticket', id: String(ticketId) },
        `ticket-${kind}`,
        at
      )
    }
  } catch (err) {
    logOnce('sending a support request label change', err)
  }
}

/**
 * The support routes call this after a person changes a ticket (never the GitLab side): a status
 * change sends close/reopen + the lane swap, a priority change the priority swap. Background
 * pool; never throws, never slows the writer (the returned promise is for tests).
 */
export function afterTicketChange(
  ticketId: number,
  patch: Record<string, unknown>,
  actor: { userId?: string; via?: 'user' | 'gitlab' },
  at: number = Date.now()
): Promise<void> {
  if (actor.via !== 'user') return Promise.resolve()
  const status = typeof patch.status === 'string' ? patch.status : null
  const priority = typeof patch.priority === 'string' ? patch.priority : null
  if (!status && !priority) return Promise.resolve()
  return runInBackgroundPool(async () => {
    if (!(await trackersEnabled())) return
    if (status) {
      await queueTicketStateOut(ticketId, status, actor, at)
      await queueTicketLabelSwap(ticketId, 'lane', actor, status, at)
    }
    if (priority) await queueTicketLabelSwap(ticketId, 'priority', actor, priority, at)
  })
    .then(() => {})
    .catch(() => {})
}

// ── Seen again ────────────────────────────────────────────────────────────────

/** The seen-again note: count, people (24 h), last route, build; seen marker last. */
export function seenNoteBody(
  linkId: number,
  vars: {
    issue_id: number
    total_hits: number
    hits_24h: number
    people_24h: number
    route?: string | null
    build?: string | null
    nivaro_url?: string | null
  }
): string {
  const n = (v: unknown) => {
    const x = Number(v)
    return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0
  }
  const one = (v: unknown) => sanitizeMarkdown(String(v ?? ''), { singleLine: true })
  const lines = [
    // never `#<n>`: GitLab would link issue <n> of its own project
    `**Seen again** — Nivaro issue ${n(vars.issue_id)}`,
    '',
    `${n(vars.total_hits)} times in all; ${n(vars.hits_24h)} in the last 24 hours by ${n(vars.people_24h)} people.`
  ]
  // sanitised as the whole line: a route starting with '/' is not at the line start
  if (String(vars.route ?? '').trim()) lines.push(one(`Last route: ${vars.route}`))
  if (String(vars.build ?? '').trim()) lines.push(one(`Build: ${vars.build}`))
  const url = one(vars.nivaro_url)
  if (url) lines.push('', `[Open in Nivaro](${url})`)
  lines.push('', seenMarker(linkId))
  return lines.join('\n')
}

const asDate = (v: unknown): Date | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Queue one seen-again note on this link when `seen_note` is on and none was sent (or is queued)
 * within `seen_note_min_minutes`. Returns whether a note was queued.
 */
export async function queueSeenNote(
  link: Row,
  conn: TrackerConnection,
  issueId: number,
  now = new Date()
): Promise<boolean> {
  if (!conn.sync.seen_note) return false
  const linkId = Number(link.id)
  const windowMs = Math.max(1, conn.sync.seen_note_min_minutes) * 60_000
  const last = asDate(link.last_seen_note_at)
  if (last && now.getTime() - last.getTime() < conn.sync.seen_note_min_minutes * 60_000)
    return false
  if (await pendingOp(linkId, 'note_seen')) return false
  const issue = await loadIssueLite(issueId)
  if (!issue) return false
  const vars = await issueVars(issue, false)
  const body = seenNoteBody(linkId, {
    issue_id: issueId,
    total_hits: Number(vars.total_hits) || 0,
    hits_24h: Number(vars.hits_24h) || 0,
    people_24h: Number(vars.people_24h) || 0,
    route: vars.route ? String(vars.route) : null,
    build: vars.build ? String(vars.build) : null,
    nivaro_url: vars.nivaro_url ? String(vars.nivaro_url) : null
  })
  await enqueue({
    connection: conn.id,
    link: linkId,
    source_id: String(issueId),
    op: 'note_seen',
    payload: { project_id: Number(link.project_id), iid: Number(link.external_iid), body },
    // one note per previous note per window: concurrent recurrences share the key, a dead
    // row blocks its window only
    key: `seen:${linkId}:${last ? last.getTime() : 0}:${Math.floor(now.getTime() / windowMs)}`
  })
  return true
}

// ── Recurrence ────────────────────────────────────────────────────────────────

/**
 * An issue was raised or recurred (subscribed from crons.ts AFTER the rule engine has looked at
 * it, so a join the engine made is seen here as an existing member):
 *  - a member issue that recurred → the throttled seen-again note; on a CLOSED GitLab issue,
 *    `recur_when_closed: 'reopen'` with `reopen_on_recur` reopens it first;
 *  - a NEW issue (kind 'raised') whose fingerprint matches a link → joins it as an example
 *    (fingerprint), and reopens it when closed and set to; `recur_when_closed: 'new'` on a closed
 *    link is left to the rules (a join here would block their create).
 * Idempotent through the outbox keys. Never throws.
 */
export async function onRecurrence(
  issueId: number,
  kind: 'raised' | 'recurred' = 'recurred'
): Promise<void> {
  try {
    if (!(await trackersEnabled())) return
    const issue = await loadIssueLite(issueId)
    if (!issue || issue.source === 'tracker') return
    for (const conn of await listConnections()) {
      if (!conn.is_active || conn.status !== 'ok' || !sourceOn(conn, SOURCE_ISSUE)) continue
      try {
        await recurOn(conn, issue, kind)
      } catch (err) {
        logOnce('handling a recurrence', err)
      }
    }
  } catch (err) {
    logOnce('handling a recurrence', err)
  }
}

async function recurOn(
  conn: TrackerConnection,
  issue: Row,
  kind: 'raised' | 'recurred'
): Promise<void> {
  const issueId = Number(issue.id)
  const member = await memberFor(conn.id, issueId)
  if (member) {
    // a raised member was joined just now (engine): its example note says it all; so does a
    // member the engine joined on this very write
    if (kind !== 'recurred') return
    const joined = asDate(member.joined_at)
    if (joined && Date.now() - joined.getTime() < JUST_JOINED_MS) return
    const link = await linkRow(Number(member.link))
    if (!link) return
    let open = (await effectiveState(link)) !== 'closed'
    if (!open && reopensOnRecur(conn) && mayChange(link, conn)) {
      await enqueueState(link, issueId, 'reopen', recurReopenKey(Number(link.id)))
      open = true
    }
    if (open) await queueSeenNote(link, conn, issueId)
    return
  }

  if (kind !== 'raised') return
  const fp = issue.fingerprint ? String(issue.fingerprint) : ''
  if (!fp) return
  // A create for this issue still in the outbox — DEAD included — blocks the fingerprint join
  // until an admin retries or discards it (Outbox screen): the create links it when sent.
  if (await createQueued(conn.id, issueId)) return
  const linkId = await fingerprintLink(conn.id, issueId, fp)
  if (linkId === null) return
  const link = await linkRow(linkId)
  if (!link) return
  const closed = (await effectiveState(link)) === 'closed'
  if (closed && conn.sync.recur_when_closed === 'new') return
  await joinAsExample(issueId, conn.id, { link_id: linkId }, 'fingerprint')
  if (closed && reopensOnRecur(conn) && mayChange(link, conn))
    await enqueueState(link, issueId, 'reopen', recurReopenKey(linkId))
}

const reopensOnRecur = (conn: TrackerConnection) =>
  conn.sync.recur_when_closed === 'reopen' && conn.sync.reopen_on_recur

/** A create for this issue on this connection still in the outbox (it will link on send). */
async function createQueued(connection: number, issueId: number): Promise<boolean> {
  // a ticket create with the same number is not this issue's (source_kind; older rows: issue)
  const rows = (await db(OUTBOX)
    .where({ connection, op: 'create', source_id: String(issueId) })
    .whereIn('status', ['pending', 'sending', 'dead'])
    .select('id', 'source_kind')) as Row[]
  return rows.some((r) => r.source_kind == null || r.source_kind === SOURCE_ISSUE)
}

// ── Logging ───────────────────────────────────────────────────────────────────

const LOG_EVERY_MS = 10 * 60_000
let lastLogAt = 0

/** At most one console line per 10 minutes per process — never the issue log (it would loop). */
function logOnce(what: string, err: unknown): void {
  const now = Date.now()
  if (lastLogAt && now - lastLogAt < LOG_EVERY_MS) return
  lastLogAt = now
  // biome-ignore lint/suspicious/noConsole: a failing outbound sync must show in the server log
  console.warn(
    `[trackers] outbound sync: ${what} failed: ${err instanceof Error ? err.message : String(err)}`.slice(
      0,
      500
    )
  )
}

/** Tests: log the next failure at once. */
export function resetOutboundLog(): void {
  lastLogAt = 0
}

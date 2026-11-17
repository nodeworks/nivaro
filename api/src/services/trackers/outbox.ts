import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { noteIssueWrite } from '../issue-raise.js'
import { getConnection, markBroken, markOk, providerFor } from './connections.js'
import { decodeDataUri, insertBeforeMarker, issueMarker } from './issue-body.js'
import { addMember, LINKS, projectPathFrom, upsertLinkFromRemote } from './link-store.js'
import {
  type CreateIssueInput,
  type RemoteIssue,
  TrackerError,
  type TrackerProvider
} from './types.js'

/**
 * The durable outbox: every write to GitLab is a row here first, then attempted at once; the
 * `tracker-outbox` worker drains what is left. Retries back off 30 s → 1 h; after 10 attempts,
 * or at once for a refusal GitLab will repeat (invalid / not found), the row goes `dead` and the
 * first dead row per connection per UTC day raises one warning issue. An auth failure marks the
 * connection broken and holds the row for an hour without spending an attempt.
 *
 * A create is idempotent: its description carries `<!-- nivaro:issue:<id> -->` and every attempt
 * first searches the project for that marker, so a create that timed out after GitLab stored it
 * links the existing issue instead of opening a second one.
 */

export const OUTBOX = 'nivaro_tracker_outbox'
export type OutboxOp = 'create' | 'comment' | 'state' | 'note_seen' | 'upload'
export type OutboxStatus = 'pending' | 'sending' | 'done' | 'dead'

export const MAX_ATTEMPTS = 10
const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 3_600_000
const AUTH_HOLD_MS = 3_600_000
/** A claimed row is leased this long; a sender that crashed leaves it to be claimed again. */
const LEASE_MS = 10 * 60_000
const DEFAULT_BATCH = 20

/** Create payload: the rendered input plus what is done around the create. */
export interface CreatePayload {
  project_id: number
  issue: number
  input: CreateIssueInput
  attach_screenshot?: boolean
  map_assignee_email?: string | null
  assign_nivaro_to?: string | null
  created_via: 'manual' | 'rule'
  rule_id?: number | null
  created_by?: string | null
}

type Row = Record<string, unknown>

export function backoffMs(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts))
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.min(n, 30), MAX_BACKOFF_MS)
}

let autoSend = true
/** Tests turn off the immediate attempt after enqueue. */
export function setAutoSend(on: boolean): void {
  autoSend = on
}

const parse = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v !== 'string' || !v) return {}
  try {
    const p = JSON.parse(v)
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const idOf = (inserted: unknown[]): number => {
  const first = inserted[0]
  return Number(typeof first === 'object' && first !== null ? (first as { id: unknown }).id : first)
}

/** Queue one write. Idempotent on `key`: the same key answers the existing row's id. */
export async function enqueue(
  row: {
    connection: number
    link?: number | null
    source_id: string
    op: OutboxOp
    payload: unknown
    key: string
  },
  opts: { send?: boolean } = {}
): Promise<number> {
  const key = row.key.slice(0, 200)
  const existing = (await db(OUTBOX).where({ idempotency_key: key }).first('id')) as Row | undefined
  if (existing) return Number(existing.id)
  let id: number
  try {
    id = idOf(
      (await db(OUTBOX)
        .insert({
          connection: row.connection,
          link: row.link ?? null,
          source_kind: 'issue',
          source_id: String(row.source_id).slice(0, 100),
          op: row.op,
          payload: JSON.stringify(row.payload ?? null),
          idempotency_key: key,
          status: 'pending',
          attempts: 0,
          next_attempt_at: new Date(),
          created_at: new Date()
        })
        .returning('id')) as unknown[]
    )
  } catch (err) {
    const raced = (await db(OUTBOX).where({ idempotency_key: key }).first('id')) as Row | undefined
    if (raced) return Number(raced.id)
    throw err
  }
  if (opts.send !== false) kick(id)
  return id
}

/** Attempt one row now, in the background; never throws to the caller. */
export function kick(id: number): void {
  if (!autoSend) return
  // Started from a request (bulk fires up to 50): run on the background pool, not the request one.
  void runInBackgroundPool(() => sendOne(id)).catch(() => {})
}

/** Claim one pending row by id and send it. */
export async function sendOne(id: number): Promise<'sent' | 'failed' | 'dead' | 'skipped'> {
  const now = new Date()
  const claimed = await db(OUTBOX)
    .where({ id, status: 'pending' })
    .where('next_attempt_at', '<=', now)
    .update({ status: 'sending', next_attempt_at: new Date(now.getTime() + LEASE_MS) })
  if (!claimed) return 'skipped'
  const row = (await db(OUTBOX).where({ id }).first()) as Row | undefined
  if (!row) return 'skipped'
  return sendRow(row)
}

/** Rows whose sender died mid-send (lease ran out) go back to pending. */
async function recoverStale(now: Date): Promise<void> {
  await db(OUTBOX)
    .where({ status: 'sending' })
    .where('next_attempt_at', '<=', now)
    .update({ status: 'pending', next_attempt_at: now })
}

async function claim(limit: number, now: Date): Promise<Row[]> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)))
  const lease = new Date(now.getTime() + LEASE_MS)
  if (isMssql(db)) {
    const res = (await db.raw(
      `UPDATE TOP (${n}) ${OUTBOX} WITH (ROWLOCK, READPAST)
         SET status = 'sending', next_attempt_at = ?
       OUTPUT inserted.*
       WHERE status = 'pending' AND next_attempt_at <= ?`,
      [lease, now]
    )) as unknown
    return Array.isArray(res) ? (res as Row[]) : []
  }
  // Other dialects: pick, then claim each row by a guarded update.
  const picked = (await db(OUTBOX)
    .where({ status: 'pending' })
    .where('next_attempt_at', '<=', now)
    .orderBy('id')
    .limit(n)
    .select('id')) as Row[]
  const out: Row[] = []
  for (const p of picked) {
    const ok = await db(OUTBOX)
      .where({ id: p.id, status: 'pending' })
      .update({ status: 'sending', next_attempt_at: lease })
    if (ok) {
      const row = (await db(OUTBOX).where({ id: p.id }).first()) as Row | undefined
      if (row) out.push(row)
    }
  }
  return out
}

/** Drain due rows. The worker calls this every 30 s; callers never see a throw per row. */
export async function processOutbox(
  limit = DEFAULT_BATCH
): Promise<{ sent: number; failed: number; dead: number }> {
  const now = new Date()
  await recoverStale(now)
  const rows = await claim(limit, now)
  const tally = { sent: 0, failed: 0, dead: 0 }
  for (const row of rows) {
    const r = await sendRow(row)
    if (r === 'sent') tally.sent++
    else if (r === 'dead') tally.dead++
    else tally.failed++
  }
  return tally
}

async function sendRow(row: Row): Promise<'sent' | 'failed' | 'dead'> {
  const id = Number(row.id)
  const connection = Number(row.connection)
  try {
    const provider = await providerFor(connection)
    const payload = parse(row.payload)
    const op = String(row.op) as OutboxOp
    let link: number | null = row.link == null ? null : Number(row.link)
    if (op === 'create') link = await sendCreate(row, payload as unknown as CreatePayload, provider)
    else if (op === 'comment' || op === 'note_seen') {
      const { project_id, iid } = await target(payload, link)
      // Sent exactly as stored: whoever enqueues a comment / note_seen body must sanitise it
      // first (sanitizeMarkdown in templates.ts — quick actions, mentions, forged markers).
      await provider.addNote(project_id, iid, String(payload.body ?? ''))
      if (op === 'note_seen' && link != null)
        await db(LINKS).where({ id: link }).update({ last_seen_note_at: new Date() })
    } else if (op === 'state') {
      const { project_id, iid } = await target(payload, link)
      const state = payload.state === 'reopen' ? 'reopen' : 'close'
      const remote = await provider.setState(project_id, iid, state)
      if (link != null)
        await db(LINKS)
          .where({ id: link })
          .update({ remote_state: remote.state, last_synced_at: new Date() })
    } else {
      throw new TrackerError(`Nivaro does not send "${op}" changes`, null, 'invalid')
    }
    await db(OUTBOX)
      .where({ id })
      .update({ status: 'done', done_at: new Date(), last_error: null, link })
    await markOk(connection).catch(() => {})
    return 'sent'
  } catch (err) {
    return failRow(row, err)
  }
}

async function target(
  payload: Record<string, unknown>,
  link: number | null
): Promise<{ project_id: number; iid: number }> {
  let project_id = Number(payload.project_id)
  let iid = Number(payload.iid)
  if ((!project_id || !iid) && link != null) {
    const l = (await db(LINKS).where({ id: link }).first('project_id', 'external_iid')) as
      | Row
      | undefined
    if (l) {
      project_id = Number(l.project_id)
      iid = Number(l.external_iid)
    }
  }
  if (!project_id || !iid)
    throw new TrackerError('This change does not name a GitLab issue', null, 'invalid')
  return { project_id, iid }
}

/** Create (or find by marker) the GitLab issue, then link it. Returns the link id. */
async function sendCreate(
  row: Row,
  payload: CreatePayload,
  provider: TrackerProvider
): Promise<number> {
  const connection = Number(row.connection)
  const issueId = Number(payload.issue ?? row.source_id)
  const projectId = Number(payload.project_id)
  if (!projectId || !payload.input?.title)
    throw new TrackerError('The queued create has no project or title', null, 'invalid')

  let remote: RemoteIssue | null = await provider.findIssueByMarker(projectId, issueMarker(issueId))
  if (!remote) {
    const prepared = await prepareInput(row, payload, provider, issueId)
    remote = await provider.createIssue(projectId, prepared)
  }

  const conn = await getConnection(connection)
  const issue = (await db('nivaro_issues').where({ id: issueId }).first('id', 'fingerprint')) as
    | Row
    | undefined
  const linkId = await upsertLinkFromRemote(connection, remote, {
    project_path: projectPathFrom(remote.web_url, conn?.base_url ?? ''),
    created_via: payload.created_via === 'rule' ? 'rule' : 'manual',
    rule_id: payload.rule_id ?? null,
    fingerprint: (issue?.fingerprint as string | null) ?? null,
    created_by: payload.created_by ?? null
  })
  await addMember(linkId, connection, issueId, 'lead')
  if (payload.assign_nivaro_to && issue) await assignNivaroIssue(issueId, payload.assign_nivaro_to)
  return linkId
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function assignNivaroIssue(issueId: number, userId: string): Promise<void> {
  if (!UUID.test(userId)) return
  try {
    await db('nivaro_issues')
      .where({ id: issueId })
      .update({ assigned_to: userId, updated_at: new Date() })
    noteIssueWrite(issueId, 'changed')
  } catch {
    // the GitLab issue exists and is linked; a failed local assignment must not resend it
  }
}

/**
 * Screenshot upload and assignee mapping happen once, just before the first create attempt;
 * the result is written back to the row so a retry sends exactly the same input.
 */
async function prepareInput(
  row: Row,
  payload: CreatePayload,
  provider: TrackerProvider,
  issueId: number
): Promise<CreateIssueInput> {
  const input: CreateIssueInput = { ...payload.input }
  let changed = false
  if (payload.attach_screenshot) {
    const issue = (await db('nivaro_issues').where({ id: issueId }).first('screenshot')) as
      | Row
      | undefined
    const file = decodeDataUri(issue?.screenshot)
    if (file) {
      try {
        const up = await provider.upload(payload.project_id, file)
        input.description = insertBeforeMarker(input.description, `### Screenshot\n${up.markdown}`)
      } catch (err) {
        if (err instanceof TrackerError && err.kind === 'auth') throw err
        input.description = insertBeforeMarker(
          input.description,
          '_Screenshot could not be attached._'
        )
      }
    }
    changed = true
  }
  if (payload.map_assignee_email && !input.assignee_ids?.length) {
    try {
      const users = await provider.searchUsers(payload.map_assignee_email, payload.project_id)
      if (users.length === 1) input.assignee_ids = [users[0].id]
    } catch (err) {
      if (err instanceof TrackerError && err.kind === 'auth') throw err
      // no match: create unassigned
    }
    changed = true
  }
  if (changed) {
    const next: CreatePayload = {
      ...payload,
      input,
      attach_screenshot: false,
      map_assignee_email: null
    }
    await db(OUTBOX)
      .where({ id: row.id })
      .update({ payload: JSON.stringify(next) })
  }
  return input
}

const short = (err: unknown) =>
  (err instanceof Error ? err.message : String(err ?? 'Unknown error')).slice(0, 1000)

async function failRow(row: Row, err: unknown): Promise<'failed' | 'dead'> {
  const id = Number(row.id)
  const connection = Number(row.connection)
  const message = short(err)
  const now = Date.now()
  const kind = err instanceof TrackerError ? err.kind : 'server'

  if (kind === 'auth') {
    await markBroken(connection, message).catch(() => {})
    await db(OUTBOX)
      .where({ id })
      .update({
        status: 'pending',
        next_attempt_at: new Date(now + AUTH_HOLD_MS),
        last_error: message
      })
    return 'failed'
  }

  const attempts = (Number(row.attempts) || 0) + 1
  if (kind === 'invalid' || kind === 'not_found' || attempts >= MAX_ATTEMPTS) {
    await db(OUTBOX)
      .where({ id })
      .update({ status: 'dead', attempts, last_error: message, done_at: new Date(now) })
    await raiseDeadWarning(connection, message).catch(() => {})
    return 'dead'
  }
  await db(OUTBOX)
    .where({ id })
    .update({
      status: 'pending',
      attempts,
      next_attempt_at: new Date(now + backoffMs(attempts - 1)),
      last_error: message
    })
  return 'failed'
}

const DEAD_TITLE = 'GitLab sync: a change could not be sent'

/** One warning issue per connection per UTC day, the first time a row goes dead. */
async function raiseDeadWarning(connection: number, reason: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10)
  const fingerprint = `tracker-dead:${connection}:${day}`
  const seen = await db('nivaro_issues').where({ fingerprint }).first('id')
  if (seen) return
  const conn = await getConnection(connection).catch(() => null)
  const now = new Date()
  const inserted = (await db('nivaro_issues')
    .insert({
      title: DEAD_TITLE,
      severity: 'warning',
      status: 'open',
      source: 'tracker',
      details:
        `A change for GitLab connection "${conn?.name ?? connection}" was given up on: ${reason}\n\n` +
        'Open Settings → GitLab sync → Outbox to retry or discard it.',
      fingerprint,
      occurrence_count: 1,
      last_seen_at: now,
      created_at: now,
      updated_at: now
    })
    .returning('id')) as unknown[]
  noteIssueWrite(idOf(inserted), 'raised', { fingerprint })
}

export interface OutboxView {
  id: number
  connection: number
  link: number | null
  source_kind: string
  source_id: string
  op: string
  status: string
  attempts: number
  next_attempt_at: string | null
  last_error: string | null
  created_at: string | null
  done_at: string | null
}

const iso = (v: unknown): string | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export async function listOutbox(
  filter: { status?: string; connection?: number } = {},
  limit = 200
): Promise<OutboxView[]> {
  let q = db(OUTBOX)
  if (filter.status) q = q.where({ status: filter.status })
  if (filter.connection) q = q.where({ connection: filter.connection })
  const rows = (await q
    .orderBy('id', 'desc')
    .limit(Math.max(1, Math.min(500, limit)))
    .select(
      'id',
      'connection',
      'link',
      'source_kind',
      'source_id',
      'op',
      'status',
      'attempts',
      'next_attempt_at',
      'last_error',
      'created_at',
      'done_at'
    )) as Row[]
  return rows.map((r) => ({
    id: Number(r.id),
    connection: Number(r.connection),
    link: r.link == null ? null : Number(r.link),
    source_kind: String(r.source_kind),
    source_id: String(r.source_id),
    op: String(r.op),
    status: String(r.status),
    attempts: Number(r.attempts) || 0,
    next_attempt_at: iso(r.next_attempt_at),
    last_error: r.last_error == null ? null : String(r.last_error),
    created_at: iso(r.created_at),
    done_at: iso(r.done_at)
  }))
}

/** A dead (or waiting) row back to the front of the queue with a fresh attempt budget. */
export async function retryOutbox(id: number): Promise<'ok' | 'missing' | 'busy'> {
  const row = (await db(OUTBOX).where({ id }).first('id', 'status')) as Row | undefined
  if (!row) return 'missing'
  if (row.status !== 'dead' && row.status !== 'pending') return 'busy'
  await db(OUTBOX).where({ id }).whereIn('status', ['dead', 'pending']).update({
    status: 'pending',
    attempts: 0,
    next_attempt_at: new Date(),
    last_error: null,
    done_at: null
  })
  kick(id)
  return 'ok'
}

/** Drop a row that will not be sent. A row being sent right now is left alone. */
export async function discardOutbox(id: number): Promise<'ok' | 'missing' | 'busy'> {
  const row = (await db(OUTBOX).where({ id }).first('id', 'status')) as Row | undefined
  if (!row) return 'missing'
  if (row.status === 'sending') return 'busy'
  await db(OUTBOX).where({ id }).whereNot({ status: 'sending' }).delete()
  return 'ok'
}

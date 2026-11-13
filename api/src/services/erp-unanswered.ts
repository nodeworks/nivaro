import { db } from '../db/index.js'

/**
 * Partner sends that never got an answer.
 *
 * A transition's erp_submit push writes its nivaro_erp_submissions row BEFORE
 * the partner call, with status `sending` (workflow-actions.ts beginSubmission),
 * and finishes that same row when the answer comes (finishSubmission). A row
 * still `sending` after the call's own timeout means the process stopped (a
 * deploy drain, a crash, a lost lease) or the finishing write failed while the
 * request may already have reached the partner. The partner may have made the
 * order; this app does not know.
 *
 * Such a row holds the next send of the same push on that record (the guard in
 * runTransitionActions) until an administrator checks the partner and marks it
 * received or not received (POST /api/erp-submissions/:id/resolve-unanswered).
 * Nothing here sends anything.
 */

export const SENDING_STATUS = 'sending'

/** The default and the ceiling of an erp_submit action's partner-call timeout. */
export const DEFAULT_SEND_TIMEOUT_MS = 120_000
export const MAX_SEND_TIMEOUT_MS = 10 * 60_000
const MIN_SEND_TIMEOUT_MS = 5_000
/** The partner-call timeout of a resend of a stored request (routes/erp-submissions sendPayload). */
export const RESEND_TIMEOUT_MS = 30_000
/** How long past its timeout a call may still be finishing its own row. */
export const ANSWER_MARGIN_MS = 60_000

/** Where an administrator marks an unanswered send, in the words the refusals use. */
export const RESOLVE_PLACE = 'Integrations, ERP submissions'

/** The partner-call timeout of an erp_submit action (`timeout_ms` on the action wins). */
export function erpActionTimeoutMs(action: { timeout_ms?: unknown } | null | undefined): number {
  return Math.min(
    MAX_SEND_TIMEOUT_MS,
    Math.max(MIN_SEND_TIMEOUT_MS, Number(action?.timeout_ms) || DEFAULT_SEND_TIMEOUT_MS)
  )
}

/** When a send started at `startedAt` with this timeout stops reading as in flight. */
export function answerByFor(startedAt: Date, timeoutMs: number): Date {
  return new Date(startedAt.getTime() + timeoutMs + ANSWER_MARGIN_MS)
}

const time = (v: Date | string | null | undefined): number => {
  if (v == null) return Number.NaN
  return (v instanceof Date ? v : new Date(v)).getTime()
}

/**
 * The moment a `sending` row stops reading as in flight: the `answer_by` stored
 * with its request, else its start plus the longest timeout any push may have
 * (a row from before answer_by was stored never reads stale too early).
 */
export function answerDeadline(row: {
  created_at: Date | string
  payload?: string | null
}): number {
  try {
    const stored = row.payload ? (JSON.parse(row.payload) as { answer_by?: unknown }) : null
    const at = typeof stored?.answer_by === 'string' ? time(stored.answer_by) : Number.NaN
    if (Number.isFinite(at)) return at
  } catch {
    /* fall through to the ceiling */
  }
  return time(row.created_at) + MAX_SEND_TIMEOUT_MS + ANSWER_MARGIN_MS
}

/** Whether a `sending` row is past the time its own call could still answer. */
export function isUnansweredStale(
  row: { created_at: Date | string; payload?: string | null },
  now = Date.now()
): boolean {
  return now > answerDeadline(row)
}

/** What a `sending` row reads as for people. */
export function sendingLabel(stale: boolean): string {
  return stale ? 'No answer — may have been received' : 'Sending…'
}

export interface UnansweredSend {
  id: number
  started_at: string
  stale: boolean
  api_id: number
  api_name: string | null
  endpoint_path: string | null
}

interface SendingRow {
  id: number
  external_api: number
  created_at: Date | string
  payload: string | null
  api_name?: string | null
}

function endpointOf(payload: string | null): string | null {
  try {
    const p = payload ? (JSON.parse(payload) as { endpoint_path?: unknown }) : null
    return typeof p?.endpoint_path === 'string' ? p.endpoint_path : null
  } catch {
    return null
  }
}

function toUnanswered(row: SendingRow, now: number): UnansweredSend {
  const started = new Date(row.created_at)
  return {
    id: Number(row.id),
    started_at: Number.isNaN(started.getTime())
      ? new Date(now).toISOString()
      : started.toISOString(),
    stale: isUnansweredStale(row, now),
    api_id: Number(row.external_api),
    api_name: row.api_name ?? null,
    endpoint_path: endpointOf(row.payload)
  }
}

async function sendingRows(
  collection: string,
  item: string,
  apiId?: number
): Promise<SendingRow[]> {
  let q = db('nivaro_erp_submissions as s')
    .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
    .where({ 's.collection': collection, 's.item': String(item), 's.status': SENDING_STATUS })
  if (apiId != null) q = q.where('s.external_api', apiId)
  return (await q
    .orderBy('s.id', 'desc')
    .limit(20)
    .select(
      's.id',
      's.external_api',
      's.created_at',
      's.payload',
      'a.name as api_name'
    )) as SendingRow[]
}

/** A stored request with `answer_by` set: when a send of it started now stops reading in flight. */
export function payloadWithAnswerBy(payload: string | null, answerBy: Date): string | null {
  if (payload == null) return payload
  try {
    const p = JSON.parse(payload) as Record<string, unknown>
    if (!p || typeof p !== 'object' || Array.isArray(p)) return payload
    return JSON.stringify({ ...p, answer_by: answerBy.toISOString() })
  } catch {
    return payload
  }
}

/** A resend refused because an earlier send of the same push has no answer (or could not be
 *  checked). `message` is the sentence for the person. */
export class UnansweredSendError extends Error {
  readonly code = 'UNANSWERED'
  constructor(message: string) {
    super(message)
    this.name = 'UnansweredSendError'
  }
}

/** The earlier sends could not be read: whether one is unanswered is not known. */
export class UnansweredCheckError extends Error {
  constructor(cause: unknown) {
    super(`could not read earlier sends: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'UnansweredCheckError'
  }
}

interface SendKey {
  collection: string
  item: string
  apiId: number
  endpointPath: string
  /** Rows the caller began itself (a run's own unfinished row never holds it). */
  ignoreIds?: ReadonlySet<number>
  now?: number
}

/**
 * The newest unanswered send of THIS push (same API, same endpoint) on a record,
 * other than `ignoreIds`. Null = nothing holds the send. Throws
 * UnansweredCheckError when the table cannot be read: the caller decides whether
 * not knowing means wait (a blocking order, a person's resend) or go on.
 */
export async function findUnansweredSendStrict(opts: SendKey): Promise<UnansweredSend | null> {
  const now = opts.now ?? Date.now()
  let rows: SendingRow[]
  try {
    rows = await sendingRows(opts.collection, opts.item, opts.apiId)
  } catch (err) {
    throw new UnansweredCheckError(err)
  }
  for (const row of rows) {
    if (opts.ignoreIds?.has(Number(row.id))) continue
    if (endpointOf(row.payload) !== opts.endpointPath) continue
    return toUnanswered(row, now)
  }
  return null
}

/** findUnansweredSendStrict that answers null when the table cannot be read. */
export async function findUnansweredSend(opts: SendKey): Promise<UnansweredSend | null> {
  try {
    return await findUnansweredSendStrict(opts)
  } catch {
    return null
  }
}

async function apiName(apiId: number): Promise<string | null> {
  try {
    const row = (await db('nivaro_external_apis').where({ id: apiId }).first('name')) as
      | { name?: string | null }
      | undefined
    return row?.name?.trim() || null
  } catch {
    return null
  }
}

/** What a send that could not check for earlier unanswered sends answers. */
export function checkFailedReason(api: string | null): string {
  return `Couldn't check earlier sends to ${api ?? 'the other system'}. Try again in a minute.`
}

/**
 * Whether this push must wait, and the sentence that says why: an unanswered
 * earlier send of it (young or stale), or — `checkFailed` — the earlier sends
 * could not be read. Null = send. `user` decides the time zone of the sentence
 * (their preference, else the instance's).
 */
export async function unansweredHold(
  opts: SendKey & { moveLabel?: string | null; user?: { preferences?: unknown } | null }
): Promise<{ reason: string; send: UnansweredSend | null; checkFailed: boolean } | null> {
  let send: UnansweredSend | null
  try {
    send = await findUnansweredSendStrict(opts)
  } catch {
    return { reason: checkFailedReason(await apiName(opts.apiId)), send: null, checkFailed: true }
  }
  if (!send) return null
  const { formatForPerson, userTimeZone } = await import('./user-time.js')
  const zone = await userTimeZone(opts.user ?? null).catch(() => 'America/New_York')
  const when = formatForPerson(new Date(send.started_at), zone)
  return {
    reason: unansweredRefusal({ send, moveLabel: opts.moveLabel, when, now: opts.now }),
    send,
    checkFailed: false
  }
}

/** A `sending` row past its time, for the integration signals. */
export interface StaleUnansweredRow {
  id: number
  collection: string
  item: string
  api_name: string | null
  endpoint_path: string | null
  started_at: string
  /** Written by a blocking (order-creating) push: the move waits on it. */
  blocking: boolean
}

/** Every unanswered send past its time, newest first (at most `cap`). */
export async function staleUnansweredSends(
  cap = 2000,
  now = Date.now()
): Promise<StaleUnansweredRow[]> {
  const rows = (await db('nivaro_erp_submissions as s')
    .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
    .where('s.status', SENDING_STATUS)
    .orderBy('s.id', 'desc')
    .limit(cap)
    .select(
      's.id',
      's.collection',
      's.item',
      's.created_at',
      's.payload',
      'a.name as api_name'
    )) as Array<SendingRow & { collection: string; item: string }>
  const out: StaleUnansweredRow[] = []
  for (const r of rows) {
    if (!isUnansweredStale(r, now)) continue
    let blocking = false
    try {
      blocking = (JSON.parse(r.payload ?? '{}') as { blocking?: unknown }).blocking === true
    } catch {
      blocking = false
    }
    out.push({
      id: Number(r.id),
      collection: r.collection,
      item: String(r.item),
      api_name: r.api_name ?? null,
      endpoint_path: endpointOf(r.payload),
      started_at: new Date(r.created_at).toISOString(),
      blocking
    })
  }
  return out
}

/** The newest unanswered send of any push on a record (the pipeline row's warning). */
export async function newestUnansweredSendFor(
  collection: string,
  item: string,
  now = Date.now()
): Promise<UnansweredSend | null> {
  try {
    const [row] = await sendingRows(collection, item)
    return row ? toUnanswered(row, now) : null
  } catch {
    return null
  }
}

/** "40 seconds ago" / "3 minutes ago". */
export function agoText(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - time(iso)) / 1000))
  if (s < 5) return 'just now'
  if (s < 90) return `${s} seconds ago`
  const m = Math.round(s / 60)
  return `${m} minute${m === 1 ? '' : 's'} ago`
}

/**
 * Why this push is not sent now. `when` is the start of the unanswered send in
 * the reader's own words ("Tue, Nov 12 at 3:04 PM EST").
 */
export function unansweredRefusal(opts: {
  send: Pick<UnansweredSend, 'stale' | 'started_at' | 'api_name'>
  moveLabel: string | null | undefined
  when: string
  now?: number
}): string {
  const name = opts.send.api_name?.trim() || null
  const api = name ?? 'the other system'
  if (!opts.send.stale) {
    const ago = agoText(opts.send.started_at, opts.now)
    const move = opts.moveLabel?.trim()
    // Without a move (Send now, a retry) it is the earlier send that is still out.
    return move
      ? `${move} is still being sent to ${api} (started ${ago}). Wait for it to finish.`
      : `An earlier send to ${api} is still waiting for its answer (started ${ago}). Wait for it to finish.`
  }
  return `${name ?? 'The other system'} may already have this order: the last send on ${opts.when} got no answer before the app stopped. Check ${api} before sending again, then mark that send as received or not received in ${RESOLVE_PLACE}.`
}

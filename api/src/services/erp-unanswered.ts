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

/**
 * The newest unanswered send of THIS push (same API, same endpoint) on a record,
 * other than the ones this run began itself (`ignoreIds`). Null = nothing holds
 * the send. A read that fails answers null: the guard is a safety net on top of
 * the action's own guard, and must not stop every push when the table cannot
 * be read.
 */
export async function findUnansweredSend(opts: {
  collection: string
  item: string
  apiId: number
  endpointPath: string
  ignoreIds?: ReadonlySet<number>
  now?: number
}): Promise<UnansweredSend | null> {
  const now = opts.now ?? Date.now()
  try {
    const rows = await sendingRows(opts.collection, opts.item, opts.apiId)
    for (const row of rows) {
      if (opts.ignoreIds?.has(Number(row.id))) continue
      if (endpointOf(row.payload) !== opts.endpointPath) continue
      return toUnanswered(row, now)
    }
  } catch {
    return null
  }
  return null
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
    const move = opts.moveLabel?.trim() || 'This step'
    return `${move} is still being sent to ${api} (started ${agoText(opts.send.started_at, opts.now)}). Wait for it to finish.`
  }
  return `${name ?? 'The other system'} may already have this order: the last send on ${opts.when} got no answer before the app stopped. Check ${api} before sending again, then mark that send as received or not received in ${RESOLVE_PLACE}.`
}

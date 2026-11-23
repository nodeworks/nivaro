import { db } from '../db/index.js'
import { registerAppKeyed } from './app-forget.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { answerDeadline, SENDING_STATUS } from './erp-unanswered.js'
import { planRetries, type RetrySweep, type SweepSchedule } from './send-retry.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Where a record's latest send to each partner stands (rt4 #10) — the facts the
 * record page and the list row word as "Sending to X now", "Sent to X at 10:42 AM —
 * waiting for X's answer", "X accepted it", "X refused it", "No answer from X".
 *
 * Read from nivaro_erp_submissions only: one row per (record, partner), the newest.
 * A partner send runs as part of the move that makes it (workflow-actions.ts
 * beginSubmission → callExternalApi → finishSubmission), one record at a time and
 * in parallel across records — there is no queue or serial lane in front of a
 * send, so no position is ever reported (a "queued" state would be invented).
 *
 * Statuses as stored: `sending` (write-ahead row; past its answer_by deadline it is
 * an unanswered send, erp-unanswered.ts), `pending` (the partner took the request
 * and has not said yes yet), `accepted`, `failed` (a refusal or a call that did not
 * get through; error_class says which) and `rejected` (a stored resend refused).
 *
 * Words are made by the client (packages/shared lib/send-status.ts) so times read in
 * the viewer's own clock and a refusal is read the way every other error is.
 */

export interface SendStatusFact {
  id: number
  api: string
  status: string
  started_at: string
  finished_at: string | null
  external_ref: string | null
  error_class: string | null
  /** The stored error's first line (the partner's words, scrubbed when stored). */
  reason: string | null
  /** `sending` rows: when the call could no longer answer — past it, nobody is waiting. */
  answer_by: string | null
  /** Median time this partner took to accept a send (30 days, ≥ MIN_SAMPLES), else null. */
  usual_answer_ms: number | null
  /** What this partner calls the number it gives back ("PO", "order"); null = "reference". */
  ref_label: string | null
  /** rt6 #18 — a failed send a sweep will try again by itself: when, and which attempt. */
  retry: { at: string; attempt: number; of: number } | null
  /** rt6 #18 — a failed send nothing will repeat: why ("It won't be sent again automatically — …"). */
  no_retry: string | null
  /** The viewer may send this stored request again (the route fills it for one record). */
  can_resend?: boolean
}

interface Row {
  id: number
  item: string
  external_api: number | null
  status: string | null
  created_at: Date | string
  updated_at: Date | string | null
  external_ref: string | null
  error_class: string | null
  last_error: string | null
  api_name: string | null
  api_config: string | null
  attempts: number | null
  retry_count: number | null
  next_retry_at: Date | string | null
}

/** Longest reference label kept (a word or two: "PO", "Sales order"). */
export const REF_LABEL_MAX = 40

/** The reference label stored in an API's integration_config, cleaned; null = default. */
export function referenceLabelOf(config: unknown): string | null {
  let c: unknown = config
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c)
    } catch {
      return null
    }
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  return cleanReferenceLabel((c as Record<string, unknown>).reference_label)
}

/** A label as stored: plain words, one line, at most REF_LABEL_MAX characters; null = none. */
export function cleanReferenceLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = [...v]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch === '<' || ch === '>' ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REF_LABEL_MAX)
    .trim()
  return t || null
}

/** At most this many records per read (a list page). */
export const SEND_STATUS_MAX_IDS = 100
/** Accepted sends a partner needs before "usually answers within" is said. */
export const MIN_SAMPLES = 5
const HISTORY_DAYS = 30
const USUAL_TTL_MS = 10 * 60_000

const iso = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function firstLine(v: string | null | undefined): string | null {
  const line = String(v ?? '')
    .split('\n')[0]
    .trim()
  return line || null
}

/** The median of a list of numbers (exported for tests). */
export function median(values: number[]): number | null {
  const v = values.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2)
}

/** The usual answer time from (started, accepted) pairs, or null below MIN_SAMPLES. */
export function usualAnswerMs(
  samples: Array<{ started: number; answered: number }>
): number | null {
  const d = samples.map((s) => s.answered - s.started).filter((n) => Number.isFinite(n) && n >= 0)
  if (d.length < MIN_SAMPLES) return null
  return median(d)
}

// Per tenant: api id → { at, ms }. One small read per partner per ten minutes.
const usualCache = registerAppKeyed(new Map<string, { at: number; ms: number | null }>())

async function usualAnswerFor(apiIds: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>()
  const tenant = currentTenantKey() ?? ''
  const now = Date.now()
  const missing: number[] = []
  for (const id of apiIds) {
    const hit = usualCache.get(`${tenant}:${id}`)
    if (hit && now - hit.at < USUAL_TTL_MS) out.set(id, hit.ms)
    else missing.push(id)
  }
  for (const id of missing) {
    let ms: number | null = null
    try {
      const rows = (await db('nivaro_erp_submissions')
        .where({ external_api: id, status: 'accepted' })
        .where('created_at', '>=', new Date(now - HISTORY_DAYS * 86_400_000))
        .orderBy('id', 'desc')
        .limit(200)
        .select('created_at', 'updated_at')) as Array<{
        created_at: Date | string
        updated_at: Date | string | null
      }>
      ms = usualAnswerMs(
        rows.map((r) => ({
          started: new Date(r.created_at).getTime(),
          answered: new Date(r.updated_at ?? r.created_at).getTime()
        }))
      )
    } catch {
      ms = null
    }
    usualCache.set(`${tenant}:${id}`, { at: now, ms })
    if (usualCache.size > 500) usualCache.clear()
    out.set(id, ms)
  }
  return out
}

/**
 * The newest send per partner on each of `items` (already judged readable by the
 * caller). Map item id → facts, partners in name order. Items without a send are absent.
 */
export async function readSendStatuses(
  collection: string,
  items: string[],
  opts: {
    /** A retry sweep's schedule from the cron registry (route); default schedules otherwise. */
    schedule?: (sweep: RetrySweep) => SweepSchedule | null
    /** The remediation switch AND at least one obligation kind registered. */
    remediationOn?: () => Promise<boolean>
  } = {}
): Promise<Record<string, SendStatusFact[]>> {
  if (items.length === 0) return {}
  const rows = await selectInChunks(items, 200, (chunk) => {
    const inner = whereInList(
      db('nivaro_erp_submissions as s')
        .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
        .where('s.collection', collection),
      's.item',
      chunk
    ).select(
      's.id',
      's.item',
      's.external_api',
      's.status',
      's.created_at',
      's.updated_at',
      's.external_ref',
      's.error_class',
      's.last_error',
      's.attempts',
      's.retry_count',
      's.next_retry_at',
      'a.name as api_name',
      'a.integration_config as api_config',
      db.raw('ROW_NUMBER() OVER (PARTITION BY s.item, s.external_api ORDER BY s.id DESC) as rn')
    )
    return db
      .from(inner.as('x'))
      .where('x.rn', 1)
      .select(
        'id',
        'item',
        'external_api',
        'status',
        'created_at',
        'updated_at',
        'external_ref',
        'error_class',
        'last_error',
        'attempts',
        'retry_count',
        'next_retry_at',
        'api_name',
        'api_config'
      ) as unknown as Promise<Row[]>
  })
  if (rows.length === 0) return {}
  // A `sending` row's deadline is stored in its request; read those few bodies only.
  const sendingIds = rows.filter((r) => r.status === SENDING_STATUS).map((r) => Number(r.id))
  const deadlines = new Map<number, number>()
  if (sendingIds.length > 0) {
    const bodies = (await db('nivaro_erp_submissions')
      .whereIn('id', sendingIds)
      .select('id', 'created_at', 'payload')) as Array<{
      id: number
      created_at: Date | string
      payload: string | null
    }>
    for (const b of bodies) deadlines.set(Number(b.id), answerDeadline(b))
  }
  // "usually answers within" is said only while a partner's answer is awaited.
  const awaiting = [
    ...new Set(
      rows
        .filter((r) => r.status === 'pending' && r.external_api != null)
        .map((r) => Number(r.external_api))
    )
  ]
  const usual = awaiting.length > 0 ? await usualAnswerFor(awaiting) : new Map()
  // rt6 #18 — failed sends: will a sweep try them again by itself, and when?
  const retries = await planRetries(
    rows.map((r) => ({
      id: Number(r.id),
      status: String(r.status ?? ''),
      error_class: r.error_class ?? null,
      attempts: r.attempts,
      retry_count: r.retry_count,
      next_retry_at: r.next_retry_at,
      updated_at: r.updated_at,
      external_api: r.external_api != null ? Number(r.external_api) : null,
      api: r.api_name?.trim() || 'the other system'
    })),
    { schedule: opts.schedule, remediationOn: opts.remediationOn }
  ).catch(() => new Map())
  const out: Record<string, SendStatusFact[]> = {}
  for (const r of rows) {
    const key = String(r.item)
    const deadline = deadlines.get(Number(r.id))
    const fact: SendStatusFact = {
      id: Number(r.id),
      api: r.api_name?.trim() || 'the other system',
      status: String(r.status ?? ''),
      started_at: iso(r.created_at) ?? new Date().toISOString(),
      finished_at: r.status === SENDING_STATUS ? null : iso(r.updated_at),
      external_ref: r.external_ref?.trim() || null,
      error_class: r.error_class ?? null,
      reason: firstLine(r.last_error),
      answer_by: deadline != null && Number.isFinite(deadline) ? iso(new Date(deadline)) : null,
      usual_answer_ms:
        r.status === 'pending' && r.external_api != null
          ? (usual.get(Number(r.external_api)) ?? null)
          : null,
      ref_label: referenceLabelOf(r.api_config),
      retry: retries.get(Number(r.id))?.retry ?? null,
      no_retry: retries.get(Number(r.id))?.no_retry ?? null
    }
    const list = out[key] ?? []
    list.push(fact)
    out[key] = list
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.api.localeCompare(b.api))
  return out
}

/** Test seam: forget the per-partner answer times. */
export function resetSendStatusCache(): void {
  usualCache.clear()
}

import { Cron } from 'croner'
import { db } from '../db/index.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { hasResendableBody } from './erp-resend-guard.js'

/**
 * Will a failed partner send be tried again by itself, and when? (rt6 #18)
 *
 * Two sweeps re-send a failed `nivaro_erp_submissions` row with nobody pressing anything:
 *
 *  - the API's own retry policy (`nivaro_external_apis.retry_policy` {max_attempts,
 *    backoff_minutes}, #469) — cron `erp-auto-retry` (every 10 minutes) re-sends `failed`
 *    rows whose `next_retry_at` has passed and whose `retry_count` is under max_attempts,
 *    except refusals repetition cannot fix (error_class validation / not_found);
 *  - the integration remediation ladder (migration 346, Settings → Integrations, off by
 *    default) — run by cron `integration-reconcile` (every 15 minutes) for a failed
 *    obligation whose API has NO retry policy at all and whose send failed in a way sending
 *    the same bytes again could fix (transient / rate_limited / auth): 1, 5, 30, 120, 120
 *    minutes after each attempt, five attempts, then "a person needs to look".
 *
 * Nothing else repeats a partner send by itself: dead letters and failed flow runs are
 * retried by a person, a stored resend that was refused (`rejected`) is final, and an
 * unanswered `sending` row is never repeated (erp-unanswered.ts).
 *
 * The plan below mirrors both sweeps' own selection rules exactly, so what the record says
 * is what the next tick will do. The time is the sweep's next run at or after the moment the
 * ladder allows the send (the cron's own schedule, zone and admin override); a paused sweep
 * means no retry.
 */

export type RetrySweep = 'erp-auto-retry' | 'integration-reconcile'

/** Mirrors integration-remediation.ts LADDER (minutes after each attempt; five attempts). */
export const REMEDIATION_LADDER = [1, 5, 30, 120, 120]
/** Classes the remediation pass re-sends (integration-remediation.ts RETRYABLE_CLASSES). */
const REMEDIATION_CLASSES = new Set(['transient', 'rate_limited', 'auth'])
/** Classes the policy sweep never re-sends (routes/erp-submissions.ts runErpAutoRetries). */
const POLICY_SKIP_CLASSES = new Set(['validation', 'not_found'])

export interface RetryPolicy {
  max_attempts: number
  backoff_minutes: number
}

export interface RetryRowFacts {
  status: string
  error_class: string | null
  /** Sends made for this row (every resend counts). */
  attempts: number
  /** The policy sweep's own count of its retries. */
  retry_count: number
  next_retry_at: Date | string | null
  updated_at: Date | string | null
  /** The stored request can be sent again (a render failure stores no body). */
  has_body: boolean
}

export interface RetryContext {
  now: number
  api: string
  /** The API's scheduled retry policy (both halves set), else null. */
  policy: RetryPolicy | null
  /** The API carries ANY retry_policy (an inline-only one keeps the remediation pass away). */
  apiHasPolicy: boolean
  /** The remediation switch, and whether at least one obligation kind is registered. */
  remediationOn: boolean
  /** This send's obligation: failed and still on the ladder, gave up, or none/closed. */
  obligation: 'failed' | 'gave_up' | null
  /** When a sweep next runs at or after `due`; null = the sweep is paused. */
  tick: (sweep: RetrySweep, due: Date) => Date | null
}

export interface RetryPlan {
  /** When it will be tried again, or null when it will not be. */
  retry: { at: string; attempt: number; of: number } | null
  /** Why it will not be tried again by itself (lower-case, reads after "Will not retry — "). */
  no_retry: string | null
}

const ms = (v: Date | string | null | undefined): number | null => {
  if (v == null) return null
  const n = (v instanceof Date ? v : new Date(v)).getTime()
  return Number.isFinite(n) ? n : null
}

/** Pure: what the sweeps will do with one failed send. Null for a send that has not failed. */
export function planRetry(row: RetryRowFacts, ctx: RetryContext): RetryPlan | null {
  const status = (row.status ?? '').toLowerCase()
  if (status !== 'failed' && status !== 'rejected') return null
  const cls = (row.error_class ?? '').toLowerCase()
  const no = (why: string): RetryPlan => ({ retry: null, no_retry: why })
  if (!row.has_body) return no('there is nothing stored to send again')
  if (status === 'rejected' || POLICY_SKIP_CLASSES.has(cls))
    return no('sending the same thing again cannot fix it')

  if (ctx.policy) {
    const max = Math.min(10, ctx.policy.max_attempts)
    const done = Math.max(0, Number(row.retry_count) || 0)
    if (done >= max) return no(`all ${max + 1} attempts were made`)
    const due = Math.max(ms(row.next_retry_at) ?? ctx.now, ctx.now)
    const at = ctx.tick('erp-auto-retry', new Date(due))
    if (!at) return no('automatic retries are paused')
    return { retry: { at: at.toISOString(), attempt: done + 2, of: max + 1 }, no_retry: null }
  }

  if (!ctx.apiHasPolicy && ctx.remediationOn && ctx.obligation) {
    const of = REMEDIATION_LADDER.length
    if (ctx.obligation === 'gave_up') return no(`all ${of} attempts were made`)
    if (!REMEDIATION_CLASSES.has(cls)) return no('it is not clear that sending it again would help')
    const made = Math.max(0, Number(row.attempts) || 0)
    if (made >= of) return no(`all ${of} attempts were made`)
    const last = ms(row.updated_at) ?? ctx.now
    const due = Math.max(last + REMEDIATION_LADDER[made] * 60_000, ctx.now)
    const at = ctx.tick('integration-reconcile', new Date(due))
    if (!at) return no('automatic retries are paused')
    return { retry: { at: at.toISOString(), attempt: made + 1, of }, no_retry: null }
  }

  return no(`automatic retries are not set up for ${ctx.api}`)
}

/** The scheduled half of a stored retry_policy, or null (runErpAutoRetries' own parse). */
export function scheduledPolicy(raw: unknown): RetryPolicy | null {
  type Stored = { max_attempts?: unknown; backoff_minutes?: unknown }
  let p: Stored | null = null
  if (raw && typeof raw === 'object') p = raw as Stored
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      p = JSON.parse(raw)
    } catch {
      p = null
    }
  }
  const max = Number(p?.max_attempts)
  const backoff = Number(p?.backoff_minutes)
  if (Number.isFinite(max) && max > 0 && Number.isFinite(backoff) && backoff > 0)
    return { max_attempts: Math.min(10, max), backoff_minutes: backoff }
  return null
}

/** What a sweep's schedule says, as the route reads it from the cron registry. */
export interface SweepSchedule {
  expression: string
  timezone?: string | null
  paused?: boolean
}

const DEFAULT_SCHEDULES: Record<RetrySweep, string> = {
  'erp-auto-retry': '*/10 * * * *',
  'integration-reconcile': '*/15 * * * *'
}

/** The first run of `schedule` at or after `due`; null when paused. Falls back to `due`. */
export function nextSweepRun(
  sweep: RetrySweep,
  due: Date,
  schedule: SweepSchedule | null | undefined
): Date | null {
  if (schedule?.paused) return null
  const expression = schedule?.expression || DEFAULT_SCHEDULES[sweep]
  try {
    const probe = new Cron(expression, {
      paused: true,
      ...(schedule?.timezone ? { timezone: schedule.timezone } : {})
    })
    // nextRun(prev) is strictly after prev: a second earlier keeps a run AT `due`.
    return probe.nextRun(new Date(due.getTime() - 1000)) ?? due
  } catch {
    return due
  }
}

interface FailedRow {
  id: number
  status: string
  error_class: string | null
  attempts: number | null
  retry_count: number | null
  next_retry_at: Date | string | null
  updated_at: Date | string | null
  external_api: number | null
  api: string
}

/**
 * Plans for the failed sends among a send-status read: a few small reads (stored bodies,
 * the APIs' policies, the obligations, the remediation switch), only for failed rows.
 */
export async function planRetries(
  rows: FailedRow[],
  opts: {
    now?: number
    schedule?: (sweep: RetrySweep) => SweepSchedule | null
    remediationOn?: () => Promise<boolean>
  } = {}
): Promise<Map<number, RetryPlan>> {
  const out = new Map<number, RetryPlan>()
  const failed = rows.filter((r) => ['failed', 'rejected'].includes(String(r.status)))
  if (failed.length === 0) return out
  const now = opts.now ?? Date.now()
  const ids = failed.map((r) => Number(r.id))

  const bodies = new Map<number, boolean>()
  const payloads = (await selectInChunks(ids, 200, (chunk) =>
    whereInList(db('nivaro_erp_submissions'), 'id', chunk).select('id', 'payload')
  )) as Array<{ id: number; payload: string | null }>
  for (const p of payloads) {
    let stored: { body?: unknown; endpoint_path?: unknown } | null = null
    try {
      stored = typeof p.payload === 'string' ? JSON.parse(p.payload) : null
    } catch {
      stored = null
    }
    bodies.set(Number(p.id), hasResendableBody(stored) && !!stored?.endpoint_path)
  }

  const apiIds = [...new Set(failed.map((r) => r.external_api).filter((a) => a != null))]
  const policies = new Map<number, { any: boolean; scheduled: RetryPolicy | null }>()
  if (apiIds.length > 0) {
    const apis = (await db('nivaro_external_apis')
      .whereIn('id', apiIds as number[])
      .select('id', 'retry_policy')) as Array<{ id: number; retry_policy: string | null }>
    for (const a of apis)
      policies.set(Number(a.id), {
        any: a.retry_policy != null && String(a.retry_policy).trim() !== '',
        scheduled: scheduledPolicy(a.retry_policy)
      })
  }

  // The remediation pass only matters for APIs with no policy at all.
  const ladderRows = failed.filter((r) => !policies.get(Number(r.external_api))?.any)
  let remediationOn = false
  const obligations = new Map<number, 'failed' | 'gave_up'>()
  if (ladderRows.length > 0) {
    remediationOn = opts.remediationOn ? await opts.remediationOn().catch(() => false) : false
    if (remediationOn) {
      const obl = (await selectInChunks(
        ladderRows.map((r) => Number(r.id)),
        200,
        (chunk) =>
          whereInList(db('nivaro_integration_obligations'), 'submission_id', chunk)
            .where('outcome', 'failed')
            .select('submission_id', 'reason')
      ).catch(() => [])) as Array<{ submission_id: number; reason: string | null }>
      for (const o of obl) {
        const gaveUp = /^gave up:/i.test(String(o.reason ?? ''))
        const prior = obligations.get(Number(o.submission_id))
        // One still on the ladder wins over one that gave up (the pass takes any open one).
        if (prior !== 'failed')
          obligations.set(Number(o.submission_id), gaveUp ? 'gave_up' : 'failed')
      }
    }
  }

  for (const r of failed) {
    const pol = policies.get(Number(r.external_api))
    const plan = planRetry(
      {
        status: String(r.status),
        error_class: r.error_class,
        attempts: Number(r.attempts ?? 0),
        retry_count: Number(r.retry_count ?? 0),
        next_retry_at: r.next_retry_at,
        updated_at: r.updated_at,
        has_body: bodies.get(Number(r.id)) ?? false
      },
      {
        now,
        api: r.api,
        policy: pol?.scheduled ?? null,
        apiHasPolicy: pol?.any ?? false,
        remediationOn,
        obligation: obligations.get(Number(r.id)) ?? null,
        tick: (sweep, due) => nextSweepRun(sweep, due, opts.schedule?.(sweep) ?? null)
      }
    )
    if (plan) out.set(Number(r.id), plan)
  }
  return out
}

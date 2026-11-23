import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { registerAppKeyed } from './app-forget.js'
import { isMultiTenant } from './deployment-mode.js'
import { classifyMailError, nextRetryDelayMs } from './mail-retry-policy.js'

/**
 * Automatic mail retry — where its state lives (migration 536):
 * nivaro_mail_log.retry_at / retry_count on the ORIGINAL send. The logger
 * stamps a first retry on a failed original whose error is temporary; the
 * runner (services/mail-retry.ts) moves it along; a manual Resend clears it.
 *
 * Every reader and the logger probe the columns first (per tenant; a hit is
 * kept, a miss is re-checked after a minute, the same as the resend columns) —
 * a database behind 536 logs and resends as before and simply never retries.
 */

/** On unless MAIL_RETRY=off. Self-hosted only: cloud mode has no per-tenant core crons. */
export function mailRetryEnabled(): boolean {
  if (isMultiTenant()) return false
  const v = String(process.env.MAIL_RETRY ?? '')
    .trim()
    .toLowerCase()
  return !['off', 'false', '0', 'no'].includes(v)
}

const MISS_TTL_MS = 60_000
interface ProbeState {
  hit: boolean
  at: number
  inflight: Promise<boolean> | null
}
const probes = registerAppKeyed(new Map<string, ProbeState>())

export async function hasRetryColumns(): Promise<boolean> {
  const key = getTenantId() ?? ''
  const state = probes.get(key)
  if (state?.hit) return true
  if (state?.inflight) return state.inflight
  if (state && Date.now() - state.at < MISS_TTL_MS) return false
  const inflight = (async () => {
    try {
      const [a, b] = await Promise.all([
        db.schema.hasColumn('nivaro_mail_log', 'retry_at'),
        db.schema.hasColumn('nivaro_mail_log', 'retry_count')
      ])
      return a && b
    } catch {
      return false
    }
  })()
  probes.set(key, { hit: false, at: state?.at ?? 0, inflight })
  const hit = await inflight
  probes.set(key, { hit, at: Date.now(), inflight: null })
  return hit
}

export function resetRetryColumnProbe(): void {
  probes.clear()
}

export interface RetryStampInput {
  status: string
  error?: unknown
  body?: string | null
  /** The logged recipient list (joined). */
  to?: string | null
  /** Set on a resend's rows — the runner reschedules the ORIGINAL, never a copy. */
  resendOf?: number | null
  /** OPT-IN: only true stamps (a sender with no retry of its own, nothing unstored). */
  autoRetry?: boolean
}

/** What the mail log stores (logMail slices beyond these) — a longer send cannot be replayed whole. */
export const STORED_BODY_MAX = 200_000
export const STORED_TO_MAX = 1000

/** Pure: whether a just-failed send should be retried automatically. */
export function wantsAutoRetry(input: RetryStampInput): boolean {
  if (input.status !== 'failed') return false
  if (input.autoRetry !== true) return false
  if (Number(input.resendOf) > 0) return false
  // A retry replays the stored copy — nothing stored (or a truncated copy), nothing to replay.
  if (!input.body || input.body.length > STORED_BODY_MAX) return false
  if (!input.to || input.to.length > STORED_TO_MAX) return false
  return classifyMailError(input.error).kind === 'temporary'
}

/** The two columns to spread into a mail-log insert for a failed original, or {}. */
export async function retryFields(
  input: RetryStampInput,
  now: number = Date.now()
): Promise<Record<string, unknown>> {
  if (!wantsAutoRetry(input) || !mailRetryEnabled()) return {}
  if (!(await hasRetryColumns())) return {}
  const delay = nextRetryDelayMs(0)
  if (delay == null) return {}
  return { retry_at: new Date(now + delay), retry_count: 0 }
}

/**
 * A manual Resend takes over: the original's pending automatic retry is
 * cleared (the count stays, so the log still says how many were made).
 */
export async function clearPendingRetry(originalId: number): Promise<void> {
  if (!Number.isInteger(originalId) || originalId <= 0) return
  if (!(await hasRetryColumns())) return
  await db('nivaro_mail_log')
    .where('id', originalId)
    .whereNotNull('retry_at')
    .update({ retry_at: null })
    .catch(() => undefined)
}

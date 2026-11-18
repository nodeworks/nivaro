import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import { type MailResult, sendRawMail } from './mail.js'
import { hasResendColumns } from './mail-resends.js'
import { classifyMailError, nextRetryDelayMs } from './mail-retry-policy.js'
import { hasRetryColumns, mailRetryEnabled } from './mail-retry-state.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Automatic mail retry (migration 536) — the runner and the one replay path.
 *
 * A failed ORIGINAL send that opted in (MailOptions.autoRetry) and failed with a
 * temporary error (mail-retry-policy.ts) is logged with `retry_at` = now +
 * 1 min. The `mail-retry` cron (every minute, self-hosted, background pool,
 * scheduler lease — one process ticks) claims each due row and replays it
 * through `replayMailLogRow`, the SAME path the Mail log's Resend button uses:
 * the stored copy is sent again and the new row names the original
 * (`resend_of`) with `resent_by` NULL — an automatic retry. A temporary
 * failure again moves `retry_at` on (waits of 5, 15, 60 min: about 1, 6, 21
 * and 81 min after the failure in all); any other outcome, the fourth retry,
 * or an original older than MAX_AGE_MS ends it.
 *
 * Never twice:
 *   - two runners: the claim is one UPDATE … SET retry_at = NULL WHERE id = ?
 *     AND retry_at <= now — only one of them changes the row;
 *   - runner vs a person's Resend: both take a per-original send lock in Redis
 *     (`nvr:mail-send:<tenant>:<id>`, a random token, released only by that
 *     token — compare-and-delete, like the cron lease); its TTL is well above
 *     the SMTP time limits (mail.ts SMTP_TIMEOUTS). The Resend route clears the
 *     pending retry first, and a runner that finds a manual resend of the row
 *     clears it instead of sending. Without Redis only the claim protects.
 *
 * An outage drains gently: at most RETRY_BATCH rows and TICK_BUDGET_MS per
 * tick, and after STOP_AFTER_FAILURES temporary or ambiguous failures in a row
 * (reset only by a send the server took) the tick stops and every other due
 * row moves out by PUSH_MS without using an attempt.
 */

export const RETRY_BATCH = 50
/** Temporary / ambiguous failures in a row (no 'sent' between) that end a tick. */
export const STOP_AFTER_FAILURES = 2
/** How far the rest of a stopped tick's due rows move out. */
export const PUSH_MS = 2 * 60_000
/** A tick starts no new retry after this long. */
export const TICK_BUDGET_MS = 3 * 60_000
/** An original older than this is never retried any more (stale news, or a restored copy). */
export const MAX_AGE_MS = 3 * 60 * 60_000
/** Per-original send lock — well above SMTP_TIMEOUTS' sum (30 + 30 + 60 s). */
export const SEND_LOCK_TTL_S = 600

export type RedisLike = Pick<Redis, 'set' | 'eval'>

const lockKey = (originalId: number) => `nvr:mail-send:${currentTenantKey() || '-'}:${originalId}`
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/**
 * One send at a time per original, across processes. Returns a release
 * function, or null when someone else is sending it right now. No Redis (or
 * Redis trouble) = no lock: the database claim still keeps two runners apart.
 * The release deletes the key only while it still holds THIS taker's token —
 * a lock that expired and was taken by someone else is never removed.
 */
export async function takeSendLock(
  redis: RedisLike | null | undefined,
  originalId: number
): Promise<(() => Promise<void>) | null> {
  const noop = async () => undefined
  if (!redis) return noop
  const key = lockKey(originalId)
  const token = randomUUID()
  try {
    const ok = await redis.set(key, token, 'EX', SEND_LOCK_TTL_S, 'NX')
    if (ok !== 'OK') return null
  } catch {
    return noop
  }
  return async () => {
    await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, key, token)).catch(() => undefined)
  }
}

/** The mail-log columns a replay needs. */
export interface ReplayRow {
  id: number | string
  to: string | null
  subject: string | null
  body: string | null
  template?: string | null
  collection?: string | null
  item?: string | number | null
  resend_of?: number | string | null
}

/** The original a row belongs to: itself, or the original it resends (one level deep). */
export function originalIdOf(row: { id: number | string; resend_of?: number | string | null }) {
  return Number(row.resend_of) > 0 ? Number(row.resend_of) : Number(row.id)
}

/**
 * Send a logged email again from its stored copy — the Resend button and the
 * automatic retry both come through here, so a retry is exactly a resend.
 * `resentBy` null = an automatic retry. Throws what sendRawMail throws (the
 * failed attempt's row id rides the error as `mailLogId`).
 */
export async function replayMailLogRow(
  row: ReplayRow,
  resentBy: string | null
): Promise<MailResult & { resend_of: number }> {
  const resendOf = originalIdOf(row)
  const result = await sendRawMail({
    to: String(row.to),
    subject: String(row.subject ?? '(no subject)'),
    html: String(row.body),
    wrap: false, // the stored body is the final rendered document
    skipDigest: true,
    // Same template + record as the original: the resend groups with it on the
    // delivery board and shows on the record's Mail tab.
    template: row.template ?? null,
    collection: row.collection ?? null,
    item: row.item ?? null,
    resendOf,
    resentBy
  })
  return { ...result, resend_of: resendOf }
}

export interface RetryPassResult {
  skipped?: 'off' | 'no-columns'
  due: number
  tried: number
  delivered: number
  rescheduled: number
  gaveUp: number
  cancelled: number
  pushed: number
  stopped: boolean
  /** The tick ran out of time; the rest wait for the next one. */
  budgetSpent: boolean
}

const affected = (n: unknown) => (Array.isArray(n) ? n.length : Number(n) || 0)

/** A row the runner must never replay, whatever its retry_at says. */
export function notReplayable(
  row: { status?: unknown; error?: unknown; resend_of?: unknown; body?: unknown },
  createdAtMs: number,
  nowMs: number
): string | null {
  if (String(row.status ?? '') !== 'failed') return 'not-failed'
  if (Number(row.resend_of) > 0) return 'a-copy'
  // Diverted by test mode (caught / dropped rows): a replay could reach the real people.
  if (/^(?:caught in |suppressed:|skipped:)/i.test(String(row.error ?? ''))) return 'diverted'
  if (!row.body) return 'no-body'
  if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs > MAX_AGE_MS) return 'too-old'
  return null
}

/** One runner pass over the due retries. Called by the `mail-retry` cron. */
export async function runMailRetryPass(
  opts: { redis?: RedisLike | null; now?: () => number; budgetMs?: number } = {}
): Promise<RetryPassResult> {
  const now = opts.now ?? Date.now
  const started = Date.now()
  const budget = opts.budgetMs ?? TICK_BUDGET_MS
  const out: RetryPassResult = {
    due: 0,
    tried: 0,
    delivered: 0,
    rescheduled: 0,
    gaveUp: 0,
    cancelled: 0,
    pushed: 0,
    stopped: false,
    budgetSpent: false
  }
  if (!mailRetryEnabled()) return { ...out, skipped: 'off' }
  if (!(await hasRetryColumns())) return { ...out, skipped: 'no-columns' }
  const trail = await hasResendColumns()

  const due = (await db('nivaro_mail_log')
    .whereNotNull('retry_at')
    .where('retry_at', '<=', new Date(now()))
    .orderBy('retry_at', 'asc')
    .limit(RETRY_BATCH)
    .select('id')) as Array<{ id: number | string }>
  out.due = due.length

  let failuresInRow = 0
  for (const { id: rawId } of due) {
    if (Date.now() - started > budget) {
      out.budgetSpent = true
      break
    }
    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0) continue
    const release = await takeSendLock(opts.redis, id)
    if (!release) continue // a person's Resend (or another runner) is sending it now
    try {
      // A person resent it by hand: their Resend owns it now.
      if (trail) {
        const manual = await db('nivaro_mail_log')
          .where('resend_of', id)
          .whereNotNull('resent_by')
          .first('id')
        if (manual) {
          await db('nivaro_mail_log').where('id', id).update({ retry_at: null })
          out.cancelled++
          continue
        }
      }
      // The claim: only the process that clears a still-due retry_at sends.
      const claimed = affected(
        await db('nivaro_mail_log')
          .where('id', id)
          .whereNotNull('retry_at')
          .where('retry_at', '<=', new Date(now()))
          .update({ retry_at: null })
      )
      if (claimed !== 1) continue
      const row = (await db('nivaro_mail_log')
        .where('id', id)
        .first(
          'id',
          'to',
          'subject',
          'body',
          'template',
          'collection',
          'item',
          'status',
          'error',
          'created_at',
          'resend_of',
          'retry_count'
        )) as
        | (ReplayRow & {
            status?: string
            error?: string | null
            created_at?: string | Date
            retry_count?: number | null
          })
        | undefined
      if (!row) continue
      const createdMs = row.created_at ? new Date(row.created_at).getTime() : Number.NaN
      // Claimed (retry_at now NULL) and not replayable: that is its final state.
      if (notReplayable(row, createdMs, now())) {
        out.gaveUp++
        continue
      }
      const attempt = (Number(row.retry_count) || 0) + 1
      out.tried++
      try {
        const r = await replayMailLogRow(row, null)
        // Sent — or dropped / deferred / unconfigured: either way not a retry case.
        await db('nivaro_mail_log').where('id', id).update({ retry_count: attempt })
        out.delivered++
        if (r.status === 'sent') failuresInRow = 0
      } catch (err) {
        const kind = classifyMailError(err).kind
        const delay = kind === 'temporary' ? nextRetryDelayMs(attempt) : null
        await db('nivaro_mail_log')
          .where('id', id)
          .update({
            retry_count: attempt,
            retry_at: delay == null ? null : new Date(now() + delay)
          })
        if (delay == null) out.gaveUp++
        else out.rescheduled++
        if (kind === 'temporary' || kind === 'ambiguous') {
          failuresInRow++
          if (failuresInRow >= STOP_AFTER_FAILURES) {
            out.stopped = true
            break
          }
        }
      }
    } finally {
      await release()
    }
  }

  if (out.stopped) {
    // The server is still down: move every other due retry out without using an attempt.
    out.pushed = affected(
      await db('nivaro_mail_log')
        .whereNotNull('retry_at')
        .where('retry_at', '<=', new Date(now()))
        .update({ retry_at: new Date(now() + PUSH_MS) })
    )
  }
  return out
}

export interface RetryBacklog {
  pending: number
  due: number
  oldestFailedAt: string | null
}

/** How many automatic retries wait, how many are due, and since when the oldest failed. */
export async function mailRetryBacklog(nowMs: number = Date.now()): Promise<RetryBacklog | null> {
  if (!mailRetryEnabled() || !(await hasRetryColumns())) return null
  const row = (await db('nivaro_mail_log')
    .whereNotNull('retry_at')
    .first(
      db.raw('COUNT(*) AS pending'),
      db.raw('SUM(CASE WHEN retry_at <= ? THEN 1 ELSE 0 END) AS due', [new Date(nowMs)]),
      db.raw('MIN(created_at) AS oldest')
    )) as { pending?: unknown; due?: unknown; oldest?: unknown } | undefined
  const oldest = row?.oldest
  return {
    pending: Number(row?.pending) || 0,
    due: Number(row?.due) || 0,
    oldestFailedAt: oldest instanceof Date ? oldest.toISOString() : oldest ? String(oldest) : null
  }
}

export const BACKLOG_WARN_COUNT = 20
export const BACKLOG_WARN_AGE_MS = 30 * 60_000

/** Pure: the readiness verdict for a retry backlog. */
export function judgeRetryBacklog(
  b: RetryBacklog | null,
  nowMs: number = Date.now()
): { status: 'pass' | 'warn' | 'skip'; detail: string; blockers?: string[] } {
  if (!b) return { status: 'skip', detail: 'Automatic mail retry is off on this instance.' }
  if (b.pending === 0) return { status: 'pass', detail: 'No failed email is waiting for a retry.' }
  const age = b.oldestFailedAt ? nowMs - new Date(b.oldestFailedAt).getTime() : 0
  const mins = Math.max(0, Math.round(age / 60_000))
  if (b.pending > BACKLOG_WARN_COUNT && age > BACKLOG_WARN_AGE_MS)
    return {
      status: 'warn',
      detail: `${b.pending} failed emails are waiting for an automatic retry; the oldest failed ${mins} minutes ago.`,
      blockers: [
        'The mail server keeps refusing for now, timing out or cannot be reached. Check Settings → Email and the relay itself.'
      ]
    }
  return {
    status: 'pass',
    detail: `${b.pending} failed email${b.pending === 1 ? ' is' : 's are'} waiting for an automatic retry.`
  }
}

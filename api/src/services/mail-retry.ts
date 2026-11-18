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
 * A failed ORIGINAL send whose error was temporary (mail-retry-policy.ts) is
 * logged with `retry_at` = now + 1 min. The `mail-retry` cron (every minute,
 * self-hosted, background pool, scheduler lease — one process ticks) claims
 * each due row and replays it through `replayMailLogRow`, the SAME path the
 * Mail log's Resend button uses: the stored copy is sent again and the new row
 * names the original (`resend_of`) with `resent_by` NULL — an automatic retry.
 * A temporary failure again moves `retry_at` to the next step (5 min, 15 min,
 * 1 h); any other outcome, or the fourth retry, ends it.
 *
 * Never twice:
 *   - two runners: the claim is one UPDATE … SET retry_at = NULL WHERE id = ?
 *     AND retry_at <= now — only one of them changes the row;
 *   - runner vs a person's Resend: both take a short per-original send lock in
 *     Redis (`nvr:mail-send:<tenant>:<id>`); the Resend route clears the
 *     pending retry first, and a runner that finds a manual resend of the row
 *     clears it instead of sending. Without Redis only the claim protects.
 *
 * An outage drains gently: at most RETRY_BATCH rows per tick, and when the
 * first retries of a tick fail temporarily again (the server is still down)
 * the tick stops and every other due row moves out by PUSH_MS without using
 * an attempt.
 */

export const RETRY_BATCH = 50
/** Temporary failures in a row, with nothing delivered, that end a tick. */
export const STOP_AFTER_TEMP_FAILURES = 2
/** How far the rest of a stopped tick's due rows move out. */
export const PUSH_MS = 2 * 60_000
const LOCK_TTL_S = 300

export type RedisLike = Pick<Redis, 'set' | 'del'>

const lockKey = (originalId: number) => `nvr:mail-send:${currentTenantKey() || '-'}:${originalId}`

/**
 * One send at a time per original, across processes. Returns a release
 * function, or null when someone else is sending it right now. No Redis (or
 * Redis trouble) = no lock: the database claim still keeps two runners apart.
 */
export async function takeSendLock(
  redis: RedisLike | null | undefined,
  originalId: number
): Promise<(() => Promise<void>) | null> {
  const noop = async () => undefined
  if (!redis) return noop
  const key = lockKey(originalId)
  try {
    const ok = await redis.set(key, '1', 'EX', LOCK_TTL_S, 'NX')
    if (ok !== 'OK') return null
  } catch {
    return noop
  }
  return async () => {
    await Promise.resolve(redis.del(key)).catch(() => undefined)
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
}

const affected = (n: unknown) => (Array.isArray(n) ? n.length : Number(n) || 0)

/** One runner pass over the due retries. Called by the `mail-retry` cron. */
export async function runMailRetryPass(
  opts: { redis?: RedisLike | null; now?: () => number } = {}
): Promise<RetryPassResult> {
  const now = opts.now ?? Date.now
  const out: RetryPassResult = {
    due: 0,
    tried: 0,
    delivered: 0,
    rescheduled: 0,
    gaveUp: 0,
    cancelled: 0,
    pushed: 0,
    stopped: false
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

  let tempFailures = 0
  for (const { id: rawId } of due) {
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
          'resend_of',
          'retry_count'
        )) as (ReplayRow & { retry_count?: number | null }) | undefined
      if (!row) continue
      const attempt = (Number(row.retry_count) || 0) + 1
      if (!row.body) {
        await db('nivaro_mail_log').where('id', id).update({ retry_count: attempt })
        out.gaveUp++
        continue
      }
      out.tried++
      try {
        await replayMailLogRow(row, null)
        // Sent — or dropped / deferred / unconfigured: either way not a retry case.
        await db('nivaro_mail_log').where('id', id).update({ retry_count: attempt })
        out.delivered++
        tempFailures = 0
      } catch (err) {
        const temporary = classifyMailError(err).kind === 'temporary'
        const delay = temporary ? nextRetryDelayMs(attempt) : null
        await db('nivaro_mail_log')
          .where('id', id)
          .update({
            retry_count: attempt,
            retry_at: delay == null ? null : new Date(now() + delay)
          })
        if (delay == null) out.gaveUp++
        else out.rescheduled++
        if (temporary && out.delivered === 0) {
          tempFailures++
          if (tempFailures >= STOP_AFTER_TEMP_FAILURES) {
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
        'The mail server keeps answering "try later" or cannot be reached. Check Settings → Email and the relay itself.'
      ]
    }
  return {
    status: 'pass',
    detail: `${b.pending} failed email${b.pending === 1 ? ' is' : 's are'} waiting for an automatic retry.`
  }
}

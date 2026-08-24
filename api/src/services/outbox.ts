import { db } from '../db/index.js'

/**
 * Transactional outbox (#326/#335): work that must not vanish in a swallowed
 * catch is written as a row in the SAME database the triggering write used,
 * then delivered by the worker with backoff. A crash between the write and
 * the delivery loses nothing — the row is still there on boot.
 *
 * Handlers are registered per kind at boot; a row whose kind has no handler
 * just waits (a deploy rolling back to an older image must not dead-letter
 * newer rows).
 */

type OutboxHandler = (payload: Record<string, unknown>) => Promise<void>

const handlers = new Map<string, OutboxHandler>()
const MAX_ATTEMPTS = 5

export function registerOutboxHandler(kind: string, fn: OutboxHandler): void {
  handlers.set(kind, fn)
}

export async function enqueueOutbox(
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  await db('nivaro_outbox')
    .insert({
      kind,
      payload: JSON.stringify(payload),
      status: 'pending',
      attempts: 0,
      next_attempt_at: new Date(),
      created_at: new Date()
    })
    .catch(() => {
      // The outbox is the safety net — if even IT can't be written the
      // original best-effort path already ran; nothing more to do.
    })
}

/** One worker pass: deliver every due pending row. Called by the cron. */
export async function runOutboxPass(): Promise<{ delivered: number; failed: number }> {
  const due = (await db('nivaro_outbox')
    .where({ status: 'pending' })
    .where('next_attempt_at', '<=', new Date())
    .orderBy('id')
    .limit(100)) as Array<{
    id: number
    kind: string
    payload: string
    attempts: number
  }>
  let delivered = 0
  let failed = 0
  for (const row of due) {
    const handler = handlers.get(row.kind)
    if (!handler) continue
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      await handler(payload)
      await db('nivaro_outbox')
        .where({ id: row.id })
        .update({ status: 'delivered', delivered_at: new Date() })
      delivered++
    } catch (err) {
      failed++
      const attempts = row.attempts + 1
      const dead = attempts >= MAX_ATTEMPTS
      await db('nivaro_outbox')
        .where({ id: row.id })
        .update({
          attempts,
          status: dead ? 'dead' : 'pending',
          // Quadratic backoff: 1, 4, 9, 16 minutes between attempts.
          next_attempt_at: new Date(Date.now() + attempts * attempts * 60_000),
          last_error: String(err instanceof Error ? err.message : err).slice(0, 2000)
        })
        .catch(() => {})
      if (dead) {
        const { trackError } = await import('./error-tracking.js')
        void trackError({
          source: 'server',
          route: 'outbox',
          message: `Outbox row ${row.id} (${row.kind}) dead after ${attempts} attempts: ${String(
            err instanceof Error ? err.message : err
          ).slice(0, 300)}`
        })
      }
    }
  }
  // Retention: delivered rows older than 7 days.
  await db('nivaro_outbox')
    .where({ status: 'delivered' })
    .where('created_at', '<', new Date(Date.now() - 7 * 86_400_000))
    .del()
    .catch(() => {})
  return { delivered, failed }
}

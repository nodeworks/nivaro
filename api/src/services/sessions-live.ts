import { getIo } from './io-holder.js'
import { opsRoom } from './ops-live.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Realtime round 9 (#23) — the person page's signed-in sessions and phones follow sign-ins,
 * sign-outs and revocations live, for administrators only.
 *
 * Every place a browser session or a phone sign-in starts or ends calls `noteSessionsChanged`
 * with the people it touched. Each person becomes one `ops:changed {topic: 'sessions', user_id}`
 * on the admin-gated `sessions` topic room (ops-live.ts; tenant-scoped in cloud mode). The event
 * names the PERSON only — never a session id, a prefix, a device, an address or a token — and a
 * person page open on that person re-reads its lists through the same admin routes as before.
 *
 * Emitted after a short settle: the rolling session store saves a new session at the end of the
 * request that signed it in, so a page that re-read at once could miss it.
 */

const SETTLE_MS = 500
/** A sign-out that touches more people than this says "someone changed" once instead. */
const MAX_PEOPLE_PER_NOTE = 50

/** People whose sessions changed (ids, any case) → the admin-only notices, deduplicated. */
export function sessionsChangedNotices(
  userIds: Array<string | null | undefined>
): Array<{ user_id: string } | { all: true }> {
  const ids = [...new Set(userIds.filter(Boolean).map((u) => String(u).toUpperCase()))]
  if (ids.length === 0) return []
  if (ids.length > MAX_PEOPLE_PER_NOTE) return [{ all: true }]
  return ids.map((user_id) => ({ user_id }))
}

/** Tell administrators watching these people that their sessions or phones changed. */
export function noteSessionsChanged(userIds: Array<string | null | undefined>): void {
  const notices = sessionsChangedNotices(userIds)
  if (notices.length === 0) return
  // The tenant is read now, in the caller's context, and carried to the timer.
  const room = opsRoom('sessions', currentTenantKey())
  const t = setTimeout(() => {
    try {
      const io = getIo()
      for (const n of notices)
        io?.to(room).emit('ops:changed', { topic: 'sessions', ...n, at: Date.now() })
    } catch {
      /* best-effort: a live notice never affects the sign-in or sign-out that caused it */
    }
  }, SETTLE_MS)
  t.unref?.()
}

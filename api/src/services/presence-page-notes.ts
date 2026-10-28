import { currentTenantKey } from './tenant-rooms.js'

/**
 * The Online list hears page changes (#page-change, 2026-10-28). A heartbeat that moves someone
 * to another page sends no collection:update (that was the 2026-10-23 refetch storm, see
 * collection-live-mode.ts); it adds the row to the socket server's coalesced presence:changed
 * instead — one event per tenant per 2–3 s carrying every changed id, and clients refresh at most
 * every ~10 s while busy.
 *
 * Sent after PRESENCE_ANSWER_TTL_MS (+ a margin): each replica keeps its /presence/online answer
 * that long, so a client refreshing on the event reads the new page from any replica, without
 * flushing those caches on every page change.
 */
const PRESENCE_ANSWER_TTL_MS = 1500
export const PAGE_NOTE_DELAY_MS = PRESENCE_ANSWER_TTL_MS + 250

export function notePresencePageChange(rowId: string, tenant = currentTenantKey()): void {
  const timer = setTimeout(() => {
    void import('../plugins/socketio.js')
      .then(({ notePresenceChanged }) => notePresenceChanged(tenant, [rowId]))
      .catch(() => {})
  }, PAGE_NOTE_DELAY_MS)
  timer.unref?.()
}

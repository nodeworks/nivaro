/**
 * Live signed-in sockets per person, for THIS process (presence bookkeeping in
 * plugins/socketio.ts).
 *
 * Module scope on purpose: the set used to live inside the per-connection
 * handler, so every socket had its own one-entry set and ANY tab's disconnect
 * (a network blip, a background tab the browser froze, one of two tabs
 * closing) wrote is_online=false for someone still looking at another tab.
 *
 * Keyed by user id — ids are UUIDs, so two cloud tenants never share a key in
 * practice; a socket id is unique per process.
 */

/** How often a live socket keeps its person's `last_seen` fresh. */
export const PRESENCE_REFRESH_MS = 25_000

const live = new Map<string, Set<string>>()

const keyOf = (userId: string) => userId.toUpperCase()

export function addPresenceSocket(userId: string, socketId: string): void {
  const key = keyOf(userId)
  const set = live.get(key) ?? new Set<string>()
  set.add(socketId)
  live.set(key, set)
}

/** Forget the socket. True when it was this person's last socket on this process. */
export function removePresenceSocket(userId: string, socketId: string): boolean {
  const key = keyOf(userId)
  const set = live.get(key)
  if (!set?.delete(socketId)) return false
  if (set.size > 0) return false
  live.delete(key)
  return true
}

/**
 * One socket per person refreshes `last_seen` — the oldest live one — so three
 * tabs on one process cost one write per tick, not three.
 */
export function isPresenceRefreshOwner(userId: string, socketId: string): boolean {
  const set = live.get(keyOf(userId))
  if (!set) return false
  return set.values().next().value === socketId
}

/** Tests only. */
export function resetPresenceSockets(): void {
  live.clear()
}

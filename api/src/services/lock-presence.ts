/**
 * Is the person holding an edit lock still actually here? (2026-10-28 — a lock outlived its
 * holder: an approver's save got 409 "Etien Gjoni is editing this record" with nobody on it.)
 *
 * Two signals, judged together everywhere a lock is judged (item-lock-guard.ts, the item-locks
 * routes, the Traffic Map lens):
 *
 *  1. The lease. Every acquire/heartbeat sets `expires_at = now + window` (LOCK_LIVE_MS for a
 *     client that declares its heartbeat, LEGACY_LOCK_TTL_MS for an older one), so
 *     `expires_at > now` already means "heartbeat seen within the window".
 *  2. Presence. When this process knows every signed-in socket of the deployment (its own
 *     sockets, plus a fresh realtime board — boardKnowsEveryone), a holder with NO socket at
 *     all is gone (tab closed, browser quit, View-as ended) and the lock is void, even inside
 *     its lease. Unknown (Redis away, board stale, cloud mode, no probe registered) = the lease
 *     alone decides: presence never invents a holder and never keeps a lapsed lock alive.
 *
 * A freshly taken lock is never judged by presence (the holder's socket may not have signed in
 * yet), nor one whose heartbeat is recent (a socket reconnect blip is not a departure). Absence
 * must LAST (2026-11-18, realtime audit H1): one snapshot of "no socket" is not enough — a
 * deploy drops every socket of the draining process and its users are off the board for the
 * 2–6 s their tabs take to reconnect, and a typing holder's lock was taken from them by a
 * co-viewer's poll in that window. The holder must have been seen nowhere (no socket by this
 * process's probe, no heartbeat, and this process up long enough to know) for
 * PRESENCE_ABSENCE_MS — longer than one heartbeat (10 s) plus the reconnect backoff.
 * The probe is registered by plugins/socketio.ts so this module stays a leaf (no socket graph in
 * the guard's import path).
 */

/** Window for a client that declares its heartbeat (beat ≤ MAX_DECLARED_BEAT_MS): 30 s. */
export const LOCK_LIVE_MS = 30_000
/** Window for a client that does not (built before 2026-10-28, heartbeat every 60 s). */
export const LEGACY_LOCK_TTL_MS = 150_000
/** The longest heartbeat interval a client may declare and still get the short window. */
export const MAX_DECLARED_BEAT_MS = 15_000
/** A lock this young is not judged by presence (socket sign-in races the acquire). */
export const PRESENCE_GRACE_MS = 15_000
/**
 * How long a holder must have been absent — no heartbeat AND no socket seen by this process,
 * AND this process up that long — before presence voids the lock. Longer than one heartbeat
 * (10 s) plus a reconnect after a deploy (2–6 s), so a holder who is typing never loses it.
 */
export const PRESENCE_ABSENCE_MS = 20_000
/** …nor one whose last heartbeat is this recent (= PRESENCE_ABSENCE_MS, kept for readers). */
export const PRESENCE_BEAT_GRACE_MS = PRESENCE_ABSENCE_MS

/** The lease an acquire/heartbeat grants: short when the client says it beats often. */
export function lockWindowMs(body: unknown): number {
  const beat = Number((body as { beat_ms?: unknown } | null | undefined)?.beat_ms)
  return Number.isFinite(beat) && beat > 0 && beat <= MAX_DECLARED_BEAT_MS
    ? LOCK_LIVE_MS
    : LEGACY_LOCK_TTL_MS
}

/**
 * When the holder last beat. The table has no heartbeat column: a lease longer than the short
 * window can only be a legacy one, so the window is told apart by what is left of it.
 */
export function lastHeartbeatAt(expiresAt: Date | string | number, now = Date.now()): Date {
  const exp = new Date(expiresAt).getTime()
  const window = exp - now > LOCK_LIVE_MS ? LEGACY_LOCK_TTL_MS : LOCK_LIVE_MS
  return new Date(exp - window)
}

/** true = has a socket somewhere, false = known to have none, null = cannot tell. */
type ConnectedProbe = (userId: string) => boolean | null
let probe: ConnectedProbe | null = null
/** When this process started judging: before PRESENCE_ABSENCE_MS has passed it cannot know. */
let judgingSince = Date.now()
/** user (upper-cased) → the last time this process's probe saw them connected. */
const lastSeenHere = new Map<string, number>()
const LAST_SEEN_MAX = 5_000

export function setLockPresenceProbe(fn: ConnectedProbe | null): void {
  probe = fn
}

/** Tests: when this process started judging presence, and forget who was seen. */
export function resetLockPresenceMemory(startedAt = Date.now()): void {
  judgingSince = startedAt
  lastSeenHere.clear()
}

/** A socket of `userId` was seen (probe answered true, or a socket signed in on this process). */
export function noteHolderSeen(userId: string, now = Date.now()): void {
  const key = String(userId).toUpperCase()
  lastSeenHere.delete(key)
  lastSeenHere.set(key, now)
  if (lastSeenHere.size > LAST_SEEN_MAX) {
    // Oldest first (Map keeps insertion order; a re-seen user was moved to the end).
    for (const k of lastSeenHere.keys()) {
      lastSeenHere.delete(k)
      if (lastSeenHere.size <= LAST_SEEN_MAX * 0.8) break
    }
  }
}

export interface JudgedLock {
  user: string
  locked_at?: Date | string | null
  expires_at: Date | string | number
}

/**
 * Is this lock held by someone who is still here? false = treat it as released (lapsed lease,
 * or a holder known to have left). Never throws.
 */
export function lockIsLive(lock: JudgedLock, now = Date.now()): boolean {
  const exp = new Date(lock.expires_at).getTime()
  if (!Number.isFinite(exp) || exp <= now) return false
  return !holderKnownGone(lock, now)
}

/**
 * The presence half alone: true only when the holder is KNOWN to have had no socket, and no
 * heartbeat, for PRESENCE_ABSENCE_MS (a reconnect blip or a deploy is not a departure).
 */
export function holderKnownGone(lock: JudgedLock, now = Date.now()): boolean {
  if (!probe) return false
  const lockedAt = lock.locked_at ? new Date(lock.locked_at).getTime() : Number.NaN
  if (!Number.isFinite(lockedAt) || now - lockedAt < PRESENCE_GRACE_MS) return false
  if (now - lastHeartbeatAt(lock.expires_at, now).getTime() < PRESENCE_BEAT_GRACE_MS) return false
  // This process has not been up long enough to know who left (a fresh boot after a deploy).
  if (now - judgingSince < PRESENCE_ABSENCE_MS) return false
  let here: boolean | null
  try {
    here = probe(String(lock.user))
  } catch {
    return false
  }
  if (here === true) {
    noteHolderSeen(lock.user, now)
    return false
  }
  if (here !== false) return false
  const seen = lastSeenHere.get(String(lock.user).toUpperCase())
  return seen === undefined || now - seen >= PRESENCE_ABSENCE_MS
}

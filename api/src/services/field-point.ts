/**
 * "Point Beth to this field" (realtime round 7, item 4).
 *
 * One person on a record asks another person who has the SAME record open right now to look
 * at one field. Nothing is stored: no comment, no notification row, no email or push. The
 * server only relays `field:pointed` to the target's sockets in the record room, and only
 * when
 *   - the sender sits in the record's room (the record read gate admitted them),
 *   - the target is in that room right now (this process's viewers or a peer's, via the
 *     realtime board),
 *   - both may read the field (the field read rules — services/field-signal-gate.ts),
 *   - the sender is inside the rate limit (a nudge is a tap on the shoulder, not a stream).
 *
 * The payload names the record, the field and the sender — never a value.
 */

/** One nudge per sender → target per this long. */
export const POINT_PAIR_GAP_MS = 5_000
/** And at most this many nudges per sender socket per minute. */
export const POINT_PER_MINUTE = 10

export type PointRefusal = 'rate' | 'self' | 'gone' | 'field'

export interface PointLimiter {
  /** May this socket point `to` now? Records the attempt when it may. */
  allow(to: string, now?: number): boolean
}

/** Per-socket limiter (pure apart from its own memory). */
export function createPointLimiter(
  opts: { pairGapMs?: number; perMinute?: number } = {}
): PointLimiter {
  const pairGap = opts.pairGapMs ?? POINT_PAIR_GAP_MS
  const perMinute = opts.perMinute ?? POINT_PER_MINUTE
  const lastByTarget = new Map<string, number>()
  let window: number[] = []
  return {
    allow(to, now = Date.now()) {
      const key = String(to).toUpperCase()
      const last = lastByTarget.get(key)
      if (last != null && now - last < pairGap) return false
      window = window.filter((t) => now - t < 60_000)
      if (window.length >= perMinute) return false
      window.push(now)
      lastByTarget.set(key, now)
      if (lastByTarget.size > 200) lastByTarget.clear()
      return true
    }
  }
}

export interface PointViewer {
  socket: string
  id: string
}

/**
 * The target's sockets among the record's viewers: every socket whose person is `to`, never the
 * sender's own socket. A person pointing at themselves (another tab) is refused by the caller.
 */
export function pointTargetSockets(
  viewers: readonly PointViewer[],
  to: string,
  senderSocket: string
): string[] {
  const want = String(to).toUpperCase()
  const out: string[] = []
  for (const v of viewers) {
    if (!v?.socket || v.socket === senderSocket) continue
    if (String(v.id).toUpperCase() !== want) continue
    if (!out.includes(v.socket)) out.push(v.socket)
  }
  return out
}

/** A user id the client may name as the target (uuid-ish / numeric), or null. */
export function cleanPointTarget(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return /^[A-Za-z0-9-]{1,64}$/.test(s) ? s : null
}

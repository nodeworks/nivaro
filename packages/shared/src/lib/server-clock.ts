/**
 * Server time (#2132). A machine whose clock drifts shows "2 minutes ago" for something that
 * just happened and runs countdowns early or late. The host measures the offset between this
 * clock and the server's when its socket connects (`measureClockOffset` over a few `time:sync`
 * round trips) and stores it here; relative labels and countdowns read `serverNow()` instead of
 * `Date.now()`. Zero until measured, so a host without a socket behaves exactly as before.
 */

let offsetMs = 0

/** Offsets smaller than this are noise (one round trip's jitter); they are not applied. */
const MIN_APPLIED_MS = 1000

/** The server's current time, in epoch milliseconds, as best this client knows it. */
export function serverNow(): number {
  return Date.now() + offsetMs
}

/** Milliseconds to add to this clock to get the server's (positive = this clock is behind). */
export function serverClockOffset(): number {
  return offsetMs
}

export function setServerClockOffset(ms: number): void {
  offsetMs = Number.isFinite(ms) && Math.abs(ms) >= MIN_APPLIED_MS ? Math.round(ms) : 0
}

export interface ClockSample {
  /** This client's clock when the request left. */
  sent: number
  /** The server's clock when it answered. */
  server: number
  /** This client's clock when the answer arrived. */
  received: number
}

/**
 * The offset from a few samples: the server stamped its answer somewhere inside the round
 * trip, so assume the midpoint, and trust the sample with the shortest round trip (the least
 * room for the stamp to sit off-centre). Null when no sample is usable.
 */
export function measureClockOffset(samples: ClockSample[]): number | null {
  let best: ClockSample | null = null
  for (const s of samples) {
    const rtt = s.received - s.sent
    if (!Number.isFinite(rtt) || rtt < 0 || !Number.isFinite(s.server)) continue
    if (!best || rtt < best.received - best.sent) best = s
  }
  if (!best) return null
  return best.server - (best.sent + (best.received - best.sent) / 2)
}

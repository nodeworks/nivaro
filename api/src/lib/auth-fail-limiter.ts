/**
 * Per-address counters for bearer-only internal routes (render peer, file source). In process,
 * per replica: a cheap brake on token guessing and runaway callers, not a quota.
 */

/** Failed bearer checks per address: past `limit` in a window the address is blocked. */
export function failedAuthLimiter(limit = 20, windowMs = 60_000) {
  const seen = new Map<string, { start: number; n: number }>()
  return {
    blocked(ip: string, now = Date.now()): boolean {
      const e = seen.get(ip)
      return !!e && now - e.start < windowMs && e.n >= limit
    },
    /** Counts one failure; true when it is the first of this window (log it). */
    fail(ip: string, now = Date.now()): boolean {
      if (seen.size > 5000) seen.clear()
      const e = seen.get(ip)
      if (!e || now - e.start >= windowMs) {
        seen.set(ip, { start: now, n: 1 })
        return true
      }
      e.n++
      return e.n === limit
    }
  }
}

/** Requests per address per window; `take` is false past `limit`. */
export function windowLimiter(limit: number, windowMs = 60_000) {
  const seen = new Map<string, { start: number; n: number }>()
  return {
    take(ip: string, now = Date.now()): boolean {
      if (seen.size > 5000) seen.clear()
      const e = seen.get(ip)
      if (!e || now - e.start >= windowMs) {
        seen.set(ip, { start: now, n: 1 })
        return true
      }
      e.n++
      return e.n <= limit
    }
  }
}

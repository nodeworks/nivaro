/**
 * Per-socket token buckets for inbound Socket.io events (M10).
 *
 * Every inbound event costs one token from its class's bucket; an event with no token left is
 * dropped (never dispatched to a handler). The limits are deliberately generous — a normal
 * tab, a shared worker carrying every tab of an app, a huddle starting up — must never meet
 * them; they exist so one socket cannot make the server run thousands of permission checks,
 * room joins or Redis writes a second.
 *
 *   auth      — sign-in attempts: 20 at once, then one every 3 s (each one reads the database)
 *   join      — `*:join`, `*:watch`, `page:at`, `catchup`: 300 at once, then 30/s
 *   signal    — `huddle:signal` (WebRTC offers/answers/ICE bursts): 1000 at once, then 200/s
 *   other     — everything else: 600 at once, then 100/s
 *
 * SOCKET_RATE_LIMIT=off turns it off; SOCKET_RATE_LIMIT_SCALE multiplies every bucket (e.g. 2).
 */

export interface BucketSpec {
  capacity: number
  refillPerSec: number
}

export type EventClass = 'auth' | 'join' | 'signal' | 'other'

export const SOCKET_BUCKETS: Record<EventClass, BucketSpec> = {
  auth: { capacity: 20, refillPerSec: 1 / 3 },
  join: { capacity: 300, refillPerSec: 30 },
  signal: { capacity: 1000, refillPerSec: 200 },
  other: { capacity: 600, refillPerSec: 100 }
}

export function eventClass(event: string): EventClass {
  if (event === 'auth') return 'auth'
  if (event === 'huddle:signal') return 'signal'
  if (
    event.endsWith(':join') ||
    event.endsWith(':watch') ||
    event === 'page:at' ||
    event === 'catchup'
  )
    return 'join'
  return 'other'
}

export function socketRateLimitOn(): boolean {
  return (process.env.SOCKET_RATE_LIMIT ?? 'on').toLowerCase() !== 'off'
}

function scale(): number {
  const n = Number(process.env.SOCKET_RATE_LIMIT_SCALE)
  return Number.isFinite(n) && n > 0 ? n : 1
}

interface Bucket {
  tokens: number
  at: number
}

/**
 * One socket's limiter. `allow(event)` takes a token and says whether the event may run;
 * `dropped` counts refusals (for a log line, never per event).
 */
export function createSocketLimiter(
  now: () => number = Date.now,
  specs: Record<EventClass, BucketSpec> = SOCKET_BUCKETS
) {
  const k = scale()
  const buckets = new Map<EventClass, Bucket>()
  let dropped = 0
  return {
    allow(event: string): boolean {
      const cls = eventClass(event)
      const spec = specs[cls]
      const cap = spec.capacity * k
      const t = now()
      let b = buckets.get(cls)
      if (!b) {
        b = { tokens: cap, at: t }
        buckets.set(cls, b)
      } else {
        b.tokens = Math.min(cap, b.tokens + ((t - b.at) / 1000) * spec.refillPerSec * k)
        b.at = t
      }
      if (b.tokens < 1) {
        dropped++
        return false
      }
      b.tokens -= 1
      return true
    },
    get dropped() {
      return dropped
    }
  }
}

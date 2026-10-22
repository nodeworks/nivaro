import type { HuddleRedis } from './huddle.js'

/**
 * Flood guards for huddle calls (security review 2026-10-21, finding 1). Ringing someone sends
 * a socket toast, a push and an inbox row (huddle-ring.ts), and starting / ending a huddle
 * posts a line in the room — so nothing a single person repeats may do either without limit.
 *
 * Ringing (per caller → callee, in Redis, tenant in every key):
 *  - after a decline, a missed call or a hang-up the same person cannot be rung again for
 *    RING_COOLDOWN_S;
 *  - at most RING_PAIR_MAX rings per caller → callee per RING_PAIR_WINDOW_S;
 *  - at most RING_CALLS_PER_MIN ring requests (an invite, or the call a direct-message huddle
 *    starts with) per caller per minute.
 * A refusal is never silent: the caller gets `huddle:ring-refused` with who and how long.
 *
 * Join / leave churn (per room): a huddle that ends and restarts within CHURN_REUSE_S is the
 * same huddle — it keeps its start time and posts no new "started" line — and when that
 * restart ends again inside the window it posts no "ended" line either. A restart in a direct
 * message still rings (the other person calling back must reach you); the ring guards above
 * are what stop a join/leave loop from ringing again. Start
 * and end lines are also capped at ROOM_LINES_MAX per room per ROOM_LINES_WINDOW_S.
 *
 * Counters use INCR + PEXPIRE where the client has them (ioredis does), so a burst of parallel
 * events counts exactly; test fakes without them fall back to get/set.
 */

export const RING_COOLDOWN_S = 30
export const RING_PAIR_MAX = 5
export const RING_PAIR_WINDOW_S = 600
export const RING_CALLS_PER_MIN = 6
export const CHURN_REUSE_S = 20
export const ROOM_LINES_MAX = 6
export const ROOM_LINES_WINDOW_S = 600

interface CounterRedis {
  incr(key: string): Promise<number>
  pexpire(key: string, ms: number): Promise<unknown>
  pttl(key: string): Promise<number>
}

type GuardRedis = Pick<HuddleRedis, 'get' | 'set' | 'del'> & Partial<CounterRedis>

const t = (tenant: string | null) => tenant || '-'
const up = (id: string) => String(id).toUpperCase()

export const ringGuardKeys = {
  cooldown: (tenant: string | null, from: string, to: string) =>
    `nvr:huddle:ring-cd:${t(tenant)}:${up(from)}:${up(to)}`,
  pair: (tenant: string | null, from: string, to: string) =>
    `nvr:huddle:ring-n:${t(tenant)}:${up(from)}:${up(to)}`,
  calls: (tenant: string | null, from: string) => `nvr:huddle:ring-rate:${t(tenant)}:${up(from)}`
}

/** Count one more in a fixed window; returns the count and the seconds until the window resets. */
async function bump(
  redis: GuardRedis,
  key: string,
  windowS: number,
  now: number
): Promise<{ n: number; resetS: number }> {
  if (redis.incr && redis.pexpire && redis.pttl) {
    const n = await redis.incr(key)
    let ttl = n === 1 ? -1 : await redis.pttl(key)
    // First hit, or a key that somehow lost its expiry: (re)start the window.
    if (ttl < 0) {
      await redis.pexpire(key, windowS * 1000)
      ttl = windowS * 1000
    }
    return { n, resetS: Math.max(1, Math.ceil(ttl / 1000)) }
  }
  let state: { n: number; until: number } | null = null
  try {
    const raw = await redis.get(key)
    state = raw ? (JSON.parse(raw) as { n: number; until: number }) : null
  } catch {
    state = null
  }
  const next =
    state && state.until > now
      ? { n: state.n + 1, until: state.until }
      : { n: 1, until: now + windowS * 1000 }
  await redis.set(key, JSON.stringify(next), 'EX', windowS)
  return { n: next.n, resetS: Math.max(1, Math.ceil((next.until - now) / 1000)) }
}

export type RingRefusalReason = 'cooldown' | 'limit' | 'rate'

/** One ring request by `from`: null = go ahead, else the seconds until they may ring again. */
export async function ringRateRefusal(
  redis: GuardRedis,
  tenant: string | null,
  from: string,
  now = Date.now()
): Promise<number | null> {
  const r = await bump(redis, ringGuardKeys.calls(tenant, from), 60, now)
  return r.n > RING_CALLS_PER_MIN ? r.resetS : null
}

/**
 * May `from` ring `to` now? Checks the cooldown, then counts this ring against the pair's
 * window. null = ring; otherwise why not and for how many seconds.
 */
export async function ringPairRefusal(
  redis: GuardRedis,
  tenant: string | null,
  from: string,
  to: string,
  now = Date.now()
): Promise<{ reason: RingRefusalReason; retry_in: number } | null> {
  const raw = await redis.get(ringGuardKeys.cooldown(tenant, from, to))
  const until = Number(raw)
  if (raw && Number.isFinite(until) && until > now) {
    return { reason: 'cooldown', retry_in: Math.max(1, Math.ceil((until - now) / 1000)) }
  }
  const r = await bump(redis, ringGuardKeys.pair(tenant, from, to), RING_PAIR_WINDOW_S, now)
  return r.n > RING_PAIR_MAX ? { reason: 'limit', retry_in: r.resetS } : null
}

/** A call to `to` ended without an answer (declined, missed, hung up): start the cooldown. */
export async function startRingCooldown(
  redis: GuardRedis,
  tenant: string | null,
  from: string,
  to: string,
  now = Date.now()
): Promise<void> {
  await redis.set(
    ringGuardKeys.cooldown(tenant, from, to),
    String(now + RING_COOLDOWN_S * 1000),
    'EX',
    RING_COOLDOWN_S
  )
}

// ── Join / leave churn ──────────────────────────────────────────────────────

function churnKeys(tenant: string | null, room: string) {
  const base = `nvr:huddle:${t(tenant)}:${room}`
  return { ended: `${base}:ended`, resumed: `${base}:resumed`, lines: `${base}:lines` }
}

/**
 * The first person is joining: was this room's huddle ended less than CHURN_REUSE_S ago?
 * Then it is the same huddle — returns its original start (and marks the restart, so ending
 * it again right away is quiet too); otherwise null (a new huddle).
 */
export async function resumeRecentHuddle(
  redis: GuardRedis,
  tenant: string | null,
  room: string,
  now = Date.now()
): Promise<{ start: number } | null> {
  const k = churnKeys(tenant, room)
  const raw = await redis.get(k.ended)
  if (!raw) return null
  let ended: { start?: unknown; at?: unknown }
  try {
    ended = JSON.parse(raw)
  } catch {
    return null
  }
  const at = Number(ended.at)
  const start = Number(ended.start)
  if (!Number.isFinite(at) || !Number.isFinite(start) || now - at >= CHURN_REUSE_S * 1000) {
    return null
  }
  await redis.del(k.ended)
  await redis.set(k.resumed, String(now), 'EX', CHURN_REUSE_S)
  return { start }
}

/**
 * The huddle ended: remember it for CHURN_REUSE_S (a quick restart resumes it). Returns true
 * when this was a restart that ended again inside the window — its "ended" line is skipped.
 */
export async function noteHuddleEnded(
  redis: GuardRedis,
  tenant: string | null,
  room: string,
  start: number,
  now = Date.now()
): Promise<boolean> {
  const k = churnKeys(tenant, room)
  const resumedAt = Number(await redis.get(k.resumed))
  await redis.del(k.resumed)
  await redis.set(k.ended, JSON.stringify({ start, at: now }), 'EX', CHURN_REUSE_S)
  return Number.isFinite(resumedAt) && resumedAt > 0 && now - resumedAt < CHURN_REUSE_S * 1000
}

/** May the room get one more start/end line in this window? */
export async function roomLineAllowed(
  redis: GuardRedis,
  tenant: string | null,
  room: string,
  now = Date.now()
): Promise<boolean> {
  const r = await bump(redis, churnKeys(tenant, room).lines, ROOM_LINES_WINDOW_S, now)
  return r.n <= ROOM_LINES_MAX
}

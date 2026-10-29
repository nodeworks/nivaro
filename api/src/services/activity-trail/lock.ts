import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { getApp } from '../io-holder.js'
import { currentTenantKey } from '../tenant-rooms.js'

/**
 * One writer of the activity chain at a time (#16): the sealer, a verification batch and a
 * retention purge batch all take this lock. Across processes it is a Redis key
 * (nvr:activity-trail:lock:<tenant>, SET NX PX, released only by its owner); inside a process
 * an in-memory flag per tenant also guards it (Redis down, CLI scripts, tests).
 *
 * Holds are short (one sealer tick, one purge or verify batch) — long work takes it per batch.
 */
const LOCK_TTL_MS = 2 * 60_000
const held = new Set<string>()

const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

function lockKey(tenant: string): string {
  return `nvr:activity-trail:lock:${tenant}`
}

let override: Redis | null = null

/** A process without the app (a CLI script) hands its own client in, so it shares the lock. */
export function setTrailLockRedis(r: Redis | null): void {
  override = r
}

function redis(): Redis | undefined {
  if (override) return override
  try {
    return (getApp()?.redis as Redis | undefined) ?? undefined
  } catch {
    return undefined
  }
}

export class TrailBusyError extends Error {
  constructor() {
    super('The activity trail is busy (sealing, verifying or purging) — try again shortly')
    this.name = 'TrailBusyError'
  }
}

async function tryAcquire(tenant: string): Promise<string | null> {
  if (held.has(tenant)) return null
  held.add(tenant)
  const token = randomUUID()
  const r = redis()
  if (r) {
    const ok = await r.set(lockKey(tenant), token, 'PX', LOCK_TTL_MS, 'NX').catch(() => 'OK')
    if (ok !== 'OK') {
      held.delete(tenant)
      return null
    }
  }
  return token
}

async function release(tenant: string, token: string): Promise<void> {
  held.delete(tenant)
  const r = redis()
  if (r) await r.eval(RELEASE_LUA, 1, lockKey(tenant), token).catch(() => 0)
}

/**
 * Run fn under the trail lock. waitMs = how long to keep asking when it is held (0 = once);
 * throws TrailBusyError when it never frees.
 */
export async function withTrailLock<T>(fn: () => Promise<T>, waitMs = 0): Promise<T> {
  const tenant = currentTenantKey()
  const deadline = Date.now() + waitMs
  let token = await tryAcquire(tenant)
  while (!token && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    token = await tryAcquire(tenant)
  }
  if (!token) throw new TrailBusyError()
  try {
    return await fn()
  } finally {
    await release(tenant, token)
  }
}

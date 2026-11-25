import { randomUUID } from 'node:crypto'
import { registerAppKeyed } from '../../app-forget.js'
import { currentTenantKey } from '../../tenant-rooms.js'
import { appPromoteRedis, type PromoteRedis } from '../promote-lock.js'

/**
 * Scale plans of stacks whose databases live on the same server are serialised: whoever plans
 * and starts a change holds `nvr:hub:scale-server:<tenant>:<serverId>` (SET NX PX 30 s,
 * compare-and-delete on release) from the plan until its run row — the reservation the next plan
 * counts (target.ts otherLoads reads every open run's target numbers) — exists. Two plans at once
 * therefore never both pass against the same headroom. Hub mode is never multi-tenant, but the
 * key carries the tenant key all the same ('' self-hosted).
 */

export const SERVER_LOCK_TTL_MS = 30_000
const WAIT_MS = 10_000
const POLL_MS = 100

export function scaleServerLockKey(serverId: number): string {
  return `nvr:hub:scale-server:${currentTenantKey() || '-'}:${serverId}`
}

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export interface ServerLock {
  take(serverId: number): Promise<string | null>
  release(serverId: number, token: string): Promise<void>
}

export function redisServerLock(redis: PromoteRedis): ServerLock {
  return {
    async take(serverId) {
      const token = randomUUID()
      const ok = await redis.set(
        scaleServerLockKey(serverId),
        token,
        'PX',
        SERVER_LOCK_TTL_MS,
        'NX'
      )
      return ok === 'OK' ? token : null
    },
    async release(serverId, token) {
      await Promise.resolve(
        redis.eval(RELEASE_SCRIPT, 1, scaleServerLockKey(serverId), token)
      ).catch(() => undefined)
    }
  }
}

/** No Redis (a single-process dev Hub, tests): the same lock in this process only. */
const memLocks = registerAppKeyed(new Map<string, { token: string; until: number }>())
export const memoryServerLock: ServerLock = {
  async take(serverId) {
    const key = scaleServerLockKey(serverId)
    const held = memLocks.get(key)
    if (held && held.until > Date.now()) return null
    const token = randomUUID()
    memLocks.set(key, { token, until: Date.now() + SERVER_LOCK_TTL_MS })
    return token
  },
  async release(serverId, token) {
    const key = scaleServerLockKey(serverId)
    if (memLocks.get(key)?.token === token) memLocks.delete(key)
  }
}

export function defaultServerLock(): ServerLock {
  const redis = appPromoteRedis()
  return redis ? redisServerLock(redis) : memoryServerLock
}

/**
 * Runs `work` holding the lock of every server (lowest id first, so two callers never wait on
 * each other in a circle). Waits up to 10 s for a server another plan holds; null = it stayed
 * held (the caller refuses SERVER_BUSY). A Redis that cannot be reached refuses too.
 */
export async function withServerLocks<T>(
  serverIds: number[],
  work: () => Promise<T>,
  lock: ServerLock = defaultServerLock(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<{ held: true; value: T } | { held: false }> {
  const ids = [...new Set(serverIds)].sort((a, b) => a - b)
  const taken: Array<{ id: number; token: string }> = []
  try {
    for (const id of ids) {
      const until = Date.now() + WAIT_MS
      let token: string | null = null
      for (;;) {
        try {
          token = await lock.take(id)
        } catch {
          return { held: false }
        }
        if (token || Date.now() > until) break
        await sleep(POLL_MS)
      }
      if (!token) return { held: false }
      taken.push({ id, token })
    }
    return { held: true, value: await work() }
  } finally {
    for (const t of taken.reverse()) await lock.release(t.id, t.token)
  }
}

/** Test seam: forget every in-process lock. */
export function _resetServerLocksForTests(): void {
  memLocks.clear()
}

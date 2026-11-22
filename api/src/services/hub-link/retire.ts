import type { Redis } from 'ioredis'
import { getApp } from '../io-holder.js'

/**
 * Nivaro Hub phase 6 (Decision 10): a dedicated app the Hub moved away is RETIRED over its hub
 * link. While retired it fires no scheduled job (cronTicksEnabled() is false), refuses new socket
 * connections, and answers `503 APP_MOVED` on every path except the hub link, the file transfer
 * and the probes (`retiredExemptPath`). The state lives in this app's own Redis
 * (`nvr:hub:retired` = `{move_id, at}`), so it survives restarts and every replica follows it
 * within one refresh (5 s). DELETE /api/hub-link/retire clears it: a move back onto the same
 * stack calls it at `target_ready` (ruling B9).
 *
 * Leaf on purpose: cron-ticks.ts reads `isRetiredSync()`, and only io-holder (itself a leaf) is
 * imported here. Without HUB_TOKEN nothing ever sets the flag, so cloud and plain self-hosted
 * processes always read false.
 */

export const RETIRED_KEY = 'nvr:hub:retired'
export const APP_MOVED = 'APP_MOVED'
const REFRESH_MS = 5_000

let retired = false
let timer: ReturnType<typeof setInterval> | null = null
let watched: Redis | null = null

/** The in-memory flag (refreshed from Redis every 5 s and at boot). */
export function isRetiredSync(): boolean {
  return retired
}

function appRedis(): Redis | null {
  try {
    return (getApp()?.redis as Redis | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * Leaving the retired state: the cron plugin competes for the scheduler lease only when ticks
 * were on at boot, so a process that booted retired would never fire again. Start competing now
 * (CronLeader.start is safe to call twice: its renew timer is kept).
 */
function rejoinScheduler(redis: Redis | null): void {
  try {
    const app = getApp()
    if (redis && app?.cron?.startLeaderElection) app.cron.startLeaderElection(redis)
  } catch {
    /* best-effort: the next restart competes anyway */
  }
}

function apply(next: boolean, redis: Redis | null): void {
  const was = retired
  retired = next
  if (was && !next) rejoinScheduler(redis)
}

/** Read the flag from Redis once. A Redis error keeps the last known state. */
export async function refreshRetired(redis: Redis | null = watched ?? appRedis()): Promise<void> {
  if (!redis) return
  try {
    const raw = (await redis.get(RETIRED_KEY)) as string | null
    apply(!!raw, redis)
  } catch {
    /* keep the last known state */
  }
}

/** Boot (index.ts): read the flag now, then every 5 s. Only where the hub link is mounted. */
export async function startRetiredWatch(redis: Redis): Promise<void> {
  watched = redis
  await refreshRetired(redis)
  if (!timer) {
    timer = setInterval(() => {
      refreshRetired(redis).catch(() => {})
    }, REFRESH_MS)
    timer.unref?.()
  }
}

/**
 * Retire this app (`{move_id}`) or bring it back (`null`). Persists in Redis first, then flips
 * this process at once; the other replicas follow within 5 s. Throws when Redis is missing or
 * refuses the write (the route answers 503): a retire that does not persist would undo itself
 * at the next restart.
 */
export async function setRetired(on: { move_id: number } | null): Promise<void> {
  const redis = watched ?? appRedis()
  if (!redis) throw new Error('Redis is not available')
  if (on) {
    await redis.set(
      RETIRED_KEY,
      JSON.stringify({ move_id: on.move_id, at: new Date().toISOString() })
    )
  } else {
    await redis.del(RETIRED_KEY)
  }
  apply(!!on, redis)
}

/**
 * Paths a retired app still answers: the hub link itself (status, retire, maintenance), the file
 * transfer the move's target pulls from, and the probes a proxy or the Hub reads.
 */
export function retiredExemptPath(url: string): boolean {
  return (
    url.startsWith('/api/hub-link/') ||
    url.startsWith('/api/hub-transfer/') ||
    /^\/api\/(version|ready|health)(\?|$)/.test(url)
  )
}

export const APP_MOVED_MESSAGE =
  'This app has moved to another server. Reload the page to reach it at its new home.'

/** Tests only. */
export function _resetRetiredForTests(state = false): void {
  retired = state
  watched = null
  if (timer) clearInterval(timer)
  timer = null
}

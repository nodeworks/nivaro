import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { endEndlessStreams } from '../../lib/drain-streams.js'
import { getApp } from '../io-holder.js'

/**
 * Nivaro Hub phase 6 (Decision 10): a dedicated app the Hub moved away is RETIRED over its hub
 * link. While retired it serves and drains nothing:
 *  - every path but the hub link, the file transfer and the probes answers `503 APP_MOVED`
 *    (`retiredExemptPath`; the web root preHandler and the realtime process's onRequest);
 *  - no new socket.io / graphql-ws connection, and the ones open are closed on retire, along
 *    with every endless SSE stream (live events, view streams, GraphQL over SSE, MCP live);
 *  - no scheduled job ticks (cronTicksEnabled()), and the drainers that claim shared rows outside
 *    the ticks (help-video renders, staged imports, exports, media hand-offs, reminder timers)
 *    take nothing.
 *
 * The state lives in this app's own Redis, so it survives restarts and every replica follows it
 * within one refresh (5 s). The key is per app (`retiredKey()`: REDIS_CHANNEL_PREFIX + a short
 * hash of HUB_TOKEN), so two apps sharing one Redis database never retire each other. DELETE
 * /api/hub-link/retire clears it: a move back onto the same stack calls it at `target_ready`
 * (ruling B9).
 *
 * Boot reads the flag before serving and retries a few times; when Redis never answers the state
 * is UNKNOWN and the process acts retired (fails closed, code APP_STATE_UNKNOWN) until a read
 * succeeds — a retired app whose Redis was briefly away must not come back serving.
 *
 * Leaf on purpose: cron-ticks.ts reads `isRetiredSync()`; only leaves are imported here. Without
 * HUB_TOKEN nothing ever sets the flag, so cloud and plain self-hosted processes always read
 * false.
 */

export const APP_MOVED = 'APP_MOVED'
export const APP_STATE_UNKNOWN = 'APP_STATE_UNKNOWN'
const REFRESH_MS = 5_000
const BOOT_TRIES = 3
const BOOT_RETRY_MS = 1_000

type State = 'no' | 'yes' | 'unknown'
let state: State = 'no'
let timer: ReturnType<typeof setInterval> | null = null
let watched: Redis | null = null
let bootRetryMs = BOOT_RETRY_MS
const listeners = new Set<() => void>()

/** This app's key tag: a short one-way hash of HUB_TOKEN (never the token). */
export function hubLinkKeyTag(env: NodeJS.ProcessEnv = process.env): string {
  return createHash('sha256')
    .update((env.HUB_TOKEN ?? '').trim())
    .digest('hex')
    .slice(0, 16)
}

/** `<REDIS_CHANNEL_PREFIX>nvr:hub:retired:<tag>` — per app, so a shared Redis db is safe. */
export function retiredKey(env: NodeJS.ProcessEnv = process.env): string {
  return `${(env.REDIS_CHANNEL_PREFIX ?? '').trim()}nvr:hub:retired:${hubLinkKeyTag(env)}`
}

/** True while retired, and while the state is unknown (fail closed). */
export function isRetiredSync(): boolean {
  return state !== 'no'
}

/** 'yes' (moved away), 'unknown' (Redis never answered since boot) or 'no'. */
export function retiredState(): State {
  return state
}

/** Run `fn` each time this process enters the retired state (close what is open). */
export function onRetired(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
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

function apply(next: State, redis: Redis | null): void {
  const was = state
  state = next
  if (was !== 'no' && next === 'no') {
    rejoinScheduler(redis)
    // Help-video renders this process set aside while retired (lazy: this module stays a leaf).
    void import('../help-video-render.js').then((m) => m.resumeRendersAfterRetire()).catch(() => {})
  }
  if (was === 'no' && next !== 'no') {
    // Close what is already open: SSE subscriptions here, sockets through the listeners.
    try {
      endEndlessStreams()
    } catch {
      /* best-effort */
    }
    for (const fn of listeners) {
      try {
        fn()
      } catch {
        /* one listener never stops the others */
      }
    }
  }
}

async function readOnce(redis: Redis): Promise<State> {
  const raw = (await redis.get(retiredKey())) as string | null
  return raw ? 'yes' : 'no'
}

/** Read the flag from Redis once. A Redis error keeps the last known state. */
export async function refreshRetired(redis: Redis | null = watched ?? appRedis()): Promise<void> {
  if (!redis) return
  try {
    apply(await readOnce(redis), redis)
  } catch {
    /* keep the last known state ('unknown' stays unknown until a read succeeds) */
  }
}

/**
 * Boot (index.ts): read the flag before serving (a few tries), then every 5 s. Only where the
 * hub link is mounted. When every boot read fails the state is 'unknown' (acts retired).
 */
export async function startRetiredWatch(redis: Redis): Promise<void> {
  watched = redis
  let read: State | null = null
  for (let i = 0; i < BOOT_TRIES && read === null; i++) {
    try {
      read = await readOnce(redis)
    } catch {
      if (i < BOOT_TRIES - 1) await new Promise((r) => setTimeout(r, bootRetryMs))
    }
  }
  apply(read ?? 'unknown', redis)
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
      retiredKey(),
      JSON.stringify({ move_id: on.move_id, at: new Date().toISOString() })
    )
  } else {
    await redis.del(retiredKey())
  }
  apply(on ? 'yes' : 'no', redis)
}

/**
 * The path a router would match: query and fragment dropped, percent-encoding decoded once,
 * repeated slashes collapsed, a trailing slash dropped, lower-cased. Null when it cannot be
 * decoded (callers then never exempt it).
 */
export function normalizedPath(url: string): string | null {
  const raw = url.split('?')[0].split('#')[0]
  let p: string
  try {
    p = decodeURIComponent(raw)
  } catch {
    return null
  }
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p.toLowerCase()
}

/**
 * Is this the first-administrator route of the hub link, however the path is spelled
 * (`first%2Dadmin`, `//first-admin`, a trailing slash)? The matched route wins when Fastify has
 * one (`req.routeOptions.url`); an undecodable path counts as it (never exempt).
 */
export function isHubLinkFirstAdmin(url: string, routeUrl?: string | null): boolean {
  if (routeUrl && /\/hub-link\/first-admin\/?$/i.test(routeUrl)) return true
  const p = normalizedPath(url)
  if (p === null) return true
  return p === '/api/hub-link/first-admin' || p.startsWith('/api/hub-link/first-admin/')
}

/**
 * The hub-link routes that write the app's own data (a person, a template's schema, settings)
 * rather than steer a move: the first administrator, since Hub enhancement 24 the template install
 * (`/hub-link/template`, its status reads included) and since Hub providers Task 13 the settings
 * a managed resource's outputs set (`/hub-link/settings/apply`). Frozen by maintenance and refused once
 * retired, however the path is spelled; an undecodable path counts as one (never exempt).
 */
export function isHubLinkAppWrite(url: string, routeUrl?: string | null): boolean {
  if (isHubLinkFirstAdmin(url, routeUrl)) return true
  // Hub providers (Task 13): /hub-link/settings/apply writes the app's own settings too.
  if (routeUrl && /\/hub-link\/(template|settings)(\/|$)/i.test(routeUrl)) return true
  const p = normalizedPath(url)
  if (p === null) return true
  return (
    p === '/api/hub-link/template' ||
    p.startsWith('/api/hub-link/template/') ||
    p === '/api/hub-link/settings' ||
    p.startsWith('/api/hub-link/settings/')
  )
}

/**
 * Paths a retired app still answers: the Hub's own hub-link calls (status, retire, maintenance,
 * readiness, file tickets — never the first administrator, which writes a person; judged on the
 * matched route or the decoded path), the file transfer the move's target pulls from, and the
 * probes a proxy or the Hub reads. The prefixes are tested on the raw URL: a spelling that hides
 * them is simply not exempt (fails closed).
 */
export function retiredExemptPath(url: string, routeUrl?: string | null): boolean {
  return (
    (url.startsWith('/api/hub-link/') && !isHubLinkAppWrite(url, routeUrl)) ||
    url.startsWith('/api/hub-transfer/') ||
    /^\/api\/(version|ready|health)(\?|$)/.test(url)
  )
}

export const APP_MOVED_MESSAGE =
  'This app has moved to another server. Reload the page to reach it at its new home.'
export const APP_STATE_UNKNOWN_MESSAGE =
  'This app cannot confirm where it runs right now. Try again in a minute.'

/** The refusal a retired (or unknown) process answers with. */
export function retiredRefusalBody(): {
  statusCode: 503
  error: string
  message: string
  code: string
} {
  const unknown = state === 'unknown'
  const message = unknown ? APP_STATE_UNKNOWN_MESSAGE : APP_MOVED_MESSAGE
  return { statusCode: 503, error: message, message, code: unknown ? APP_STATE_UNKNOWN : APP_MOVED }
}

/** Tests only. */
export function _resetRetiredForTests(
  next: State | boolean = 'no',
  opts: { bootRetryMs?: number } = {}
): void {
  state = next === true ? 'yes' : next === false ? 'no' : next
  watched = null
  bootRetryMs = opts.bootRetryMs ?? BOOT_RETRY_MS
  if (timer) clearInterval(timer)
  timer = null
}

/** Tests only: drop every onRetired listener. */
export function _clearRetiredListenersForTests(): void {
  listeners.clear()
}

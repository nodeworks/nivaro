import { type FetchJsonOptions, fetchJson } from '../gitlab-client.js'
import { openSecret } from './secrets.js'

/**
 * Hub side: how is one environment of an app doing? Read-only, never signs in as a person,
 * never reads records.
 *
 *  - Environment with a hub token: GET {base_url}/api/hub-link/status with the opened token.
 *    401 (or 404: the app has no hub link) = link_refused — never a fallback to the public
 *    routes, so a broken link is seen instead of hidden. A token that cannot be opened
 *    (wrong ENCRYPTION_KEY, a plain value) = link_refused with the secret's code: an admin
 *    re-enters it.
 *  - Without one: GET {base_url}/api/version + /api/health (public verdict only).
 *  - Every request has HUB_STATUS_TIMEOUT_MS (8 s), outer bound included; a timeout or network
 *    error = unreachable. The bearer call refuses redirects (HUB_LINK_REDIRECT = link_refused).
 *    Worst case per environment: the 300 ms cache read + 8 s; the cache write is not awaited.
 *  - Answers are cached per environment in Redis (nvr:hub:status:<id>, 30 s); `fresh` skips the
 *    read. No Redis, or Redis down = no cache, never a failed read.
 */

export type HubEnvState = 'ok' | 'degraded' | 'unreachable' | 'link_refused'

export interface HubEnvStatus {
  state: HubEnvState
  version: string | null
  preflight: string | null
  checked_at: string
  source: 'hub-link' | 'public'
  error?: string
}

/** The fields of a nivaro_hub_environments row the status read needs. */
export interface HubStatusTarget {
  id: number
  key?: string
  base_url: string
  hub_token: string | null
}

export interface StatusCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
}

export interface StatusOptions {
  /** Skip the cached answer (the route's ?fresh=1). */
  fresh?: boolean
  /** The app's Redis client; null/absent = no cache. */
  redis?: StatusCache | null
  /** Per-request timeout; tests pass a short one. */
  timeoutMs?: number
}

export const HUB_STATUS_TTL_S = 30
export const HUB_STATUS_TIMEOUT_MS = 8000
/** A cache read or write that takes longer than this is skipped. */
const CACHE_TIMEOUT_MS = 300

export function hubStatusKey(envId: number | string): string {
  return `nvr:hub:status:${envId}`
}

class Deadline extends Error {
  constructor() {
    super('deadline')
    this.name = 'AbortError'
  }
}

/** Resolves like `p`, or rejects with an AbortError after `ms` (a hung call never holds us). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Deadline()), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function baseOf(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    u.search = ''
    u.hash = ''
    return u.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

async function get(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  opts: FetchJsonOptions = {}
) {
  // fetchJson aborts at timeoutMs itself; the same outer bound covers a call that ignores its
  // signal (a body that never ends), so no read outlasts timeoutMs.
  return within(fetchJson(url, headers, timeoutMs, opts), timeoutMs)
}

async function readLinked(
  base: string,
  stored: string,
  timeoutMs: number,
  at: () => string
): Promise<HubEnvStatus> {
  const empty = { version: null, preflight: null, source: 'hub-link' as const }
  let token: string | null
  try {
    token = openSecret(stored)
  } catch (err) {
    const code = str((err as { code?: unknown } | null)?.code) ?? 'HUB_SECRET_UNREADABLE'
    return { state: 'link_refused', ...empty, checked_at: at(), error: code }
  }
  if (!token)
    return { state: 'link_refused', ...empty, checked_at: at(), error: 'HUB_SECRET_UNREADABLE' }

  let res: Awaited<ReturnType<typeof fetchJson>>
  try {
    res = await get(
      `${base}/api/hub-link/status`,
      { Accept: 'application/json', Authorization: `Bearer ${token}` },
      timeoutMs,
      // The bearer never follows a redirect to another host.
      { redirect: 'error' }
    )
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FETCH_REDIRECT') {
      return { state: 'link_refused', ...empty, checked_at: at(), error: 'HUB_LINK_REDIRECT' }
    }
    return {
      state: 'unreachable',
      ...empty,
      checked_at: at(),
      error: isTimeout(err) ? 'TIMEOUT' : 'UNREACHABLE'
    }
  }
  const refusedCode = (res.body as { code?: unknown } | null)?.code
  // 429 HUB_LINK_REFUSED = the app's failed-token brake: the token is still the problem.
  if (
    res.status === 401 ||
    res.status === 403 ||
    (res.status === 429 && refusedCode === 'HUB_LINK_REFUSED')
  ) {
    return { state: 'link_refused', ...empty, checked_at: at(), error: 'HUB_LINK_REFUSED' }
  }
  if (res.status === 404) {
    // The app answers but has no hub link (HUB_TOKEN unset there).
    return { state: 'link_refused', ...empty, checked_at: at(), error: 'HUB_LINK_MISSING' }
  }
  if (!res.ok) {
    return { state: 'degraded', ...empty, checked_at: at(), error: `HTTP_${res.status}` }
  }
  const body = (res.body ?? {}) as { version?: unknown; preflight?: { status?: unknown } }
  const preflight = str(body.preflight?.status)
  return {
    state: preflight === 'ok' || preflight === 'warn' ? 'ok' : 'degraded',
    version: str(body.version),
    preflight,
    checked_at: at(),
    source: 'hub-link'
  }
}

async function readPublic(
  base: string,
  timeoutMs: number,
  at: () => string
): Promise<HubEnvStatus> {
  const headers = { Accept: 'application/json' }
  const [version, health] = await Promise.allSettled([
    get(`${base}/api/version`, headers, timeoutMs),
    get(`${base}/api/health`, headers, timeoutMs)
  ])
  const empty = { version: null, preflight: null, source: 'public' as const }
  if (version.status === 'rejected' || health.status === 'rejected') {
    const err =
      version.status === 'rejected' ? version.reason : (health as PromiseRejectedResult).reason
    return {
      state: 'unreachable',
      ...empty,
      checked_at: at(),
      error: isTimeout(err) ? 'TIMEOUT' : 'UNREACHABLE'
    }
  }
  const vBody = (version.value.body ?? {}) as { version?: unknown }
  const hBody = (health.value.body ?? {}) as { status?: unknown; version?: unknown }
  const v = (version.value.ok ? str(vBody.version) : null) ?? str(hBody.version)
  const verdict = str(hBody.status)
  const healthy = health.value.ok && verdict === 'ok'
  return {
    state: healthy ? 'ok' : 'degraded',
    version: v,
    preflight: null,
    checked_at: at(),
    source: 'public',
    ...(healthy
      ? {}
      : {
          error: health.value.ok ? `HEALTH_${verdict ?? 'unknown'}` : `HTTP_${health.value.status}`
        })
  }
}

async function cacheGet(redis: StatusCache, key: string): Promise<HubEnvStatus | null> {
  try {
    const raw = await within(redis.get(key), CACHE_TIMEOUT_MS)
    if (!raw) return null
    const v = JSON.parse(raw) as HubEnvStatus
    return v && typeof v.state === 'string' ? v : null
  } catch {
    return null
  }
}

async function cacheSet(redis: StatusCache, key: string, value: HubEnvStatus): Promise<void> {
  try {
    await within(redis.set(key, JSON.stringify(value), 'EX', HUB_STATUS_TTL_S), CACHE_TIMEOUT_MS)
  } catch {
    /* no cache this time */
  }
}

/** The status of one environment (cached 30 s unless `fresh`). Never throws. */
export async function readEnvironmentStatus(
  env: HubStatusTarget,
  opts: StatusOptions = {}
): Promise<HubEnvStatus> {
  const redis = opts.redis ?? null
  const key = hubStatusKey(env.id)
  if (redis && !opts.fresh) {
    const hit = await cacheGet(redis, key)
    if (hit) return hit
  }
  const timeoutMs = opts.timeoutMs ?? HUB_STATUS_TIMEOUT_MS
  const at = () => new Date().toISOString()
  const base = baseOf(env.base_url)
  let status: HubEnvStatus
  if (!base) {
    status = {
      state: 'unreachable',
      version: null,
      preflight: null,
      checked_at: at(),
      source: env.hub_token ? 'hub-link' : 'public',
      error: 'BAD_BASE_URL'
    }
  } else if (env.hub_token) {
    status = await readLinked(base, env.hub_token, timeoutMs, at)
  } else {
    status = await readPublic(base, timeoutMs, at)
  }
  // Not awaited: a slow Redis never holds the answer.
  if (redis) void cacheSet(redis, key, status)
  return status
}

export interface AppEnvStatus {
  id: number
  key: string | null
  status: HubEnvStatus
}

/**
 * Every environment of an app, side by side: one slow environment never holds the others past
 * its own timeout. Order follows `envs`.
 */
export async function readAppStatus(
  envs: HubStatusTarget[],
  opts: StatusOptions = {}
): Promise<AppEnvStatus[]> {
  const settled = await Promise.allSettled(envs.map((e) => readEnvironmentStatus(e, opts)))
  return settled.map((r, i) => ({
    id: envs[i].id,
    key: envs[i].key ?? null,
    status:
      r.status === 'fulfilled'
        ? r.value
        : {
            state: 'unreachable',
            version: null,
            preflight: null,
            checked_at: new Date().toISOString(),
            source: envs[i].hub_token ? 'hub-link' : 'public',
            error: 'UNREACHABLE'
          }
  }))
}

import { fetchJson } from '../../gitlab-client.js'
import { HUB_STATUS_TIMEOUT_MS } from '../status.js'

/**
 * One uptime probe of one environment: its PUBLIC GET {base}/api/version, and GET {base}/api/ready
 * beside it. No bearer, no person, no records — the same reach and rules as the Hub's public status
 * read (services/hub/status.ts): an http(s) origin only (the admin-entered base_url), the same
 * per-request timeout (HUB_STATUS_TIMEOUT_MS, outer bound included), a timeout or network error =
 * down. Redirects are followed exactly as the public status read follows them (no secret rides).
 *
 * Up = /api/version answers 2xx with a version AND /api/ready did not say "not ready" (503 or any
 * other non-2xx). A 404 on /api/ready (an app too old to have it) or an unreachable ready while
 * the version answered reads as "ready unknown" (null) and does not count against it.
 */

export interface ProbeSample {
  up: boolean
  version_ok: boolean
  ready: boolean | null
  /** How long /api/version took, ms (null when it never answered). */
  ms: number | null
  /** Why it is not up: TIMEOUT, UNREACHABLE, HTTP_<n>, NO_VERSION, NOT_READY, BAD_BASE_URL. */
  code: string | null
  version: string | null
}

export type ProbeFetch = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
) => Promise<{ ok: boolean; status: number; body: unknown }>

export interface ProbeDeps {
  fetch?: ProbeFetch
  timeoutMs?: number
  clock?: () => number
}

/** http(s) origin of a base URL, no trailing slash; null for anything else. */
export function probeBase(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/** `p`, or a rejection with an AbortError after `ms` (a hung body never holds the tick). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error('deadline'), { name: 'AbortError' })),
        ms
      )
    })
  ]).finally(() => clearTimeout(timer))
}

export async function probeEnvironment(
  baseUrl: string,
  deps: ProbeDeps = {}
): Promise<ProbeSample> {
  const base = probeBase(baseUrl)
  if (!base)
    return {
      up: false,
      version_ok: false,
      ready: null,
      ms: null,
      code: 'BAD_BASE_URL',
      version: null
    }
  const get = deps.fetch ?? fetchJson
  const timeoutMs = deps.timeoutMs ?? HUB_STATUS_TIMEOUT_MS
  const clock = deps.clock ?? Date.now
  const headers = { Accept: 'application/json' }
  const started = clock()
  const timed = async () => {
    const res = await within(get(`${base}/api/version`, headers, timeoutMs), timeoutMs)
    return { res, ms: Math.max(0, Math.round(clock() - started)) }
  }
  const [v, r] = await Promise.allSettled([
    timed(),
    within(get(`${base}/api/ready`, headers, timeoutMs), timeoutMs)
  ])

  if (v.status === 'rejected')
    return {
      up: false,
      version_ok: false,
      ready: null,
      ms: null,
      code: isTimeout(v.reason) ? 'TIMEOUT' : 'UNREACHABLE',
      version: null
    }
  const { res, ms } = v.value
  const raw = (res.body as { version?: unknown } | null)?.version
  const version = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : null
  const versionOk = res.ok && !!version
  let ready: boolean | null = null
  if (r.status === 'fulfilled') {
    if (r.value.ok) ready = true
    else if (r.value.status !== 404) ready = false
  }
  const up = versionOk && ready !== false
  return {
    up,
    version_ok: versionOk,
    ready,
    ms,
    code: up ? null : !res.ok ? `HTTP_${res.status}` : !version ? 'NO_VERSION' : 'NOT_READY',
    version
  }
}

/** Runs `work` over `items`, at most `width` at once, stopping new starts once `stopAt` passes. */
export async function eachBounded<T>(
  items: T[],
  width: number,
  work: (item: T) => Promise<void>,
  stopAt: number,
  clock: () => number = Date.now
): Promise<{ done: number; skipped: number }> {
  let next = 0
  let done = 0
  const lane = async () => {
    for (;;) {
      if (clock() >= stopAt) return
      const i = next++
      if (i >= items.length) return
      try {
        await work(items[i])
      } catch {
        /* one environment never stops the others */
      }
      done++
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, lane))
  return { done, skipped: items.length - done }
}

import type { AppUsage, CapacityUsage } from '../../capacity/app-usage.js'
import { parseAppLimits } from '../../capacity/limits.js'
import { hubLinkOrigin } from '../move/link-client.js'
import { openSecret } from '../secrets.js'
import {
  deploymentLinkBearer,
  linkUrlOrigin,
  openSharedPrevToken,
  openSharedToken,
  type SharedDeployment
} from '../shared/store.js'

/**
 * Nivaro Hub capacity: reads the capacity figures an app process answers (routes/
 * hub-capacity-link.ts) — over a shared deployment's link (its derived bearer, ruling R7; a 401 is
 * tried once more with the previous token in its grace, as deployment-client.ts does) or over a
 * dedicated environment's hub link (its HUB_TOKEN). 8 s, `redirect: 'error'`, answers capped at
 * 2 MB and checked for shape. Never throws: a failure is a code (`LINK_REFUSED`, `UNREACHABLE` …),
 * never a token, a URL or the far side's text.
 */

export const USAGE_TIMEOUT_MS = 8_000
const MAX_BYTES = 2 * 1024 * 1024

export type UsageRead = { ok: true; usage: CapacityUsage } | { ok: false; code: string }

export type Fetch = typeof fetch

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const n0 = (v: unknown): number => n(v) ?? 0

function appOf(v: unknown): AppUsage | null {
  if (!isObj(v) || typeof v.id !== 'string' || v.id.length > 64) return null
  const db = isObj(v.db) ? v.db : {}
  const jobs = isObj(v.jobs) ? v.jobs : {}
  return {
    id: v.id,
    requests_per_min: n0(v.requests_per_min),
    requests_last_min: n0(v.requests_last_min),
    busy_ms_per_min: n0(v.busy_ms_per_min),
    errors_per_min: n0(v.errors_per_min),
    db: {
      in_use: n0(db.in_use),
      waiting: n0(db.waiting),
      pool_max: n(db.pool_max),
      processes: n0(db.processes)
    },
    jobs: { running: n(jobs.running), waiting: n0(jobs.waiting) },
    storage_bytes: n(v.storage_bytes),
    storage_checked_at: typeof v.storage_checked_at === 'string' ? v.storage_checked_at : null,
    limits: parseAppLimits(v.limits) ?? null
  }
}

/** A usage answer checked for shape, or null. */
export function parseUsage(body: unknown): CapacityUsage | null {
  if (!isObj(body) || !Array.isArray(body.apps) || !isObj(body.totals)) return null
  const t = body.totals
  const apps = body.apps.slice(0, 2000).map(appOf)
  if (apps.some((a) => a === null)) return null
  return {
    version: typeof body.version === 'string' ? body.version.slice(0, 64) : '',
    at: typeof body.at === 'string' ? body.at : new Date().toISOString(),
    partial: body.partial === true,
    processes: (Array.isArray(body.processes) ? body.processes : [])
      .filter(isObj)
      .slice(0, 200)
      .map((p) => ({
        instance: String(p.instance ?? '').slice(0, 64),
        role: typeof p.role === 'string' ? p.role.slice(0, 32) : null,
        cpu_pct: n(p.cpu_pct),
        memory_mb: n0(p.memory_mb),
        uptime_s: n0(p.uptime_s)
      })),
    totals: {
      cpu_pct: n(t.cpu_pct),
      memory_mb: n0(t.memory_mb),
      requests_per_min: n0(t.requests_per_min),
      busy_ms_per_min: n0(t.busy_ms_per_min)
    },
    apps: apps as AppUsage[]
  }
}

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function getUsage(
  doFetch: Fetch,
  url: string,
  bearer: string,
  timeoutMs: number
): Promise<{ status: number; usage: CapacityUsage | null } | { code: string }> {
  const ctl = new AbortController()
  let timer: NodeJS.Timeout | undefined
  try {
    const run = async () => {
      const res = await doFetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
        redirect: 'error',
        signal: ctl.signal
      })
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel().catch(() => {})
        return { code: 'LINK_REFUSED' }
      }
      if (res.status < 200 || res.status >= 300) {
        void res.body?.cancel().catch(() => {})
        return { status: res.status, usage: null }
      }
      const text = await readCapped(res)
      if (text === null) return { code: 'TOO_LARGE' }
      try {
        return { status: res.status, usage: parseUsage(JSON.parse(text)) }
      } catch {
        return { status: res.status, usage: null }
      }
    }
    return await Promise.race([
      run(),
      new Promise<{ code: string }>((resolve) => {
        timer = setTimeout(() => {
          ctl.abort()
          resolve({ code: 'TIMEOUT' })
        }, timeoutMs)
      })
    ])
  } catch (err) {
    const cause = (err as { cause?: { message?: unknown } } | null)?.cause
    if (/redirect/i.test(String(cause?.message ?? ''))) return { code: 'LINK_REFUSED' }
    return { code: 'UNREACHABLE' }
  } finally {
    clearTimeout(timer)
  }
}

function settle(r: { status: number; usage: CapacityUsage | null } | { code: string }): UsageRead {
  if ('code' in r) return { ok: false, code: r.code }
  if (r.status === 401 || r.status === 403 || r.status === 429)
    return { ok: false, code: 'LINK_REFUSED' }
  // 404 = the far side runs a version without the usage route (or no link at all).
  if (r.status === 404) return { ok: false, code: 'NO_USAGE_ROUTE' }
  if (r.status < 200 || r.status >= 300) return { ok: false, code: `HTTP_${r.status}` }
  return r.usage ? { ok: true, usage: r.usage } : { ok: false, code: 'BAD_ANSWER' }
}

export interface UsageClientDeps {
  fetch?: Fetch
  timeoutMs?: number
  tokens?: (id: number) => Promise<{ current: string | null; previous: string | null }>
}

/** GET {link}/api/hub-deployment/usage of a shared deployment. */
export async function readSharedUsage(
  shared: Pick<SharedDeployment, 'id' | 'link_url'>,
  deps: UsageClientDeps = {}
): Promise<UsageRead> {
  const base = linkUrlOrigin(shared.link_url)
  if (!base) return { ok: false, code: 'BAD_LINK_URL' }
  let tokens: { current: string | null; previous: string | null }
  try {
    tokens = await (
      deps.tokens ??
      (async (id: number) => {
        const [current, previous] = await Promise.all([
          openSharedToken(id),
          openSharedPrevToken(id)
        ])
        return { current, previous }
      })
    )(shared.id)
  } catch {
    return { ok: false, code: 'HUB_SECRET_UNREADABLE' }
  }
  if (!tokens.current) return { ok: false, code: 'NO_TOKEN' }
  const doFetch = deps.fetch ?? fetch
  const ms = deps.timeoutMs ?? USAGE_TIMEOUT_MS
  const url = `${base}/api/hub-deployment/usage`
  let r = await getUsage(doFetch, url, deploymentLinkBearer(tokens.current), ms)
  if (!('code' in r) && r.status === 401 && tokens.previous && tokens.previous !== tokens.current)
    r = await getUsage(doFetch, url, deploymentLinkBearer(tokens.previous), ms)
  return settle(r)
}

/** GET {base_url}/api/hub-link/usage of a dedicated environment (sealed hub token). */
export async function readLinkedUsage(
  env: { base_url: string; hub_token: string | null },
  deps: UsageClientDeps = {}
): Promise<UsageRead> {
  const base = hubLinkOrigin(env.base_url)
  if (!base) return { ok: false, code: 'BAD_BASE_URL' }
  let token: string | null
  try {
    token = openSecret(env.hub_token)
  } catch {
    return { ok: false, code: 'HUB_SECRET_UNREADABLE' }
  }
  if (!token) return { ok: false, code: 'NO_TOKEN' }
  return settle(
    await getUsage(
      deps.fetch ?? fetch,
      `${base}/api/hub-link/usage`,
      token,
      deps.timeoutMs ?? USAGE_TIMEOUT_MS
    )
  )
}

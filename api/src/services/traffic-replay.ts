// api/src/services/traffic-replay.ts
/**
 * Load replay, development only (#1159): replay a sample of one caller's logged GETs against a
 * throwaway API, at a chosen speed. GET only — nothing is ever written — and refused unless
 * NODE_ENV=development and the target is not a shared host (the instance's own PUBLIC_URL /
 * ADMIN_URL, the database host, any registered environment, TRAFFIC_REPLAY_SHARED_HOSTS).
 *
 * The requests run as the token handed to the script, not as the original caller: replay
 * reproduces load shape, never identity. Paths come from nivaro_api_logs; a query string the log
 * masked (credential-looking values) or cut is dropped rather than replayed wrong.
 */
import { config } from '../config.js'
import { db } from '../db/index.js'

export interface ReplayRow {
  path: string
  query?: string | null
  created_at: Date | string
}
export interface ReplayStep {
  /** Milliseconds after the first request (already divided by the multiplier). */
  at: number
  url: string
}

/** host[:port] of a URL-ish string, lower-cased (null when it is not one). */
export function hostOf(v: string | null | undefined): string | null {
  if (!v) return null
  const s = v.includes('://') ? v : `http://${v}`
  try {
    const u = new URL(s)
    return u.port ? `${u.hostname.toLowerCase()}:${u.port}` : u.hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Why replay to `target` is refused, or null when it may run (pure). */
export function replayRefusal(
  target: string,
  env: { nodeEnv: string | undefined; sharedHosts: Array<string | null | undefined> }
): string | null {
  if (env.nodeEnv !== 'development')
    return 'Load replay runs only with NODE_ENV=development (never against a deployed instance)'
  let u: URL
  try {
    u = new URL(target)
  } catch {
    return 'target must be an http(s) URL, e.g. http://localhost:3116'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'target must be http or https'
  const t = hostOf(target)
  const bare = u.hostname.toLowerCase()
  for (const raw of env.sharedHosts) {
    const h = hostOf(raw ?? null)
    if (!h) continue
    // A shared entry without a port covers every port of that host; with one, that port only.
    if (h === t || (!h.includes(':') && h === bare))
      return `${t} is a shared host (${raw}) — replay only against a throwaway API`
  }
  return null
}

/** A query string that can be replayed as logged (not masked, not cut). */
export function replayableQuery(q: string | null | undefined): string | null {
  if (!q) return null
  if (q.includes('••••••') || q.endsWith('…')) return null
  return q
}

/**
 * The schedule: rows oldest first, an evenly spaced `sample` of them, each at its original
 * offset from the first divided by `multiplier` (2 = twice as fast). Pure.
 */
export function planReplay(
  rows: ReplayRow[],
  opts: { sample: number; multiplier: number; base: string }
): ReplayStep[] {
  const sorted = rows
    .map((r) => ({ r, t: new Date(r.created_at).getTime() }))
    .filter((x) => Number.isFinite(x.t) && x.r.path.startsWith('/'))
    .sort((a, b) => a.t - b.t)
  if (sorted.length === 0) return []
  const n = Math.max(1, Math.min(opts.sample, sorted.length))
  const step = sorted.length / n
  const picked = Array.from({ length: n }, (_, i) => sorted[Math.floor(i * step)])
  const t0 = picked[0].t
  const mult = opts.multiplier > 0 ? opts.multiplier : 1
  const base = opts.base.replace(/\/+$/, '')
  return picked.map(({ r, t }) => {
    const q = replayableQuery(r.query)
    return { at: Math.round((t - t0) / mult), url: `${base}${r.path}${q ? `?${q}` : ''}` }
  })
}

/** `k<id>` / `u<uuid>` → the log columns that name that caller. */
export function callerFilter(caller: string): { api_key_id: number } | { user: string } | null {
  if (/^k\d{1,9}$/.test(caller)) return { api_key_id: Number(caller.slice(1)) }
  if (/^u[0-9A-Fa-f-]{36}$/.test(caller)) return { user: caller.slice(1) }
  return null
}

/** Every host replay must never target on this instance. */
export async function sharedHosts(): Promise<string[]> {
  const extra = (process.env.TRAFFIC_REPLAY_SHARED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const envHosts = (await db('nivaro_environment_components')
    .whereNotNull('base_url')
    .pluck('base_url')
    .catch(() => [])) as string[]
  return [config.PUBLIC_URL, config.ADMIN_URL, config.DB_HOST, ...envHosts, ...extra].filter(
    (h): h is string => typeof h === 'string' && !!h
  )
}

/** The caller's GETs over the last `hours` (newest first, capped). */
export async function replayRows(caller: string, hours: number, cap = 5000): Promise<ReplayRow[]> {
  const f = callerFilter(caller)
  if (!f) return []
  const since = new Date(Date.now() - hours * 3600_000)
  const q = db('nivaro_api_logs')
    .where('method', 'GET')
    .where('created_at', '>=', since)
    .where(f)
    .orderBy('created_at', 'desc')
    .limit(cap)
  try {
    return (await q.clone().select('path', 'query', 'created_at')) as ReplayRow[]
  } catch {
    // A database behind migration 357 has no query column: paths only.
    return (await q.select('path', 'created_at')) as ReplayRow[]
  }
}

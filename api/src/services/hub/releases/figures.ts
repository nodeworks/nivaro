import { db } from '../../../db/index.js'
import { fetchJson } from '../../gitlab-client.js'
import { openSecret } from '../secrets.js'

/**
 * Hub side: the health figures a release train's hold and an automatic rollback rule judge, read
 * over the environment's hub link (GET /api/hub-link/status with its bearer):
 *
 *  - readiness_score   the app's cached readiness scorecard (0–100; null = not scored yet)
 *  - recent            ?recent_minutes=N: requests, 5xx answers and front-end crash reports of
 *                      the last N minutes (aggregate counts only, never a record or a path)
 *  - release_facts     ?release_facts=1: the migration names and known setting names the app's
 *                      build carries (release notes; services/hub/releases/notes.ts)
 *
 * An environment without a hub link (no token, or placed on a shared deployment, which has
 * none) answers `{ linked: false }`: a gate that needs a figure cannot pass on it. Never throws.
 */

export interface RecentFigures {
  minutes: number
  requests: number | null
  errors_5xx: number | null
  crashes: number | null
}

export interface ReleaseFacts {
  version: string
  migrations: string[]
  env_keys: string[]
}

export interface EnvFigures {
  linked: boolean
  /** Why nothing was read (no link, refused, unreachable). */
  error?: string
  version: string | null
  readiness_score: number | null
  recent: RecentFigures | null
  release_facts: ReleaseFacts | null
  read_at: string
}

export type FiguresFetch = typeof fetchJson

export interface FiguresOptions {
  recentMinutes?: number
  releaseFacts?: boolean
  timeoutMs?: number
  fetch?: FiguresFetch
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

const NAME_RE = /^[A-Za-z0-9_.-]{1,120}$/

function names(v: unknown, max = 5000): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && NAME_RE.test(x)).slice(0, max)
}

function baseOf(raw: string): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

/** Parses a /status answer into figures (pure; tests feed it answers). */
export function figuresFromAnswer(body: unknown, at: string): EnvFigures {
  const b = (body ?? {}) as Record<string, unknown>
  const r = (b.recent ?? null) as Record<string, unknown> | null
  const f = (b.release_facts ?? null) as Record<string, unknown> | null
  const version = typeof b.version === 'string' && b.version ? b.version : null
  const score = num(b.readiness_score)
  return {
    linked: true,
    version,
    readiness_score: score == null ? null : Math.min(100, score),
    recent:
      r && typeof r === 'object'
        ? {
            minutes: num(r.minutes) ?? 0,
            requests: num(r.requests),
            errors_5xx: num(r.errors_5xx),
            crashes: num(r.crashes)
          }
        : null,
    release_facts:
      f && typeof f === 'object' && version
        ? { version, migrations: names(f.migrations), env_keys: names(f.env_keys) }
        : null,
    read_at: at
  }
}

const unlinked = (error: string, at: string): EnvFigures => ({
  linked: false,
  error,
  version: null,
  readiness_score: null,
  recent: null,
  release_facts: null,
  read_at: at
})

/** The figures of one environment row (needs id, base_url, hub_token, placement_id). */
export async function readEnvFigures(
  env: { base_url: string; hub_token: string | null; placement_id?: number | null },
  opts: FiguresOptions = {}
): Promise<EnvFigures> {
  const at = new Date().toISOString()
  try {
    if (env.placement_id != null) {
      const p = (await db('nivaro_hub_placements').where({ id: env.placement_id }).first('kind')) as
        | { kind?: string }
        | undefined
      if (p?.kind === 'shared') return unlinked('SHARED_PLACEMENT', at)
    }
    if (!env.hub_token) return unlinked('NO_HUB_LINK', at)
    const base = baseOf(env.base_url)
    if (!base) return unlinked('BAD_BASE_URL', at)
    let token: string | null
    try {
      token = openSecret(env.hub_token)
    } catch {
      return unlinked('HUB_SECRET_UNREADABLE', at)
    }
    if (!token) return unlinked('HUB_SECRET_UNREADABLE', at)
    const q = new URLSearchParams()
    if (opts.recentMinutes)
      q.set('recent_minutes', String(Math.max(1, Math.min(60, Math.ceil(opts.recentMinutes)))))
    if (opts.releaseFacts) q.set('release_facts', '1')
    const url = `${base}/api/hub-link/status${q.size ? `?${q}` : ''}`
    const res = await (opts.fetch ?? fetchJson)(
      url,
      { Accept: 'application/json', Authorization: `Bearer ${token}` },
      opts.timeoutMs ?? 8000,
      { redirect: 'error' }
    )
    if (res.status === 401 || res.status === 403 || res.status === 404)
      return unlinked('HUB_LINK_REFUSED', at)
    if (!res.ok) return unlinked(`HTTP_${res.status}`, at)
    return figuresFromAnswer(res.body, at)
  } catch {
    return unlinked('UNREACHABLE', at)
  }
}

/** The figures of an environment by id. */
export async function readEnvFiguresById(
  envId: number,
  opts: FiguresOptions = {}
): Promise<EnvFigures> {
  const row = (await db('nivaro_hub_environments')
    .where({ id: envId })
    .first('base_url', 'hub_token', 'placement_id')) as
    | { base_url: string; hub_token: string | null; placement_id: number | null }
    | undefined
  if (!row) return unlinked('NOT_FOUND', new Date().toISOString())
  return readEnvFigures(row, opts)
}

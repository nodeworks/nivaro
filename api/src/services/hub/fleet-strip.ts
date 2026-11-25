import { db } from '../../db/index.js'
import { appMap } from '../app-state.js'
import { type HubEnvState, type HubEnvStatus, hubStatusKey } from './status.js'

/**
 * The fleet strip of the standalone Hub look (admin HubFleetStrip): one dot per environment the
 * caller may see, coloured by health. ONE read for the whole strip (the client never asks per
 * dot), and it never probes an app: every environment's status comes from the cache the Apps
 * page and the status reads fill (status.ts, nvr:hub:status:<id>, 30 s); an environment nobody
 * looked at lately is `unknown` until something reads it. Answers are kept 30 s per caller view
 * (admins share one, each owner has their own) and concurrent asks share one read (single
 * flight, per app). Never throws on a cache problem: a failed cache read = unknown.
 */

/** A strip this long is already a wall: past it the strip says there are more. */
export const FLEET_STRIP_MAX = 200
export const FLEET_STRIP_TTL_MS = 30_000
/** One cache read never holds the strip longer than this. */
const CACHE_BOUND_MS = 300

export interface FleetStripEntry {
  env_id: number
  env_key: string
  app_id: number
  app_key: string
  app_name: string
  state: HubEnvState | 'unknown'
  version: string | null
  checked_at: string | null
}

export interface FleetStrip {
  entries: FleetStripEntry[]
  /** More environments exist than FLEET_STRIP_MAX (not shown). */
  truncated: boolean
}

interface Row extends Record<string, unknown> {
  id: unknown
  key: unknown
  app_id: unknown
  app_key: unknown
  app_name: unknown
}

/** The cache the status reads fill (the app's Redis); only `get` is used here. */
export interface StripCache {
  get(key: string): Promise<string | null>
}

export interface FleetStripDeps {
  redis?: StripCache | null
  rows?: (userId: string, isAdmin: boolean) => Promise<Row[]>
  now?: () => number
}

async function stripRows(userId: string, isAdmin: boolean): Promise<Row[]> {
  const q = db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .select('e.id', 'e.key', 'e.app_id', 'a.key as app_key', 'a.name as app_name')
    .orderBy([
      { column: 'a.key', order: 'asc' },
      { column: 'e.position', order: 'asc' },
      { column: 'e.id', order: 'asc' }
    ])
    .limit(FLEET_STRIP_MAX + 1)
  // An app owner sees the apps they own, as on the Apps page.
  if (!isAdmin)
    q.whereIn('e.app_id', db('nivaro_hub_app_owners').where({ user_id: userId }).select('app_id'))
  return (await q) as Row[]
}

async function cachedStatus(redis: StripCache | null, envId: number): Promise<HubEnvStatus | null> {
  if (!redis) return null
  try {
    const raw = await Promise.race([
      redis.get(hubStatusKey(envId)),
      new Promise<null>((r) => setTimeout(() => r(null), CACHE_BOUND_MS))
    ])
    if (!raw) return null
    const v = JSON.parse(raw) as HubEnvStatus
    return v && typeof v.state === 'string' ? v : null
  } catch {
    return null
  }
}

async function buildStrip(
  userId: string,
  isAdmin: boolean,
  deps: FleetStripDeps
): Promise<FleetStrip> {
  const all = await (deps.rows ?? stripRows)(userId, isAdmin)
  const rows = all.slice(0, FLEET_STRIP_MAX)
  const redis = deps.redis ?? null
  const statuses = await Promise.all(rows.map((r) => cachedStatus(redis, Number(r.id))))
  return {
    entries: rows.map((r, i) => {
      const status = statuses[i]
      return {
        env_id: Number(r.id),
        env_key: String(r.key),
        app_id: Number(r.app_id),
        app_key: String(r.app_key),
        app_name: String(r.app_name ?? r.app_key),
        state: status?.state ?? 'unknown',
        version: status?.version ?? null,
        checked_at: status?.checked_at ?? null
      }
    }),
    truncated: all.length > rows.length
  }
}

/** Kept answers and reads in flight, per app (appMap) and caller view. */
const strips = appMap<string, { at: number; answer: Promise<FleetStrip> }>()

/** Test hook. */
export function resetFleetStripCache(): void {
  strips.clear()
}

export function readFleetStrip(
  userId: string,
  isAdmin: boolean,
  deps: FleetStripDeps = {}
): Promise<FleetStrip> {
  const now = (deps.now ?? Date.now)()
  const view = isAdmin ? 'admin' : `owner:${userId}`
  const hit = strips.get(view)
  if (hit && now - hit.at < FLEET_STRIP_TTL_MS) return hit.answer
  const answer = buildStrip(userId, isAdmin, deps)
  if (strips.size >= 500) strips.clear()
  strips.set(view, { at: now, answer })
  // A failed read is never kept: the next ask tries again.
  answer.catch(() => {
    if (strips.get(view)?.answer === answer) strips.delete(view)
  })
  return answer
}

import { db } from '../../db/index.js'
import {
  type HubEnvState,
  type HubEnvStatus,
  type HubStatusTarget,
  readEnvironmentStatus,
  type StatusCache
} from './status.js'

/**
 * The fleet strip of the standalone Hub look (admin HubFleetStrip): one dot per environment the
 * caller may see, coloured by health. ONE read for the whole strip (the client never asks per
 * dot): every environment's status comes from the same 30 s cache the Apps page fills
 * (status.ts, nvr:hub:status:<id>), and an environment nobody looked at lately is read once,
 * side by side, bounded by the status read's own timeout. Never throws; a failed read = unknown.
 */

/** A strip this long is already a wall: past it the strip says there are more. */
export const FLEET_STRIP_MAX = 200

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
  base_url: unknown
  hub_token: unknown
  placement_id: unknown
  app_id: unknown
  app_key: unknown
  app_name: unknown
}

export interface FleetStripDeps {
  redis?: StatusCache | null
  rows?: (userId: string, isAdmin: boolean) => Promise<Row[]>
  read?: (target: HubStatusTarget, redis: StatusCache | null) => Promise<HubEnvStatus>
}

async function stripRows(userId: string, isAdmin: boolean): Promise<Row[]> {
  const q = db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .select(
      'e.id',
      'e.key',
      'e.base_url',
      'e.hub_token',
      'e.placement_id',
      'e.app_id',
      'a.key as app_key',
      'a.name as app_name'
    )
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

export async function readFleetStrip(
  userId: string,
  isAdmin: boolean,
  deps: FleetStripDeps = {}
): Promise<FleetStrip> {
  const all = await (deps.rows ?? stripRows)(userId, isAdmin)
  const rows = all.slice(0, FLEET_STRIP_MAX)
  const redis = deps.redis ?? null
  const read =
    deps.read ??
    ((t: HubStatusTarget, r: StatusCache | null) => readEnvironmentStatus(t, { redis: r }))
  const settled = await Promise.allSettled(
    rows.map((r) =>
      read(
        {
          id: Number(r.id),
          key: String(r.key),
          base_url: String(r.base_url ?? ''),
          hub_token: (r.hub_token as string | null) ?? null,
          placement_id: r.placement_id == null ? null : Number(r.placement_id)
        },
        redis
      )
    )
  )
  return {
    entries: rows.map((r, i) => {
      const s = settled[i]
      const status = s.status === 'fulfilled' ? s.value : null
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

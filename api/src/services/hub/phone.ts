import { db } from '../../db/index.js'
import { flagOf, productionMap } from './owner-access.js'
import { hubStatusKey } from './status.js'

/**
 * Nivaro Hub on the phone app: two read-only JSON answers the Nivaro mobile app shows, under the
 * person's ordinary sign-in (a phone's nvd_ token reads like a session). Admins see every app,
 * anyone else only the apps they own; nobody else gets anything (an empty fleet).
 *
 *   GET /api/hub/mobile/summary  → the fleet at a glance: apps, environments with their last
 *                                  known status (the cached status only — the phone never makes
 *                                  the Hub call every app), runs going now, failures in 24 h
 *   GET /api/hub/mobile/runs     → recent promotions / rollbacks / applies, newest first
 *
 * No URLs with tokens, no hostnames beyond the environment's own base URL, no logs: a run's
 * detail stays on the web page (`web_path`).
 */

export interface PhoneEnv {
  id: number
  key: string
  production: boolean
  /** ok | degraded | unreachable | link_refused | … ; 'unknown' = no fresh cached status. */
  state: string
  version: string | null
  checked_at: string | null
}

export interface PhoneApp {
  id: number
  key: string
  name: string
  owner: boolean
  environments: PhoneEnv[]
  web_path: string
}

export interface PhoneRun {
  id: number
  app_id: number
  app_key: string
  app_name: string
  environment_id: number
  environment_key: string
  kind: string
  version: string | null
  from_version: string | null
  status: string
  step: string | null
  started_at: string | null
  finished_at: string | null
  web_path: string
}

interface Viewer {
  id: string
  isAdmin: boolean
}

type StatusRedis = { mget?(...keys: string[]): Promise<Array<string | null>> } | null

const iso = (v: unknown) => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

async function visibleApps(viewer: Viewer) {
  const q = db('nivaro_hub_apps').select('id', 'key', 'name').orderBy('name', 'asc')
  if (!viewer.isAdmin)
    q.whereIn('id', db('nivaro_hub_app_owners').where({ user_id: viewer.id }).select('app_id'))
  const apps = (await q) as Array<{ id: number; key: string; name: string }>
  const owned = new Set(
    (
      (await db('nivaro_hub_app_owners').where({ user_id: viewer.id }).select('app_id')) as Array<{
        app_id: number
      }>
    ).map((r) => Number(r.app_id))
  )
  return { apps, owned }
}

async function cachedStatuses(redis: StatusRedis, ids: number[]) {
  const out = new Map<
    number,
    { state: string; version: string | null; checked_at: string | null; reported: string | null }
  >()
  if (!redis?.mget || !ids.length) return out
  try {
    const raws = await redis.mget(...ids.map((id) => hubStatusKey(id)))
    raws.forEach((raw, i) => {
      if (!raw) return
      try {
        const v = JSON.parse(raw) as {
          state?: unknown
          version?: unknown
          checked_at?: unknown
          app_environment?: unknown
        }
        out.set(ids[i], {
          state: typeof v.state === 'string' ? v.state : 'unknown',
          version: typeof v.version === 'string' ? v.version : null,
          checked_at: typeof v.checked_at === 'string' ? v.checked_at : null,
          reported: typeof v.app_environment === 'string' ? v.app_environment : null
        })
      } catch {
        // an unreadable entry reads as unknown
      }
    })
  } catch {
    // Redis down: every status is unknown
  }
  return out
}

export async function phoneSummary(viewer: Viewer, redis: StatusRedis) {
  const { apps, owned } = await visibleApps(viewer)
  const appIds = apps.map((a) => Number(a.id))
  const envRows = appIds.length
    ? ((await db('nivaro_hub_environments')
        .whereIn('app_id', appIds)
        .whereNot('status', 'archived')
        .select('id', 'app_id', 'key', 'position', 'production')
        .orderBy('position', 'asc')
        .orderBy('id', 'asc')) as Array<{
        id: number
        app_id: number
        key: string
        position: number
        production: unknown
      }>)
    : []
  const statuses = await cachedStatuses(
    redis,
    envRows.map((e) => Number(e.id))
  )
  const since = new Date(Date.now() - 24 * 3_600_000)
  const [running, failed] = appIds.length
    ? await Promise.all([
        db('nivaro_hub_deploys')
          .whereIn('app_id', appIds)
          .where({ status: 'running' })
          .count({ n: '*' }),
        db('nivaro_hub_deploys')
          .whereIn('app_id', appIds)
          .whereIn('status', ['failed', 'interrupted'])
          .where('started_at', '>=', since)
          .count({ n: '*' })
      ])
    : [[{ n: 0 }], [{ n: 0 }]]
  const out: PhoneApp[] = apps.map((a) => {
    const mine = envRows
      .filter((e) => Number(e.app_id) === Number(a.id))
      .map((e) => ({
        id: Number(e.id),
        key: String(e.key),
        position: Number(e.position ?? 0),
        production: flagOf(e.production),
        reported: statuses.get(Number(e.id))?.reported ?? null
      }))
    // The server's own rule (owner-access.ts productionMap), so the phone never disagrees.
    const prod = productionMap(mine)
    return {
      id: Number(a.id),
      key: String(a.key),
      name: String(a.name),
      owner: owned.has(Number(a.id)),
      web_path: `/hub?app=${Number(a.id)}`,
      environments: mine.map((e) => {
        const s = statuses.get(e.id)
        return {
          id: e.id,
          key: e.key,
          production: prod.get(e.id) ?? true,
          state: s?.state ?? 'unknown',
          version: s?.version ?? null,
          checked_at: s?.checked_at ?? null
        }
      })
    }
  })
  const envs = out.flatMap((a) => a.environments)
  const n = (r: unknown) => Number((r as Array<{ n: unknown }>)[0]?.n ?? 0) || 0
  return {
    apps: out,
    counts: {
      apps: out.length,
      environments: envs.length,
      ok: envs.filter((e) => e.state === 'ok').length,
      down: envs.filter((e) => e.state === 'unreachable').length,
      degraded: envs.filter((e) => e.state === 'degraded' || e.state === 'link_refused').length,
      unknown: envs.filter((e) => e.state === 'unknown').length,
      running: n(running),
      failed_24h: n(failed)
    },
    generated_at: new Date().toISOString()
  }
}

export async function phoneRuns(viewer: Viewer, limit = 20): Promise<PhoneRun[]> {
  const { apps } = await visibleApps(viewer)
  const ids = apps.map((a) => Number(a.id))
  if (!ids.length) return []
  const rows = (await db('nivaro_hub_deploys as d')
    .leftJoin('nivaro_hub_environments as e', 'e.id', 'd.environment_id')
    .leftJoin('nivaro_hub_apps as a', 'a.id', 'd.app_id')
    .whereIn('d.app_id', ids)
    .orderBy('d.id', 'desc')
    .limit(Math.max(1, Math.min(Math.trunc(limit) || 20, 100)))
    .select(
      'd.id',
      'd.app_id',
      'd.environment_id',
      'd.kind',
      'd.version',
      'd.from_version',
      'd.status',
      'd.step',
      'd.started_at',
      'd.finished_at',
      'e.key as env_key',
      'a.key as app_key',
      'a.name as app_name'
    )) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    app_id: Number(r.app_id),
    app_key: String(r.app_key ?? ''),
    app_name: String(r.app_name ?? r.app_key ?? ''),
    environment_id: Number(r.environment_id),
    environment_key: String(r.env_key ?? ''),
    kind: String(r.kind ?? ''),
    version: (r.version as string | null) ?? null,
    from_version: (r.from_version as string | null) ?? null,
    status: String(r.status ?? ''),
    step: (r.step as string | null) ?? null,
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    web_path: `/hub?app=${Number(r.app_id)}`
  }))
}

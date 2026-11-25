import { db } from '../../../db/index.js'
import { NIVARO_VERSION } from '../../../version.js'
import { newestVersion, releasesBehind } from './rules.js'
import { type FleetSettings, loadFleetSettings, targetFor } from './settings.js'
import {
  ALERTS,
  type FleetStatusRow,
  lastDeploys,
  nameFrom,
  namesOf,
  readFleetStatus,
  uptimeCounts
} from './store.js'
import { monthBounds, monthOf, sloFigures, uptimePercent } from './uptime.js'

/**
 * The fleet page answer: every app × environment the caller may see on one screen, built ONLY
 * from the Hub's own tables (the status snapshot the probe job keeps, uptime samples, Hub deploy
 * rows, open alerts). Never calls an app: a page load costs a handful of reads however many
 * environments there are.
 *
 * "Newest" = the highest version any environment of the whole fleet runs, or the Hub's own
 * version when that is higher (an owner sees the same newest as an admin, never which app runs it).
 */

export interface FleetAlertChip {
  id: number
  rule_id: string
  kind: string
  message: string
  opened_at: string | null
}

export interface FleetRow {
  app_id: number
  app_key: string
  app_name: string
  environment_id: number
  env_key: string
  env_status: string
  position: number
  base_url: string
  placement: 'dedicated' | 'shared' | 'none'
  shared_key: string | null
  version: string | null
  version_since: string | null
  behind: number | null
  state: string | null
  preflight: string | null
  readiness_score: number | null
  open_issues: number | null
  failing: string[]
  error: string | null
  checked_at: string | null
  up: boolean | null
  probed_at: string | null
  uptime_24h: number | null
  uptime_30d: number | null
  slo: {
    month: string
    target: number
    uptime: number | null
    met: boolean | null
    left_samples: number
  }
  last_deploy: {
    id: number
    kind: string
    version: string
    status: string
    at: string | null
    by: string | null
    by_name: string | null
  } | null
  deployed_at: string | null
  alerts: FleetAlertChip[]
}

export interface FleetAnswer {
  newest: string | null
  hub_version: string
  generated_at: string
  rows: FleetRow[]
  /** Environments whose status the probe job has not read yet (just added, or jobs not ticking). */
  unprobed: number
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

/** App ids the caller may see: every app for an admin, owned apps for anyone else. */
async function visibleAppIds(userId: string, isAdmin: boolean): Promise<number[] | null> {
  if (isAdmin) return null
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: userId })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

const laterOf = (a: string | null, b: string | null) =>
  !a ? b : !b ? a : new Date(a).getTime() >= new Date(b).getTime() ? a : b

export async function buildFleet(
  who: { userId: string; isAdmin: boolean },
  opts: { now?: Date; settings?: FleetSettings } = {}
): Promise<FleetAnswer> {
  const now = opts.now ?? new Date()
  const settings = opts.settings ?? (await loadFleetSettings())
  const allowed = await visibleAppIds(who.userId, who.isAdmin)

  const envQ = db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .leftJoin('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .leftJoin('nivaro_hub_shared_deployments as s', 's.id', 'p.shared_deployment_id')
    .orderBy('a.key', 'asc')
    .orderBy('e.position', 'asc')
    .orderBy('e.id', 'asc')
    .select(
      'e.id',
      'e.app_id',
      'e.key',
      'e.status',
      'e.position',
      'e.base_url',
      'e.placement_id',
      'a.key as app_key',
      'a.name as app_name',
      'p.kind as placement_kind',
      's.key as shared_key'
    )
  if (allowed) {
    if (!allowed.length)
      return {
        newest: null,
        hub_version: NIVARO_VERSION,
        generated_at: now.toISOString(),
        rows: [],
        unprobed: 0
      }
    envQ.whereIn('e.app_id', allowed)
  }
  const envs = (await envQ) as Array<Record<string, unknown>>
  const ids = envs.map((e) => Number(e.id))

  // The newest version is fleet-wide (also for an owner): one small read of every snapshot.
  const allStatus = await readFleetStatus()
  const newest = newestVersion([NIVARO_VERSION, ...[...allStatus.values()].map((s) => s.version)])

  const day = new Date(now.getTime() - 86_400_000)
  const month = monthOf(now)
  const mb = monthBounds(month)
  const [d1, d30, mtd, deploys, alertRows] = await Promise.all([
    uptimeCounts(ids, day, now),
    uptimeCounts(ids, new Date(now.getTime() - 30 * 86_400_000), now),
    mb ? uptimeCounts(ids, mb.from, now) : Promise.resolve(new Map()),
    lastDeploys(ids),
    ids.length
      ? (db(ALERTS).whereNull('resolved_at').orderBy('opened_at', 'desc').select('*') as Promise<
          Array<Record<string, unknown>>
        >)
      : Promise.resolve([] as Array<Record<string, unknown>>)
  ])
  const names = await namesOf([...deploys.last.values()].map((d) => d.started_by))

  const alertsByEnv = new Map<number, FleetAlertChip[]>()
  for (const a of alertRows) {
    if (a.environment_id == null) continue
    const envId = Number(a.environment_id)
    const chip: FleetAlertChip = {
      id: Number(a.id),
      rule_id: String(a.rule_id),
      kind: String(a.kind),
      message: String(a.message),
      opened_at: iso(a.opened_at)
    }
    alertsByEnv.set(envId, [...(alertsByEnv.get(envId) ?? []), chip])
  }

  let unprobed = 0
  const rows: FleetRow[] = envs.map((e) => {
    const id = Number(e.id)
    const st: FleetStatusRow | undefined = allStatus.get(id)
    if (!st?.checked_at && !st?.probed_at) unprobed++
    const last = deploys.last.get(id) ?? null
    const success = deploys.lastSuccess.get(id) ?? null
    const target = targetFor(settings, id)
    const slo = sloFigures(mtd.get(id) ?? { samples: 0, up: 0 }, target)
    const kind = e.placement_kind == null ? 'none' : String(e.placement_kind)
    const version = st?.version ?? null
    return {
      app_id: Number(e.app_id),
      app_key: String(e.app_key),
      app_name: String(e.app_name),
      environment_id: id,
      env_key: String(e.key),
      env_status: String(e.status),
      position: Number(e.position) || 0,
      base_url: String(e.base_url),
      placement: kind === 'shared' ? 'shared' : kind === 'none' ? 'none' : 'dedicated',
      shared_key: (e.shared_key as string | null) ?? null,
      version,
      version_since: st?.version_since ?? null,
      behind: version ? releasesBehind(version, newest) : null,
      state: st?.state ?? null,
      preflight: st?.preflight ?? null,
      readiness_score: st?.readiness_score ?? null,
      open_issues: st?.open_issues ?? null,
      failing: st?.failing ?? [],
      error: st?.error ?? null,
      checked_at: st?.checked_at ?? null,
      up: st?.up ?? null,
      probed_at: st?.probed_at ?? null,
      uptime_24h: uptimePercent(d1.get(id) ?? { samples: 0, up: 0 }),
      uptime_30d: uptimePercent(d30.get(id) ?? { samples: 0, up: 0 }),
      slo: { month, target, uptime: slo.uptime, met: slo.met, left_samples: slo.left_samples },
      last_deploy: last
        ? {
            id: last.id,
            kind: last.kind,
            version: last.version,
            status: last.status,
            at: last.finished_at ?? last.started_at,
            by: last.started_by,
            by_name: nameFrom(names, last.started_by)
          }
        : null,
      deployed_at: laterOf(success?.finished_at ?? null, st?.version_since ?? null),
      alerts: alertsByEnv.get(id) ?? []
    }
  })
  return {
    newest,
    hub_version: NIVARO_VERSION,
    generated_at: now.toISOString(),
    rows,
    unprobed
  }
}

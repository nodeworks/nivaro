import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { AgentError, agentHealth } from '../docker/agent-client.js'
import type { AgentHealth } from '../docker/agent-types.js'
import { type DockerDriverRow, getDriver, listDrivers } from '../drivers.js'
import { OPS_HEALTH, type OpsHealthRow, readOpsHealth, writeOpsHealth } from './health-row.js'
import { type LinkReadDeps, type OpsEnvTarget, opsTargets, readOps } from './link-read.js'
import { hubAdminIds, notifyOps, type OpsNotifier, ownerIdsOfApps } from './notify.js'

/**
 * Hub enhancement 20: storage health.
 *
 *  - Per Docker driver: the agent's `storage` health field (packages/hub-agent storage.ts:
 *    statfs of HUB_AGENT_STORAGE_PATH + a bounded tree walk) → nivaro_hub_ops_health scope
 *    `driver`. Level: ok < WARN_PCT ≤ warn < CRITICAL_PCT ≤ critical; unknown when not read.
 *  - Per environment: the app's stored files (count, bytes) over its link → scope `environment`;
 *    the previous reading is kept beside it for the growth figure.
 *  - A driver whose level RISES to warn or critical tells the Hub administrators and the owners
 *    of every app placed on that driver (dedicated placements, and environments on a shared
 *    deployment that runs on it) once per level; back below WARN_PCT re-arms it.
 *
 * Never a path, a file name or the agent's text: figures and fixed state words only.
 */

export const WARN_PCT = 80
export const CRITICAL_PCT = 90

export type StorageLevel = 'ok' | 'warn' | 'critical' | 'unknown'

export interface AgentStorage {
  configured: boolean
  kind: 'nfs' | 'local'
  state: string
  total_bytes: number | null
  free_bytes: number | null
  used_bytes: number | null
  used_pct: number | null
  tree: { bytes: number; files: number; complete: boolean; walked_at: string } | null
}

const STATES = new Set(['ok', 'not_configured', 'unreadable', 'timeout', 'pending'])
const nn = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

/** The agent's storage field, checked; null when the agent has none (an agent before storage health). */
export function parseAgentStorage(
  health: AgentHealth | Record<string, unknown>
): AgentStorage | null {
  const s = (health as { storage?: unknown }).storage as Record<string, unknown> | undefined
  if (!s || typeof s !== 'object') return null
  const state = typeof s.state === 'string' && STATES.has(s.state) ? s.state : 'unreadable'
  const t = s.tree as Record<string, unknown> | null | undefined
  const tree =
    t && typeof t === 'object' && nn(t.bytes) != null && nn(t.files) != null
      ? {
          bytes: nn(t.bytes) as number,
          files: nn(t.files) as number,
          complete: t.complete === true,
          walked_at: typeof t.walked_at === 'string' ? t.walked_at.slice(0, 40) : ''
        }
      : null
  const pct = nn(s.used_pct)
  return {
    configured: s.configured === true,
    kind: s.kind === 'nfs' ? 'nfs' : 'local',
    state,
    total_bytes: nn(s.total_bytes),
    free_bytes: nn(s.free_bytes),
    used_bytes: nn(s.used_bytes),
    used_pct: pct == null ? null : Math.min(100, pct),
    tree
  }
}

export function levelOf(pct: number | null): StorageLevel {
  if (pct == null) return 'unknown'
  if (pct >= CRITICAL_PCT) return 'critical'
  if (pct >= WARN_PCT) return 'warn'
  return 'ok'
}

const RANK: Record<string, number> = { unknown: -1, ok: 0, warn: 1, critical: 2 }

/** Whether a reading at `level` should notify, given the level last notified. */
export function shouldNotify(level: StorageLevel, notified: string | null): boolean {
  if (level !== 'warn' && level !== 'critical') return false
  return (RANK[level] ?? -1) > (RANK[notified ?? 'ok'] ?? 0)
}

/** App ids with an environment on this driver (dedicated placement or a shared deployment on it). */
export async function appIdsOnDriver(driverId: number): Promise<number[]> {
  const rows = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .leftJoin('nivaro_hub_shared_deployments as s', 's.id', 'p.shared_deployment_id')
    .where((w) => {
      void w.where('p.driver_id', driverId).orWhere('s.driver_id', driverId)
    })
    .distinct('e.app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

const fmtBytes = (n: number | null): string => {
  if (n == null) return 'unknown'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export interface StorageDeps {
  health?: (driver: DockerDriverRow) => Promise<AgentHealth>
  notify?: OpsNotifier
  now?: () => Date
}

/** Read one Docker driver's storage now and store it; notifies on a level rise. */
export async function checkDriverStorage(
  driver: DockerDriverRow,
  deps: StorageDeps = {}
): Promise<OpsHealthRow | null> {
  const now = (deps.now ?? (() => new Date()))()
  const [prev] = await readOpsHealth('driver', [driver.id])
  let fields: Record<string, unknown>
  let level: StorageLevel = 'unknown'
  try {
    const h = await (deps.health ?? ((d) => agentHealth(d)))(driver)
    const s = parseAgentStorage(h)
    if (!s) {
      fields = { state: 'agent_too_old', level: 'unknown', error: null }
    } else if (!s.configured) {
      fields = { state: 'not_configured', level: 'unknown', kind: s.kind, error: null }
    } else {
      level = s.state === 'ok' ? levelOf(s.used_pct) : 'unknown'
      fields = {
        state: s.state,
        level,
        kind: s.kind,
        total_bytes: s.total_bytes,
        free_bytes: s.free_bytes,
        used_bytes: s.used_bytes,
        files: s.tree?.files ?? null,
        files_complete: s.tree ? s.tree.complete : null,
        error: null
      }
      if (s.state === 'ok' && prev?.used_bytes != null && prev.checked_at) {
        fields.prev_used_bytes = prev.used_bytes
        fields.prev_checked_at = new Date(prev.checked_at)
      }
    }
  } catch (err) {
    const code = err instanceof AgentError ? err.code : 'AGENT_UNREACHABLE'
    fields = { state: 'agent_unreachable', level: 'unknown', error: code.slice(0, 64) }
  }
  fields.checked_at = now
  // Back under the warning line re-arms the next warning.
  if (level === 'ok') fields.notified_level = null
  await writeOpsHealth('driver', driver.id, fields)

  if (shouldNotify(level, prev?.notified_level ?? null)) {
    const apps = await appIdsOnDriver(driver.id)
    const admins = await hubAdminIds()
    const adminKeys = new Set(admins.map((a) => a.toLowerCase()))
    // Owners do not see drivers (storageOverview hides them): they get a notice without one.
    const owners = (await ownerIdsOfApps(apps)).filter((o) => !adminKeys.has(o.toLowerCase()))
    const pct = typeof fields.used_bytes === 'number' ? Number(fields.used_bytes) : null
    const total = typeof fields.total_bytes === 'number' ? Number(fields.total_bytes) : null
    const free = typeof fields.free_bytes === 'number' ? Number(fields.free_bytes) : null
    const shown = pct != null && free != null ? Math.round((pct / (pct + free)) * 1000) / 10 : null
    const subject =
      level === 'critical'
        ? `Storage almost full on ${driver.name}`
        : `Storage filling up on ${driver.name}`
    const notify = deps.notify ?? notifyOps
    await notify(admins, {
      subject,
      message: `The volume storage of Docker driver ${driver.name} is ${shown ?? '?'}% used (${fmtBytes(free)} free of ${fmtBytes(total)}). Apps on it stop writing files when it is full.`,
      path: `/hub/drivers?driver=${driver.id}`,
      why: 'You are a Hub administrator.',
      source: { kind: 'hub_storage', label: driver.name, id: driver.id }
    })
    if (owners.length)
      await notify(owners, {
        subject:
          level === 'critical'
            ? 'The storage your app runs on is almost full'
            : 'The storage your app runs on is filling up',
        message: `The storage your app’s files live on is ${shown ?? '?'}% used. Your app stops writing files when it is full; a Hub administrator has been told.`,
        path: '/hub/storage',
        why: 'You own an app that runs on this storage.',
        source: { kind: 'hub_storage' }
      })
    await db(OPS_HEALTH)
      .where({ scope: 'driver', ref_id: driver.id })
      .update({ notified_level: level, notified_at: now })
    await logActivity({
      action: 'hub-storage-warning',
      user: null,
      collection: 'nivaro_hub_drivers',
      item: String(driver.id),
      comment: `${level}: ${shown ?? '?'}% used`
    }).catch(() => undefined)
  }
  const [row] = await readOpsHealth('driver', [driver.id])
  return row ?? null
}

/** Every Docker driver (or the named one). */
export async function collectDriverStorage(
  opts: { driverIds?: number[]; deps?: StorageDeps } = {}
): Promise<number> {
  const drivers = (await listDrivers()).filter(
    (d): d is DockerDriverRow =>
      d.kind === 'docker' && (!opts.driverIds || opts.driverIds.includes(d.id))
  )
  let n = 0
  for (const d of drivers) {
    try {
      await checkDriverStorage(d, opts.deps)
      n++
    } catch {
      // One driver's failure never stops the others.
    }
  }
  return n
}

export async function driverStorage(driverId: number): Promise<OpsHealthRow | null> {
  const [row] = await readOpsHealth('driver', [driverId])
  return row ?? null
}

export async function checkDriverStorageNow(driverId: number): Promise<OpsHealthRow | null> {
  const d = await getDriver(driverId)
  if (d?.kind !== 'docker') return null
  return checkDriverStorage(d)
}

const int = (v: unknown): number | null => {
  const x = Number(v)
  return Number.isFinite(x) && x >= 0 ? Math.floor(x) : null
}

/** Every environment's stored files (count, bytes) over its link. */
export async function collectFilesUsage(
  opts: { envIds?: number[]; targets?: OpsEnvTarget[]; deps?: LinkReadDeps } = {}
): Promise<number> {
  const targets = opts.targets ?? (await opsTargets(opts.envIds))
  const prevRows = await readOpsHealth(
    'environment',
    targets.map((t) => t.id)
  )
  const prev = new Map(prevRows.map((r) => [r.ref_id, r]))
  let read = 0
  for (const env of targets) {
    const r = await readOps(env, 'files', {}, opts.deps)
    const at = new Date()
    if (r.state === 'ok') {
      const b = r.body as { files?: unknown; bytes?: unknown } | null
      const files = int(b?.files)
      const bytes = int(b?.bytes)
      if (files != null && bytes != null) {
        const before = prev.get(env.id)
        await writeOpsHealth('environment', env.id, {
          state: 'ok',
          files,
          used_bytes: bytes,
          files_complete: true,
          ...(before?.used_bytes != null && before.checked_at
            ? { prev_used_bytes: before.used_bytes, prev_checked_at: new Date(before.checked_at) }
            : {}),
          error: null,
          checked_at: at
        })
        read++
        continue
      }
    }
    await writeOpsHealth('environment', env.id, {
      state: r.state === 'ok' ? 'failed' : r.state,
      checked_at: at
    }).catch(() => undefined)
  }
  return read
}

export interface StorageOverview {
  drivers: Array<{ id: number; name: string } & Partial<OpsHealthRow>>
  environments: Array<{
    environment_id: number
    app_id: number
    app_key: string
    environment_key: string
    driver_id: number | null
    on_shared: boolean
    state: string | null
    files: number | null
    bytes: number | null
    prev_bytes: number | null
    prev_checked_at: string | null
    checked_at: string | null
  }>
  warn_pct: number
  critical_pct: number
}

/** The storage page: drivers (admins only) + environments the viewer may read. */
export async function storageOverview(viewer: {
  userId: string
  isAdmin: boolean
}): Promise<StorageOverview> {
  const drivers: StorageOverview['drivers'] = []
  if (viewer.isAdmin) {
    const all = (await listDrivers()).filter((d) => d.kind === 'docker')
    const health = new Map(
      (
        await readOpsHealth(
          'driver',
          all.map((d) => d.id)
        )
      ).map((r) => [r.ref_id, r])
    )
    for (const d of all) drivers.push({ id: d.id, name: d.name, ...(health.get(d.id) ?? {}) })
  }
  const q = db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .leftJoin('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .leftJoin('nivaro_hub_shared_deployments as s', 's.id', 'p.shared_deployment_id')
    .leftJoin(`${OPS_HEALTH} as h`, function () {
      this.on('h.ref_id', '=', 'e.id').andOnVal('h.scope', '=', 'environment')
    })
    .orderBy('a.key')
    .orderBy('e.position')
    .select(
      'e.id',
      'a.id as app_id',
      'a.key as app_key',
      'e.key as environment_key',
      'p.kind as placement_kind',
      'p.driver_id as placement_driver',
      's.driver_id as shared_driver',
      'h.state',
      'h.files',
      'h.used_bytes',
      'h.prev_used_bytes',
      'h.prev_checked_at',
      'h.checked_at'
    )
  if (!viewer.isAdmin)
    q.whereIn(
      'a.id',
      db('nivaro_hub_app_owners').where({ user_id: viewer.userId }).select('app_id')
    )
  const rows = (await q) as Array<Record<string, unknown>>
  const iso = (v: unknown): string | null => {
    if (v == null) return null
    const d = v instanceof Date ? v : new Date(String(v))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return {
    drivers,
    environments: rows.map((r) => {
      const onShared = r.placement_kind === 'shared'
      const drv = onShared ? r.shared_driver : r.placement_driver
      return {
        environment_id: Number(r.id),
        app_id: Number(r.app_id),
        app_key: String(r.app_key),
        environment_key: String(r.environment_key),
        // Which driver a person may see is admin-only: owners get null.
        driver_id: viewer.isAdmin && drv != null ? Number(drv) : null,
        on_shared: onShared,
        state: (r.state as string | null) ?? null,
        files: int(r.files),
        bytes: int(r.used_bytes),
        prev_bytes: int(r.prev_used_bytes),
        prev_checked_at: iso(r.prev_checked_at),
        checked_at: iso(r.checked_at)
      }
    }),
    warn_pct: WARN_PCT,
    critical_pct: CRITICAL_PCT
  }
}

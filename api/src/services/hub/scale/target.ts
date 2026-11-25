import { db } from '../../../db/index.js'
import { environmentFromRow, readApp } from '../apps.js'
import { AgentError, agentHealth } from '../docker/agent-client.js'
import type { AgentHealth, StackRole } from '../docker/agent-types.js'
import { databaseRecordId } from '../docker/stack-env.js'
import { deployedStack, dockerTargetOf } from '../docker/stack-guards.js'
import { readStackSettings, type StackSettingsRow } from '../docker/stack-settings.js'
import { type StackSize, StackTemplateError, stackRoles } from '../docker/templates.js'
import { type DockerDriverRow, getDriver, STACK_NAME_RE, sharedPoolMax } from '../drivers.js'
import { envPolicy } from '../owner-access.js'
import { sharedStackSettings } from '../shared/stack-render.js'
import { getShared, type SharedDeployment } from '../shared/store.js'
import { tenantsOf } from '../shared/tenants.js'
import { deployedSharedRoles } from '../shared/upgrade-plan.js'
import {
  DEDICATED_BACKGROUND_POOL,
  DEDICATED_MAIN_POOL,
  type DedicatedPools,
  poolSetting,
  type ServerLoad,
  type SharedAppPool
} from './connections.js'
import { applyScaleShape, processCount, type ScaleShape } from './shape.js'
import { readScaleShape, type TargetKind } from './store.js'

/**
 * Nivaro Hub scaling: everything the plan, the runner and the scaling view read about ONE stack
 * — an environment's dedicated Docker stack, or a Docker shared deployment. Reads only.
 *
 * The roles: the size template for what runs (a dedicated stack: version_pin + size, with the
 * exporter only on an agent that takes it; a shared deployment: the roles its newest successful
 * run recorded), with the stored shape laid over it — exactly what the renderers send.
 */

const ENVS = 'nivaro_hub_environments'
const DATABASES = 'nivaro_hub_databases'
const SERVERS = 'nivaro_hub_db_servers'

export interface ScaleTarget {
  kind: TargetKind
  id: number
  /** `app/env` or the shared deployment's key. */
  key: string
  /** The words a person reads: "Acme · production" / "Shared EU". */
  label: string
  /** What a typed confirm asks for (the environment or deployment key). */
  confirm: string
  app_ids: number[]
  env_ids: number[]
  /** A production environment (dedicated), or any placed one (shared): the production helper. */
  production: boolean
  stack: string | null
  driver: DockerDriverRow | null
  size: StackSize
  version: string | null
  /** The stack has a recorded deploy (a dedicated converged step; a shared successful run). */
  deployed: boolean
  /** The size template's roles (no shape). */
  template: StackRole[]
  shape: ScaleShape | null
  /** template + shape = what the renderers send now. */
  roles: StackRole[]
  /** SQLite allows one writer process: never past one process. */
  sqlite: boolean
  /** Dedicated: its stack settings and pools. */
  settings?: StackSettingsRow | null
  pools?: DedicatedPools
  server?: ServerLoad | null
  /** Shared: the deployment, its apps' pools and budget. */
  shared?: SharedDeployment
  apps?: SharedAppPool[]
  /** Why the target cannot be scaled at all (no Docker stack, retired …), else null. */
  unusable: { code: string; text: string } | null
}

/** Reads the agent's health once per driver within one call (null = it did not answer). */
export function healthReader(read: (d: DockerDriverRow) => Promise<AgentHealth> = agentHealth) {
  const seen = new Map<number, Promise<AgentHealth | null>>()
  return (driver: DockerDriverRow | null): Promise<AgentHealth | null> => {
    if (!driver) return Promise.resolve(null)
    let p = seen.get(driver.id)
    if (!p) {
      p = read(driver).catch((err) => {
        if (err instanceof AgentError || err instanceof Error) return null
        return null
      })
      seen.set(driver.id, p)
    }
    return p
  }
}

const stateOk = (v: string | null | undefined) => /^\d+\.\d+\.\d+/.test(String(v ?? ''))

/** The database server an environment's record lives on, with its limit (null when unknown). */
async function serverOfEnv(
  dbRef: unknown
): Promise<{ id: number; name: string; max: number | null } | null> {
  const recordId = databaseRecordId(dbRef)
  if (recordId == null) return null
  const rec = (await db(DATABASES).where({ id: recordId }).first('server_id')) as
    | { server_id: number | null }
    | undefined
  if (!rec?.server_id) return null
  const s = (await db(SERVERS).where({ id: rec.server_id }).first()) as
    | Record<string, unknown>
    | undefined
  if (!s) return null
  const max = Number(s.max_connections)
  return {
    id: Number(s.id),
    name: String(s.name),
    max: Number.isInteger(max) && max > 0 ? max : null
  }
}

async function isSqliteRecord(dbRef: unknown): Promise<boolean> {
  const id = databaseRecordId(dbRef)
  if (id == null) return false
  const r = (await db(DATABASES).where({ id, engine: 'sqlite' }).first('id')) as
    | { id: number }
    | undefined
  return !!r
}

function dedicatedPools(row: StackSettingsRow | null): DedicatedPools {
  return {
    main: poolSetting(row?.settings?.DB_POOL_MAX, DEDICATED_MAIN_POOL),
    background: poolSetting(row?.settings?.DB_POOL_BACKGROUND_MAX, DEDICATED_BACKGROUND_POOL)
  }
}

function templateRoles(
  version: string | null,
  size: StackSize,
  agentVersion: unknown
): StackRole[] {
  try {
    return stackRoles(
      stateOk(version) ? String(version) : '0.3.184',
      size,
      String(agentVersion ?? '')
    )
  } catch (err) {
    if (err instanceof StackTemplateError) return []
    throw err
  }
}

/** One environment's dedicated stack. */
export async function environmentTarget(
  envId: number,
  health: (d: DockerDriverRow | null) => Promise<AgentHealth | null> = healthReader()
): Promise<ScaleTarget | null> {
  const raw = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown> | undefined
  if (!raw) return null
  const env = environmentFromRow(raw)
  const app = await readApp(env.app_id)
  if (!app) return null
  const docker = await dockerTargetOf(envId)
  const settings = docker ? await readStackSettings(envId) : null
  const size: StackSize = settings?.size ?? 'small'
  const h = await health(docker?.driver ?? null)
  const template = templateRoles(env.version_pin, size, h?.agent_version ?? '0.2.2')
  const shape = await readScaleShape('environment', envId)
  const policy = await envPolicy(envId).catch(() => null)
  const srv = await serverOfEnv(raw.db_ref)
  let deployed = false
  let unusable: ScaleTarget['unusable'] = null
  if (!docker)
    unusable = {
      code: 'NOT_DOCKER',
      text: 'This environment is not placed on a Hub Docker stack: there is nothing for the Hub to scale.'
    }
  else if (!docker.stackName)
    unusable = { code: 'NO_STACK_NAME', text: 'The placement names no swarm stack.' }
  else {
    const d = await deployedStack(envId, docker.stackName, docker.forgottenAt)
    deployed = d.state === 'ok' && !!env.version_pin
    if (!deployed)
      unusable = {
        code: 'NOT_DEPLOYED',
        text: 'The stack has no recorded deploy yet: deploy it first, then scale it.'
      }
  }
  if (env.status === 'archived')
    unusable = { code: 'ARCHIVED', text: 'This environment is archived.' }
  return {
    kind: 'environment',
    id: envId,
    key: `${app.key}/${env.key}`,
    label: `${app.name || app.key} · ${env.key}`,
    confirm: env.key,
    app_ids: [app.id],
    env_ids: [envId],
    production: policy?.production ?? true,
    stack: docker?.stackName ?? null,
    driver: docker?.driver ?? null,
    size,
    version: env.version_pin,
    deployed,
    template,
    shape,
    roles: applyScaleShape(template, shape),
    sqlite: await isSqliteRecord(raw.db_ref),
    settings,
    pools: dedicatedPools(settings),
    server: srv ? { id: srv.id, name: srv.name, max_connections: srv.max, others: 0 } : null,
    unusable
  }
}

/** One Docker shared deployment. */
export async function sharedTarget(sharedId: number): Promise<ScaleTarget | null> {
  const shared = await getShared(sharedId)
  if (!shared) return null
  const settings = sharedStackSettings(shared)
  const deployedRoles = await deployedSharedRoles(shared)
  const shape = await readScaleShape('shared', sharedId)
  const driver =
    shared.mode === 'docker' && shared.driver_id != null ? await getDriver(shared.driver_id) : null
  const rows = (await tenantsOf(shared)).filter((r) => r.placedHere)
  const apps: SharedAppPool[] = []
  let sqlite = false
  let production = false
  for (const r of rows) {
    const envRaw = (await db(ENVS).where({ id: r.env.id }).first('db_ref')) as
      | { db_ref: string | null }
      | undefined
    const srv = await serverOfEnv(envRaw?.db_ref)
    if (await isSqliteRecord(envRaw?.db_ref)) sqlite = true
    const policy = await envPolicy(r.env.id).catch(() => null)
    if (policy?.production ?? true) production = true
    apps.push({
      env_id: r.env.id,
      label: `${r.app.key}/${r.env.key}`,
      pool_max: sharedPoolMax(r.placement.target as { pool_max?: number }),
      server: srv ? { id: srv.id, name: srv.name, max_connections: srv.max, others: 0 } : null
    })
  }
  let unusable: ScaleTarget['unusable'] = null
  if (shared.status === 'retired')
    unusable = { code: 'SHARED_RETIRED', text: 'This shared deployment is retired.' }
  else if (shared.mode !== 'docker' || driver?.kind !== 'docker')
    unusable = {
      code: 'SHARED_NOT_HUB_DEPLOYED',
      text: 'This shared deployment is not a Hub Docker stack: whoever runs it sizes it.'
    }
  else if (!shared.stack || !STACK_NAME_RE.test(shared.stack))
    unusable = { code: 'NO_STACK_NAME', text: 'The shared deployment names no swarm stack.' }
  else if (deployedRoles.never || !shared.version_pin)
    unusable = {
      code: 'NOT_DEPLOYED',
      text: 'The shared deployment has no successful run yet: deploy it first, then scale it.'
    }
  return {
    kind: 'shared',
    id: sharedId,
    key: shared.key,
    label: shared.name || shared.key,
    confirm: shared.key,
    app_ids: [...new Set(rows.map((r) => r.app.id))],
    env_ids: rows.map((r) => r.env.id),
    production,
    stack: shared.stack,
    driver: driver?.kind === 'docker' ? driver : null,
    size: settings.size,
    version: shared.version_pin,
    deployed: !deployedRoles.never,
    template: deployedRoles.roles,
    shape,
    roles: applyScaleShape(deployedRoles.roles, shape),
    sqlite,
    shared,
    apps,
    unusable
  }
}

export async function readTarget(
  kind: TargetKind,
  id: number,
  health?: (d: DockerDriverRow | null) => Promise<AgentHealth | null>
): Promise<ScaleTarget | null> {
  return kind === 'shared' ? sharedTarget(id) : environmentTarget(id, health)
}

/**
 * Connections every OTHER Hub stack may open on each of these database servers now: dedicated
 * stacks (processes × their pools) and shared deployments (processes × each app's pool_max) whose
 * environments' database records live there. Environments the Hub does not run on Docker are not
 * counted (their processes are unknown): the operator keeps room for them in the limit.
 */
export async function otherLoads(
  serverIds: number[],
  self: { kind: TargetKind; id: number }
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!serverIds.length) return out
  for (const id of serverIds) out.set(id, 0)
  const recs = (await db(DATABASES)
    .whereIn('server_id', serverIds)
    .select('id', 'server_id')) as Array<{ id: number; server_id: number }>
  if (!recs.length) return out
  const serverOfRecord = new Map(recs.map((r) => [Number(r.id), Number(r.server_id)]))
  const envs = (await db(ENVS)
    .whereNotNull('db_ref')
    .whereNot({ status: 'archived' })
    .select('id', 'db_ref', 'placement_id', 'version_pin')) as Array<Record<string, unknown>>
  const sharedProcs = new Map<number, number>()
  const health = healthReader()
  for (const e of envs) {
    const recordId = databaseRecordId(e.db_ref)
    const server = recordId == null ? undefined : serverOfRecord.get(recordId)
    if (server === undefined || e.placement_id == null) continue
    const placement = (await db('nivaro_hub_placements')
      .where({ id: e.placement_id })
      .first('kind', 'shared_deployment_id', 'target')) as Record<string, unknown> | undefined
    if (!placement) continue
    const envId = Number(e.id)
    if (placement.kind === 'shared') {
      const sid = Number(placement.shared_deployment_id)
      if (self.kind === 'shared' && sid === self.id) continue
      if (!sharedProcs.has(sid)) {
        const t = await sharedTarget(sid)
        sharedProcs.set(sid, t ? processCount(t.roles) : 0)
      }
      let target: unknown = placement.target
      try {
        target = typeof target === 'string' ? JSON.parse(target) : target
      } catch {
        target = {}
      }
      const pool = sharedPoolMax(target as { pool_max?: number })
      out.set(server, (out.get(server) ?? 0) + (sharedProcs.get(sid) ?? 0) * pool)
      continue
    }
    if (self.kind === 'environment' && envId === self.id) continue
    const t = await environmentTarget(envId, health)
    if (!t || t.unusable?.code === 'NOT_DOCKER' || !t.pools) continue
    const per = t.pools.main + t.pools.background
    out.set(server, (out.get(server) ?? 0) + processCount(t.roles) * per)
  }
  return out
}

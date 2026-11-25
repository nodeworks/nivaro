// The facts the creation planner needs (phase 3, Task 8): what the Hub records (apps, owners,
// targets, database servers and rows, every environment's names) and a few bounded remote looks
// (Docker Hub digest, the deploy project on GitLab, whether an automatic server already holds a
// database name). Every remote look is bounded (8 s) and answers 'unreachable' (or null for the
// image) on failure; nothing here throws for a remote problem, and no error text is kept (driver
// and GitLab errors may carry a host, a login or worse).
//
// A database name is looked up on a server only when it is an automatic server the planner
// accepts and the name passed the planner's own data checks (databaseNameProblem): names typed
// for a manual or adopted database never reach a server from here. The lookup binds the name
// (provisioner.databaseExists); it is never DDL.
import { db } from '../../../db/index.js'
import { hubPublicOrigin } from '../../deployment-mode.js'
import { parseJson } from '../../pipeline-engine.js'
import { isUserIdShape, unknownUserIds } from '../apps.js'
import { getDatabase, type HubDatabase } from '../db/databases.js'
import { provisionerFor, withServerKnex } from '../db/provisioner.js'
import { getServerRow, type HubDbServerRow, openAdminSecret } from '../db/servers.js'
import { AgentError, agentStack, agentHealth as realAgentHealth } from '../docker/agent-client.js'
import type { AgentHealth, StackStatus } from '../docker/agent-types.js'
import { agentEnvPrefixes } from '../docker/stack-env.js'
import { validateStackSettings } from '../docker/stack-settings.js'
import { type DockerDriverRow, getDriver } from '../drivers.js'
import type { HubEnvironmentRow } from '../promote-types.js'
import { hubImage, imageDigest } from '../registry.js'
import { HUB_MASK, sealSecret } from '../secrets.js'
import { lastRoutedNames, sharedPoolUsed } from '../shared/place.js'
import { getShared } from '../shared/store.js'
import { hubOwnHostnames, isCreatableKey, stackName } from './app-config.js'
import { projectExists as gitlabProjectExists } from './gitlab-provision.js'
import {
  databaseNameProblem,
  MAX_CREATE_ENVIRONMENTS,
  plannedDatabaseNames,
  serverProblem,
  targetProblem
} from './plan.js'
import { getTargetRow, type HubTargetRow, targetCtx } from './targets.js'
import {
  type CreateAppInput,
  type CreationFacts,
  creationKindOf,
  type DockerCreationFacts,
  type DockerStackInput,
  gitlabTargetIdOf,
  type SharedCreationFacts
} from './types.js'

export const GATHER_TIMEOUT_MS = 8000

export interface GatherCreationDeps {
  /** Where HUB_URL / ADMIN_URL / PUBLIC_URL are read (default process.env). */
  env?: NodeJS.ProcessEnv
  imageDigest?: (image: string, tag: string) => Promise<string | 'present' | null>
  projectExists?: (target: HubTargetRow, path: string) => Promise<boolean>
  databaseExists?: (server: HubDbServerRow, name: string) => Promise<boolean>
  encryptionKey?: () => boolean
  timeoutMs?: number
  /**
   * A preview (POST /apps/create/plan): the browser sends masks for secrets, which count as
   * given. A start never does (a mask there is no value).
   */
  preview?: boolean
  /** Docker creations: the agent's health and stacks (default: the agent client). */
  agentHealth?: (driver: DockerDriverRow) => Promise<AgentHealth>
  agentStack?: (driver: DockerDriverRow, name: string) => Promise<StackStatus | null>
}

class Unreachable extends Error {}

function bounded<T>(p: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    Promise.resolve().then(p),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Unreachable('timed out')), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

async function defaultProjectExists(target: HubTargetRow, path: string): Promise<boolean> {
  return !!(await gitlabProjectExists(targetCtx(target, path), path))
}

async function defaultDatabaseExists(server: HubDbServerRow, name: string): Promise<boolean> {
  const admin = openAdminSecret(server)
  if (!admin) throw new Unreachable('no provisioning login')
  return withServerKnex(server, admin, (k) =>
    provisionerFor(server.engine, { user_host: server.user_host }).databaseExists(k, name)
  )
}

function defaultEncryptionKey(): boolean {
  try {
    sealSecret('nivaro-hub-probe')
    return true
  } catch {
    return false
  }
}

/**
 * The origin apps are told as HUB_URL (ruling X-5): deployment-mode.ts hubPublicOrigin() — HUB_URL
 * by the one HUB_URL rule, else PUBLIC_URL's origin — the same address the Hub issues its
 * sign-in tokens from (oidc/keys.ts hubIssuer) and Docker stacks are given. The plan judges it
 * (NO_HUB_URL).
 */
export function hubUrlFrom(env: NodeJS.ProcessEnv): string | null {
  return hubPublicOrigin(env)
}

function hostOf(url: unknown): string | null {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/\.$/, '') || null
  } catch {
    return null
  }
}

export async function gatherCreationFacts(
  input: CreateAppInput,
  deps: GatherCreationDeps = {}
): Promise<CreationFacts> {
  const env = deps.env ?? process.env
  const ms = deps.timeoutMs ?? GATHER_TIMEOUT_MS
  const i = (input && typeof input === 'object' ? input : {}) as Partial<CreateAppInput>
  const key = str(i.key)
  const keyOk = isCreatableKey(key)
  // The planner reads at most MAX_CREATE_ENVIRONMENTS (one more says "too many").
  const envs = Array.isArray(i.environments)
    ? i.environments.slice(0, MAX_CREATE_ENVIRONMENTS + 1)
    : []

  // App key + owners
  const keyTaken =
    !!key && !!(await db('nivaro_hub_apps').where({ key: key.toLowerCase() }).first('id'))
  let unknownOwners: string[] = []
  if (Array.isArray(i.owners)) {
    const ids = i.owners.filter((o): o is string => typeof o === 'string').map((o) => o.trim())
    const malformed = ids.filter((o) => !isUserIdShape(o))
    unknownOwners = [...malformed, ...(await unknownUserIds(ids.filter(isUserIdShape)))]
  }

  // Target (a GitLab one; Docker and shared creations name a driver or a deployment)
  const kind = creationKindOf(i)
  const targetId = kind === 'gitlab' ? gitlabTargetIdOf(i) : 0
  const target = Number.isInteger(targetId) && targetId > 0 ? await getTargetRow(targetId) : null

  // Servers + existing databases named by the request
  const servers: Record<number, HubDbServerRow> = {}
  const existing: Record<number, HubDatabase> = {}
  for (const e of envs) {
    const d = (e?.database ?? {}) as Record<string, unknown>
    if (d.database_id !== undefined) {
      const id = Number(d.database_id)
      if (Number.isInteger(id) && id > 0 && !existing[id]) {
        const row = await getDatabase(id)
        if (row) existing[id] = row
      }
    } else {
      const id = Number(d.server_id)
      if (Number.isInteger(id) && id > 0 && !servers[id]) {
        const row = await getServerRow(id)
        if (row) servers[id] = row
      }
    }
  }

  // Names the Hub already records
  const recordedNames = (
    (await db('nivaro_hub_databases').select('host', 'database_name')) as Array<{
      host: string
      database_name: string
    }>
  ).map((r) => ({ host: String(r.host), database_name: String(r.database_name) }))

  const envRows = (await db('nivaro_hub_environments as e')
    .leftJoin('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .select('e.key as env_key', 'a.key as app_key', 'e.base_url', 'e.hostnames')) as Array<
    Record<string, unknown>
  >
  const hosts = new Set<string>()
  const stacks = new Set<string>()
  for (const r of envRows) {
    const list = typeof r.hostnames === 'string' ? parseJson(r.hostnames) : r.hostnames
    if (Array.isArray(list))
      for (const h of list)
        if (typeof h === 'string' && h.trim()) hosts.add(h.trim().toLowerCase().replace(/\.$/, ''))
    const base = hostOf(r.base_url)
    if (base) hosts.add(base)
    const ak = String(r.app_key ?? '')
    const ek = String(r.env_key ?? '')
    if (isCreatableKey(ak) && isCreatableKey(ek)) stacks.add(stackName(ak, ek))
  }
  // The raw HUB_URL too, even one the HUB_URL rule refuses: its host is still the Hub's.
  for (const h of hubOwnHostnames([env.HUB_URL, env.ADMIN_URL, env.PUBLIC_URL])) hosts.add(h)

  // Remote looks, side by side, each bounded
  const hasLook = deps.databaseExists ?? defaultDatabaseExists
  const probes = new Map<string, { server: HubDbServerRow; name: string }>()
  if (keyOk)
    for (const e of envs) {
      const d = (e?.database ?? {}) as Record<string, unknown>
      if (d.database_id !== undefined) continue
      const server = servers[Number(d.server_id)]
      const envKey = str(e?.key)
      if (!server) continue
      if (server.provision_mode !== 'automatic' || serverProblem(server)) continue
      if (!isCreatableKey(envKey) && d.database_name === undefined) continue
      const { database_name } = plannedDatabaseNames(key, envKey, server.engine, d)
      if (databaseNameProblem(server.engine, database_name)) continue
      probes.set(`${server.id}:${database_name}`, { server, name: database_name })
    }
  const serverHas: Record<string, boolean | 'unreachable'> = {}
  const probeAll = Promise.all(
    [...probes].map(async ([k, p]) => {
      try {
        serverHas[k] = (await bounded(() => hasLook(p.server, p.name), ms)) === true
      } catch {
        serverHas[k] = 'unreachable'
      }
    })
  )

  const projectLook = (async (): Promise<boolean | 'unreachable'> => {
    if (!target || !keyOk || targetProblem(target)) return false
    const path = `${target.config.namespace}/${key}-deploy`
    try {
      const look = deps.projectExists ?? defaultProjectExists
      return (await bounded(() => look(target, path), ms)) === true
    } catch {
      return 'unreachable'
    }
  })()

  const version = str(i.version)
  const digestLook = async (tag: string): Promise<string | 'present' | null> => {
    try {
      return await bounded(() => (deps.imageDigest ?? imageDigest)(hubImage(), tag), ms)
    } catch {
      return null
    }
  }
  // A shared deployment runs its own version: no image is looked up for it.
  const versionOk = /^\d+\.\d+\.\d+$/.test(version) && kind !== 'shared'
  const [, projectExists, digest, slimDigest, docker, shared] = await Promise.all([
    probeAll,
    projectLook,
    versionOk ? digestLook(version) : Promise.resolve(null),
    versionOk && kind === 'gitlab' ? digestLook(`${version}-slim`) : Promise.resolve(null),
    kind === 'docker' ? gatherDocker(i, keyOk ? key : null, envs, deps, ms) : undefined,
    kind === 'shared' ? gatherShared(i) : undefined
  ])

  return {
    keyTaken,
    unknownOwners,
    target,
    servers,
    existing,
    recordedNames,
    takenHostnames: [...hosts],
    takenStackNames: [...stacks],
    serverHas,
    projectExists,
    digest,
    slimDigest,
    encryptionKey: (deps.encryptionKey ?? defaultEncryptionKey)(),
    hubUrl: hubUrlFrom(env),
    kind,
    ...(docker ? { docker } : {}),
    ...(shared ? { shared } : {})
  }
}

// ── Docker and shared creations (gap `create`) ───────────────────────────────

/** Settings the creation writes itself: never taken from the request. */
const CREATION_OWNED = new Set([
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI'
])
const creationOwned = (k: string) => CREATION_OWNED.has(k) || k.startsWith('DB_')

/** A preview's stand-in for a masked secret: passes every value rule, never stored. */
const PREVIEW_VALUE = '0123456789abcdef'.repeat(4)

function agentStateOf(err: unknown): DockerCreationFacts['agentState'] {
  if (err instanceof AgentError) {
    if (err.code === 'AGENT_INCOMPATIBLE') return 'incompatible'
    if (err.code === 'AGENT_REFUSED' || err.code === 'AGENT_REDIRECT') return 'refused'
    return 'unreachable'
  }
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^(DRIVER_MISCONFIGURED|HUB_SECRET|HUB_NEEDS)/.test(code))
    return 'refused'
  return 'unreachable'
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The Docker driver, what its agent says now (health, and every planned stack name), the stack
 * names its other placements deploy, and the stack settings checked as a Stack panel save is —
 * the agent's HUB_AGENT_ENV_PREFIXES included. Every agent look is bounded; none throws.
 */
async function gatherDocker(
  i: Partial<CreateAppInput>,
  key: string | null,
  envs: CreateAppInput['environments'],
  deps: GatherCreationDeps,
  ms: number
): Promise<DockerCreationFacts> {
  const t = (isObj(i.target) ? i.target : {}) as { driver_id?: unknown; stack?: unknown }
  const stack = (isObj(t.stack) ? t.stack : {}) as DockerStackInput
  const preview = deps.preview === true
  const id = Number(t.driver_id)
  const row = Number.isInteger(id) && id > 0 ? await getDriver(id) : null
  const driver = row?.kind === 'docker' ? row : null
  const out: DockerCreationFacts = {
    driver,
    health: null,
    agentState: 'not_asked',
    imageRepo: hubImage(),
    stacks: {},
    placementStacks: [],
    settings: { ok: false, code: 'BAD_TARGET', message: 'Pick the Docker driver.' },
    secretKeys: []
  }
  const secrets = isObj(stack.secrets) ? stack.secrets : {}
  out.secretKeys = Object.entries(secrets)
    .filter(([, v]) => typeof v === 'string' && v !== '' && (preview || v !== HUB_MASK))
    .map(([k]) => k)
    .sort()
  if (!driver) return out

  try {
    out.health = await bounded(() => (deps.agentHealth ?? realAgentHealth)(driver), ms)
    out.agentState = 'ok'
  } catch (err) {
    out.agentState = agentStateOf(err)
  }

  const placements = (await db('nivaro_hub_placements')
    .where({ driver_id: driver.id })
    .select('target')) as Array<{ target: unknown }>
  for (const p of placements) {
    const tg = typeof p.target === 'string' ? parseJson(p.target) : p.target
    const name = isObj(tg) ? tg.stack : undefined
    if (typeof name === 'string' && name) out.placementStacks.push(name)
  }

  // Ports the driver's other stacks are published on (a second stack on one is refused).
  const ports = (await db('nivaro_hub_stack_settings as ss')
    .join('nivaro_hub_environments as e', 'e.id', 'ss.environment_id')
    .join('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .where('p.driver_id', driver.id)
    .whereNotNull('ss.publish_port')
    .select('ss.publish_port as port')) as Array<{ port: unknown }>
  out.takenPorts = [...new Set(ports.map((r) => Number(r.port)).filter(Number.isInteger))]

  if (out.health && key) {
    const look = deps.agentStack ?? ((d: DockerDriverRow, n: string) => agentStack(d, n))
    await Promise.all(
      envs.map(async (e) => {
        const envKey = str(e?.key)
        if (!isCreatableKey(envKey)) return
        const name = stackName(key, envKey)
        try {
          const st = await bounded(() => look(driver, name), ms)
          const owner = (st?.owner ?? {}) as { app?: unknown }
          out.stacks[name] = !st
            ? 'none'
            : owner.app === key && st.environment === envKey
              ? 'hub'
              : 'other'
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code
          out.stacks[name] =
            code === 'STACK_NOT_HUB' || code === 'STACK_OWNER_MISMATCH' ? 'other' : 'unknown'
        }
      })
    )
  }

  // Keys the creation writes itself (sign-in, the database record) are refused by name.
  const plain = isObj(stack.settings) ? stack.settings : {}
  const owned = [...Object.keys(plain), ...Object.keys(secrets)].find(creationOwned)
  if (owned) {
    out.settings = {
      ok: false,
      code: 'RESERVED_SETTING',
      message: `${owned.slice(0, 64)} is set by the creation itself (sign-in and the database come from the form).`
    }
    return out
  }
  const body: Record<string, unknown> = {
    ...(stack.size !== undefined ? { size: stack.size } : {}),
    ...(stack.redis !== undefined ? { redis: stack.redis } : {}),
    settings: plain,
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([k, v]) => [k, preview && v === HUB_MASK ? PREVIEW_VALUE : v])
    ),
    ...(stack.extension_pins !== undefined ? { extension_pins: stack.extension_pins } : {})
  }
  const health = out.health
  const v = await validateStackSettings(body, null, {
    driver: driver.config,
    // Part of the validator's interface only (hostnames are judged by the planner).
    env: {} as HubEnvironmentRow,
    envPrefixes: async () => (health ? agentEnvPrefixes(health) : null)
  })
  out.settings = v.ok ? { ok: true, row: v.row } : { ok: false, code: v.code, message: v.message }
  return out
}

/** The shared deployment, the pool its placements already take and the names it routes. */
async function gatherShared(i: Partial<CreateAppInput>): Promise<SharedCreationFacts> {
  const t = (isObj(i.target) ? i.target : {}) as { shared_id?: unknown }
  const id = Number(t.shared_id)
  const deployment = Number.isInteger(id) && id > 0 ? await getShared(id) : null
  if (!deployment) return { deployment: null, poolUsed: 0, routed: [] }
  const [poolUsed, routed] = await Promise.all([
    sharedPoolUsed(deployment.id),
    deployment.mode === 'docker' ? lastRoutedNames(deployment.id) : Promise.resolve([])
  ])
  return { deployment, poolUsed, routed }
}

import { db } from '../../../db/index.js'
import { hubUrlBootWarning } from '../../deployment-mode.js'
import { parseJson } from '../../pipeline-engine.js'
import type { HubApp } from '../apps.js'
import { type DockerDriverRow, getPlacement, STACK_NAME_RE } from '../drivers.js'
import type {
  HubComponent,
  HubDeployKind,
  HubEnvironmentRow,
  StackFacts
} from '../promote-types.js'
import { hubImage } from '../registry.js'
import { HUB_MASK } from '../secrets.js'
import { AgentError, agentHealth, agentStack } from './agent-client.js'
import type { AgentHealth, StackStatus } from './agent-types.js'
import { agentOrigin } from './driver-config.js'
import {
  hostnameRefusals,
  renderStackSpec,
  StackRenderError,
  stackHostnames
} from './render-spec.js'
import { databaseRecordId } from './stack-env.js'
import type { DeployedStack } from './stack-guards.js'
import {
  missingSettings,
  otherEnvironmentNames,
  publicStackSettings,
  readStackSettings,
  type StackSettingsRow
} from './stack-settings.js'
import { StackTemplateError, stackRoles } from './templates.js'

/**
 * The planner's facts for one stack component (Hub phase 4): what the Hub agent says about itself
 * (GET /v1/health) and about the stack (GET /v1/stacks/:name), whether the environment's stack
 * settings are complete, whether its names can be routed, and which extension pins the deploy
 * installs (Decision 10). Reads only: gather never applies, restarts or removes anything.
 *
 * No setting or secret VALUE leaves this module: settings are checked by name, secrets by key
 * (publicStackSettings masks), and the dry render that proves the stored settings make a spec the
 * agent takes runs over masked values and is thrown away.
 */

const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'
const VERSION_RE = /^\d+\.\d+\.\d+$/
const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const PIN_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/
/** A placeholder digest for the dry render (never sent anywhere). */
const DRY_DIGEST = `sha256:${'0'.repeat(64)}`

/** Everything stack gather reaches outside its arguments; tests replace parts of it. */
export interface StackGatherDeps {
  agentHealth(driver: DockerDriverRow): Promise<AgentHealth>
  agentStack(driver: DockerDriverRow, name: string): Promise<StackStatus | null>
  readStackSettings(envId: number): Promise<StackSettingsRow | null>
  /** Every name the OTHER Hub environments claim (HOSTNAME_TAKEN). */
  otherEnvironmentNames(envId: number): Promise<Set<string>>
  /** The placement's swarm stack name (target.stack); null when none is set. */
  stackName(placementId: number | null): Promise<string | null>
  /** nivaro_hub_environments.extension_pins of an environment; UNREADABLE when malformed. */
  extensionPins(envId: number): Promise<Record<string, string> | typeof UNREADABLE>
  /**
   * What the stored plan of `envId`'s newest successful docker deploy of `version` ran: the
   * extension pins it installed and the image it deployed (null when not recorded as
   * `<repo>@sha256:<64 hex>`); null = no such deploy; UNREADABLE = that plan (or its pins) cannot
   * be read. A rollback redeploys exactly this (P4-29): the registry is never read again.
   */
  deployedBuild(envId: number, version: string): Promise<DeployedBuild | typeof UNREADABLE | null>
  /**
   * Apply now (P4-35): what the stack last converged to, from the newest recorded deploy of it
   * whatever that deploy's outcome (a deploy can converge and then fail verify) — the same
   * reader restart uses (stack-guards.ts deployedStack).
   */
  recordedStack(envId: number, stackName: string): Promise<DeployedStack>
  /**
   * Phase 3: the database record the environment's db_ref names (masked: name + whether it is
   * ready), null when it names none. The plan never opens the connection; the run does.
   */
  databaseRecord?(envId: number): Promise<{ name: string; ready: boolean } | null>
  /**
   * Phase 6 (Task 5, X-7): the Hub's own HUB_URL problem (deployment-mode.ts hubUrlBootWarning),
   * null when none. The plan warns HUB_URL_PROBLEM: the stack then gets PUBLIC_URL's origin.
   */
  hubUrlWarning?(): string | null
}

/** The database record an environment's db_ref names, read masked (no connection opened). */
async function readDatabaseRecord(envId: number): Promise<{ name: string; ready: boolean } | null> {
  const env = (await db('nivaro_hub_environments').where({ id: envId }).first('db_ref')) as
    | { db_ref: string | null }
    | undefined
  const id = databaseRecordId(env?.db_ref)
  if (id == null) return null
  const { getDatabase } = await import('../db/databases.js')
  const d = await getDatabase(id)
  return { name: d?.database_name ?? `#${id}`, ready: d?.status === 'ready' }
}

/** What a recorded docker deploy ran. */
export interface DeployedBuild {
  extensions: Record<string, string>
  /** <repo>@sha256:<64 hex>; null = the deploy did not record a usable one. */
  image: string | null
}

/** A stored pin set that cannot be read whole: the deploy must not guess (fails closed). */
export const UNREADABLE = 'unreadable' as const

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * id → pin, all or nothing: null when the value is not a plain object or ANY entry is not a
 * well-formed `<id>: <repo>@sha256:<64 hex>` pair — a dropped pin would silently uninstall it.
 */
export function strictPinMap(raw: unknown): Record<string, string> | null {
  const v = typeof raw === 'string' ? parseJson(raw) : raw
  if (!isPlainObject(v)) return null
  const out: Record<string, string> = {}
  for (const [id, pin] of Object.entries(v)) {
    if (!EXTENSION_ID_RE.test(id) || typeof pin !== 'string' || !PIN_RE.test(pin)) return null
    out[id] = pin
  }
  return out
}

async function readExtensionPins(
  envId: number
): Promise<Record<string, string> | typeof UNREADABLE> {
  const row = (await db(ENVS).where({ id: envId }).first('extension_pins')) as
    | { extension_pins: unknown }
    | undefined
  const raw = row?.extension_pins
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return {}
  return strictPinMap(raw) ?? UNREADABLE
}

/**
 * From the stored plans of successful deploys, newest first, the FIRST row that has a docker step
 * decides: its pins, or UNREADABLE when its `stack.extensions` is not a plain object or any pin is
 * malformed. A row whose plan does not parse stops the search as UNREADABLE (it may be the docker
 * deploy): an older deploy never stands in for it.
 */
async function readDeployedBuild(
  envId: number,
  version: string
): Promise<DeployedBuild | typeof UNREADABLE | null> {
  const rows = (await db(DEPLOYS)
    .where({ environment_id: envId, status: 'success', version })
    .orderBy('id', 'desc')
    .select('plan')) as Array<{ plan: string | null }>
  for (const r of rows) {
    let plan: unknown
    try {
      plan = JSON.parse(String(r.plan ?? ''))
    } catch {
      return UNREADABLE
    }
    if (!isPlainObject(plan)) return UNREADABLE
    const steps: unknown[] = Array.isArray(plan.steps) ? plan.steps : []
    const step = steps.find((x) => isPlainObject(x) && x.driver === 'docker') as
      | Record<string, unknown>
      | undefined
    if (!step) continue
    const extensions = strictPinMap(isPlainObject(step.stack) ? step.stack.extensions : undefined)
    if (!extensions) return UNREADABLE
    const image =
      typeof step.deployedImage === 'string' && PIN_RE.test(step.deployedImage)
        ? step.deployedImage
        : null
    return { extensions, image }
  }
  return null
}

export function defaultStackGatherDeps(): StackGatherDeps {
  return {
    agentHealth: (driver) => agentHealth(driver),
    agentStack: (driver, name) => agentStack(driver, name),
    readStackSettings,
    otherEnvironmentNames,
    stackName: async (placementId) => {
      if (!placementId) return null
      const p = await getPlacement(placementId)
      const name = p && p.kind !== 'shared' ? p.target.stack : undefined
      return typeof name === 'string' && STACK_NAME_RE.test(name) ? name : null
    },
    extensionPins: readExtensionPins,
    deployedBuild: readDeployedBuild,
    // Lazy: stack-guards imports this module.
    recordedStack: async (envId, stackName) =>
      (await import('./stack-guards.js')).deployedStack(envId, stackName),
    databaseRecord: readDatabaseRecord
  }
}

/** How a failed health read reads in the plan. */
function agentStateOf(err: unknown): StackFacts['agent'] {
  if (err instanceof AgentError) {
    if (err.code === 'AGENT_INCOMPATIBLE') return 'incompatible'
    if (err.code === 'AGENT_REFUSED' || err.code === 'AGENT_REDIRECT') return 'refused'
    return 'unreachable'
  }
  // No token / unreadable seal / unusable address: the Hub cannot talk to the agent as itself.
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^(DRIVER_MISCONFIGURED|HUB_SECRET|HUB_NEEDS)/.test(code))
    return 'refused'
  return 'unreachable'
}

function stackStateOf(
  status: StackStatus | null,
  app: HubApp,
  env: HubEnvironmentRow
): StackFacts['stackState'] {
  if (!status) return 'none'
  const owner = status.owner as { app?: unknown }
  return owner?.app === app.key && status.environment === env.key ? 'hub' : 'other_owner'
}

export function publishPortProblem(
  health: AgentHealth,
  row: StackSettingsRow | null
): string | null {
  if (health.edge !== 'publish') return null
  const range = Array.isArray(health.publish_ports) ? health.publish_ports : null
  const where = range ? `${range[0]}–${range[1]}` : null
  if (!range) return 'the agent publishes stacks on a port but has no publish port range set'
  const port = row?.publish_port ?? null
  if (port == null) return `publish_port is not set — the agent publishes stacks on ${where}`
  if (port < range[0] || port > range[1])
    return `publish_port ${port} is outside the agent's range ${where}`
  return null
}

/** Codes the dry render reports that other facts already name (hostnames, the publish port). */
const RENDER_CODES_NAMED_ELSEWHERE = new Set([
  'HOSTNAME_INVALID',
  'TOO_MANY_HOSTNAMES',
  'PUBLISH_PORT_REQUIRED'
])

export async function gatherStackFacts(
  c: HubComponent,
  ctx: {
    env: HubEnvironmentRow
    previous: HubEnvironmentRow | null
    app: HubApp
    kind: HubDeployKind
    version: string
    driver: DockerDriverRow
    /** Apply now (P4-30): the recorded image + the environment's own saved pins. */
    apply?: boolean
  },
  deps: StackGatherDeps = defaultStackGatherDeps()
): Promise<StackFacts> {
  const { env, previous, app, kind, version, driver } = ctx
  const apply = ctx.apply === true
  const versionOk = VERSION_RE.test(version)
  /** rollback: the image the rolled-back-to deploy ran (P4-29); undefined = not read. */
  let deployedImage: string | null | undefined
  /** Apply now: why the recorded build cannot be redeployed (P4-35). */
  let applyProblem: { code: 'STACK_STATE_UNKNOWN'; text: string } | null = null

  // Decision 10: promote installs the tested set (the previous environment's; the first
  // environment its own), rollback the set the rolled-back-to deploy installed. Fails closed:
  // pins that cannot be read whole are a reason (EXTENSION_UNPINNED), never an empty set.
  const extensionsFor = async (): Promise<{
    pins: Record<string, string>
    unreadable: string | null
  }> => {
    const unreadable = (text: string) => ({ pins: {}, unreadable: text })
    if (kind === 'rollback') {
      if (!versionOk) return { pins: {}, unreadable: null }
      const deployed = await deps.deployedBuild(env.id, version)
      if (deployed === UNREADABLE)
        return unreadable(`the stored plan of the ${version} deploy can't be read`)
      if (deployed) {
        deployedImage = deployed.image
        return { pins: deployed.extensions, unreadable: null }
      }
      // No stored docker plan: rolling back with no extensions is right only if none run now.
      const current = await deps.extensionPins(env.id)
      if (current === UNREADABLE || Object.keys(current).length)
        return unreadable(
          `no stored plan of a ${version} deploy says which extensions it installed, and ${env.key} runs extensions now`
        )
      return { pins: {}, unreadable: null }
    }
    if (apply && versionOk) {
      // Apply now: the image the stack last converged to (any outcome of that deploy, P4-35),
      // which must be the version it runs; the pins saved here now.
      const name = await deps.stackName(c.placement_id)
      const rec: DeployedStack = name ? await deps.recordedStack(env.id, name) : { state: 'none' }
      if (rec.state === 'unreadable')
        applyProblem = {
          code: 'STACK_STATE_UNKNOWN',
          text: `the Hub cannot tell which build ${env.key} runs — its newest recorded deploy can't be read`
        }
      else if (rec.state === 'ok' && rec.version !== version)
        applyProblem = {
          code: 'STACK_STATE_UNKNOWN',
          text: `the newest recorded deploy of ${env.key} ran ${rec.version}, not ${version} — deploy a version instead`
        }
      else if (rec.state === 'ok') deployedImage = rec.image
    }
    const from = apply ? env : (previous ?? env)
    const pins = await deps.extensionPins(from.id)
    if (pins === UNREADABLE)
      return unreadable(`the stored extension pins of ${from.key} can't be read`)
    return { pins, unreadable: null }
  }
  const [stackName, row, taken, ext] = await Promise.all([
    deps.stackName(c.placement_id),
    deps.readStackSettings(env.id),
    deps.otherEnvironmentNames(env.id),
    extensionsFor()
  ])
  const extensions = ext.pins
  // A rollback runs the recorded image (its repository too, even if HUB_IMAGE changed since).
  const imageRepo = deployedImage ? deployedImage.slice(0, deployedImage.indexOf('@')) : hubImage()

  const masked = publicStackSettings(row)
  const record = deps.databaseRecord ? await deps.databaseRecord(env.id) : null
  const fromRecord = { databaseRecord: record !== null }
  const settingsMissing = !row
    ? ['(no settings)']
    : masked?.secrets_error
      ? ['(stack secrets cannot be opened)', ...missingSettings(row, {}, fromRecord)]
      : missingSettings(row, masked?.secrets ?? {}, fromRecord)
  if (record && !record.ready) settingsMissing.push(`(database ${record.name} is not ready)`)

  const facts: StackFacts = {
    stackName,
    agent: 'unreachable',
    imageAllowed: false,
    imageRepo,
    disallowedExtensions: [],
    settingsMissing,
    hostnameProblems: [],
    hostnameTaken: [],
    edge: null,
    publishPortProblem: null,
    renderProblem: null,
    stackState: 'unknown',
    size: row?.size ?? null,
    roles: null,
    extensions,
    extensionsUnreadable: ext.unreadable,
    ...((kind === 'rollback' || apply) && versionOk
      ? {
          deployedImage: deployedImage ?? null,
          // A recorded deploy without its image: nothing to redeploy. For a rollback no record at
          // all is the plan's NOT_DEPLOYED_BEFORE, an unreadable plan EXTENSION_UNPINNED.
          recordedImageProblem: applyProblem
            ? applyProblem
            : deployedImage === null
              ? {
                  code: 'ROLLBACK_NOT_RECORDED' as const,
                  text: `the Hub did not record which image the ${version} deploy ran here, so it cannot redeploy that build`
                }
              : apply && deployedImage === undefined && !ext.unreadable
                ? {
                    code: 'NOT_DEPLOYED' as const,
                    text: `${env.key} has no recorded Hub deploy of ${version} — deploy it first`
                  }
                : null
        }
      : {}),
    missingExtensions: ext.unreadable ? [] : app.extensions.filter((id) => !extensions[id]).sort(),
    agentOrigin: agentOrigin(driver.config?.agent_url)
  }

  let health: AgentHealth | null = null
  try {
    health = await deps.agentHealth(driver)
    facts.agent = 'ok'
  } catch (err) {
    facts.agent = agentStateOf(err)
  }

  if (health) {
    const images = Array.isArray(health.images) ? health.images : []
    facts.edge = health.edge === 'publish' ? 'publish' : 'traefik'
    facts.imageAllowed = images.includes(imageRepo)
    facts.disallowedExtensions = Object.entries(extensions)
      .filter(([, pin]) => !images.includes(pin.slice(0, pin.indexOf('@'))))
      .map(([id]) => id)
      .sort()
    facts.publishPortProblem = publishPortProblem(health, row)
  }

  // Which names a stack routes depends on the agent's edge (publish routes none of the base
  // host): with the agent down the edge is unknown, so names are judged once it answers and
  // AGENT_UNREACHABLE stands alone.
  if (health) {
    const edge = facts.edge ?? 'traefik'
    const refusals = hostnameRefusals(stackHostnames(env, edge), driver.config, {
      taken,
      hostSuffixes: edge === 'traefik' ? health.host_suffixes : undefined,
      edge
    })
    facts.hostnameTaken = refusals.filter((p) => p.code === 'HOSTNAME_TAKEN').map((p) => p.message)
    facts.hostnameProblems = refusals
      .filter((p) => p.code !== 'HOSTNAME_TAKEN')
      .map((p) => p.message)
  }

  if (row && versionOk) {
    try {
      // The agent decides whether a large stack gets its exporter (stackRoles).
      facts.roles = stackRoles(version, row.size, health?.agent_version)
    } catch (err) {
      if (!(err instanceof StackTemplateError)) throw err
      facts.renderProblem = { code: 'TEMPLATE_NONE', text: err.message }
    }
  }
  // A dry render over masked values: the stored settings make a spec the agent takes.
  if (row && health && facts.roles) {
    try {
      const secrets: Record<string, string> = {}
      for (const k of Object.keys(masked?.secrets ?? {})) secrets[k] = HUB_MASK
      renderStackSpec({
        app,
        env,
        driver: driver.config,
        edge: facts.edge ?? 'traefik',
        row,
        secrets,
        hubToken: HUB_MASK,
        version,
        image: `${imageRepo}@${DRY_DIGEST}`,
        extensions,
        hubPublicUrl: null,
        agentVersion: health.agent_version,
        agentVolumeNfs: health.volume_nfs,
        agentExportMount: health.export_mount
      })
    } catch (err) {
      if (!(err instanceof StackRenderError)) throw err
      if (!RENDER_CODES_NAMED_ELSEWHERE.has(err.code))
        facts.renderProblem = { code: err.code, text: err.message }
    }
  }

  const hubWarning = (deps.hubUrlWarning ?? (() => hubUrlBootWarning()))()
  if (hubWarning) facts.warnings = [{ code: 'HUB_URL_PROBLEM', text: hubWarning }]

  if (health && stackName) {
    try {
      facts.stackState = stackStateOf(await deps.agentStack(driver, stackName), app, env)
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      facts.stackState =
        code === 'STACK_NOT_HUB'
          ? 'not_hub'
          : code === 'STACK_OWNER_MISMATCH'
            ? 'other_owner'
            : 'unknown'
    }
  }
  return facts
}

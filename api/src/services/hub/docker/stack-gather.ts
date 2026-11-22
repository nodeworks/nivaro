import { db } from '../../../db/index.js'
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
import {
  missingSettings,
  otherEnvironmentNames,
  publicStackSettings,
  readStackSettings,
  type StackSettingsRow
} from './stack-settings.js'
import { StackTemplateError, templateFor } from './templates.js'

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
  /** nivaro_hub_environments.extension_pins of an environment. */
  extensionPins(envId: number): Promise<Record<string, string>>
  /** The extension pins the stored plan of `envId`'s newest successful deploy of `version` installed. */
  deployedExtensions(envId: number, version: string): Promise<Record<string, string> | null>
}

/** id → pin, keeping only well-formed pairs (the agent checks the rest). */
export function pinMap(raw: unknown): Record<string, string> {
  const v = typeof raw === 'string' ? parseJson(raw) : raw
  const out: Record<string, string> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [id, pin] of Object.entries(v as Record<string, unknown>)) {
    if (EXTENSION_ID_RE.test(id) && typeof pin === 'string' && PIN_RE.test(pin)) out[id] = pin
  }
  return out
}

async function readExtensionPins(envId: number): Promise<Record<string, string>> {
  const row = (await db(ENVS).where({ id: envId }).first('extension_pins')) as
    | { extension_pins: unknown }
    | undefined
  return pinMap(row?.extension_pins)
}

/** From the stored plans of successful deploys, newest first: the first stack step's extensions. */
async function readDeployedExtensions(
  envId: number,
  version: string
): Promise<Record<string, string> | null> {
  const rows = (await db(DEPLOYS)
    .where({ environment_id: envId, status: 'success', version })
    .orderBy('id', 'desc')
    .select('plan')) as Array<{ plan: string | null }>
  for (const r of rows) {
    try {
      const plan = JSON.parse(String(r.plan ?? '')) as {
        steps?: Array<{ driver?: string; stack?: { extensions?: unknown } }>
      }
      const step = (plan.steps ?? []).find((s) => s.driver === 'docker' && s.stack)
      if (step?.stack) return pinMap(step.stack.extensions)
    } catch {
      /* an unreadable plan proves nothing */
    }
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
      const name = (await getPlacement(placementId))?.target.stack
      return typeof name === 'string' && STACK_NAME_RE.test(name) ? name : null
    },
    extensionPins: readExtensionPins,
    deployedExtensions: readDeployedExtensions
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

function publishPortProblem(health: AgentHealth, row: StackSettingsRow | null): string | null {
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
  },
  deps: StackGatherDeps = defaultStackGatherDeps()
): Promise<StackFacts> {
  const { env, previous, app, kind, version, driver } = ctx
  const imageRepo = hubImage()
  const versionOk = VERSION_RE.test(version)

  // Decision 10: promote installs the tested set (the previous environment's; the first
  // environment its own), rollback the set the rolled-back-to deploy installed.
  const extensionsFor = async (): Promise<Record<string, string>> => {
    if (kind === 'rollback')
      return versionOk ? ((await deps.deployedExtensions(env.id, version)) ?? {}) : {}
    return deps.extensionPins(previous ? previous.id : env.id)
  }
  const [stackName, row, taken, extensions] = await Promise.all([
    deps.stackName(c.placement_id),
    deps.readStackSettings(env.id),
    deps.otherEnvironmentNames(env.id),
    extensionsFor()
  ])

  const masked = publicStackSettings(row)
  const settingsMissing = !row
    ? ['(no settings)']
    : masked?.secrets_error
      ? ['(stack secrets cannot be opened)', ...missingSettings(row, {})]
      : missingSettings(row, masked?.secrets ?? {})

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
    missingExtensions: app.extensions.filter((id) => !extensions[id]).sort(),
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

  // The driver's wildcard rule always; the agent's suffixes only once it said them (traefik).
  const edge = facts.edge ?? 'traefik'
  const refusals = hostnameRefusals(stackHostnames(env, edge), driver.config, {
    taken,
    hostSuffixes: health && edge === 'traefik' ? health.host_suffixes : undefined,
    edge
  })
  facts.hostnameTaken = refusals.filter((p) => p.code === 'HOSTNAME_TAKEN').map((p) => p.message)
  facts.hostnameProblems = refusals.filter((p) => p.code !== 'HOSTNAME_TAKEN').map((p) => p.message)

  if (row && versionOk) {
    try {
      facts.roles = structuredClone(templateFor(version).sizes[row.size])
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
        hubPublicUrl: null
      })
    } catch (err) {
      if (!(err instanceof StackRenderError)) throw err
      if (!RENDER_CODES_NAMED_ELSEWHERE.has(err.code))
        facts.renderProblem = { code: err.code, text: err.message }
    }
  }

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

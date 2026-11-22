import { db } from '../../../db/index.js'
import { hubPublicOrigin } from '../../deployment-mode.js'
import { environmentFromRow, type HubApp, readApp } from '../apps.js'
import { type DockerDriverRow, getDriver, getPlacement, STACK_NAME_RE } from '../drivers.js'
import { markNameServing, markWaitingForName } from '../name-check.js'
import { readServedField, type ServedField } from '../promote-gather.js'
import { PromotionError } from '../promote-lock.js'
import { urlForLog } from '../promote-plan.js'
import type { RunContext } from '../promote-run.js'
import type { HubEnvironmentRow, PromotionStep } from '../promote-types.js'
import { openSecret } from '../secrets.js'
import { type HubEnvStatus, type HubStatusTarget, readEnvironmentStatus } from '../status.js'
import {
  AgentError,
  agentApply,
  agentHealth,
  agentStack,
  describeAgentError
} from './agent-client.js'
import type { AgentHealth, StackSpec, StackStatus } from './agent-types.js'
import { agentOrigin } from './driver-config.js'
import { lookName, type NameState, nameRequest } from './name-check.js'
import {
  hostnameRefusals,
  renderStackSpec,
  StackRenderError,
  stackHostnames
} from './render-spec.js'
import { type DatabaseRecordEnv, databaseRecordId } from './stack-env.js'
import { publishPortProblem, strictPinMap } from './stack-gather.js'
import {
  missingSettings,
  openStackSecrets,
  otherEnvironmentNames,
  readStackSettings,
  type StackSettingsRow
} from './stack-settings.js'
import { StackTemplateError } from './templates.js'

/**
 * The runner's docker step (Hub phase 4): one stack component deployed through the Hub agent.
 *
 *   deploy   everything is read fresh inside the step (environment, placement, driver, stack
 *            settings) and the agent's GET /v1/health is asked again: the plan's facts are a
 *            snapshot, so an agent whose edge, publish range, host suffixes or image allow-list
 *            no longer fit the settings is refused here, before any write. The secrets and hub
 *            token are opened, the spec rendered and PUT (cancel is asked once more right before
 *            the PUT); from then on the step waits for swarm — every 10 s, ≤ 30 min — and never
 *            stops half way: converged, rolled back or paused. Three unanswered polls in a row =
 *            AGENT_UNREACHABLE (one blip is tolerated). On converged the target's `version_pin`
 *            and `extension_pins` are written and the step answers what the stack runs (spec
 *            hash, image, pins); the runner records it through its `deployed` event, like a
 *            GitLab deploy's commit (`deployedSha` = the spec hash, plus `deployedSpecHash`,
 *            `deployedImage` and the pins in the stored plan).
 *   verify   the name serves: /api/version answers the version twice (≤ 40 × 15 s), then the
 *            hub-link preflight must not fail. Manual DNS and the name not serving yet: success
 *            with a warning, the environment waits for its name (phase 3 owns that status).
 *            Automatic DNS never skips verify.
 *
 * The rendered spec carries the stack's secrets in plain text: it lives only inside `deploy`,
 * goes only to the agent, and is never logged, stored or put in an error. Log lines and errors
 * are built from codes, names and what the Hub itself knows — never the agent's body text.
 */

export const STACK_DEPLOY_MINUTES = 30
export const STACK_POLL_MS = 10_000
/** Polls the agent may miss in a row before the step fails AGENT_UNREACHABLE. */
export const STACK_POLL_MISSES = 3
/** Same as promote-run.ts VERIFY_POLLS / VERIFY_POLL_MS (phase-2 verify). */
const VERIFY_POLLS = 40
const VERIFY_POLL_MS = 15_000

const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'
const PIN_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/
const HASH_RE = /^[0-9a-f]{64}$/

export type StepLog = (line: string, level?: 'info' | 'warn' | 'error') => Promise<void>

export interface DockerDeployHooks {
  /** Asked right before the agent PUT; true = stop there (nothing applied). */
  beforeApply?: () => Promise<boolean>
}

/** What a converged docker step runs: the runner records it (its `deployed` event). */
export interface StackDeployed {
  /** The agent's spec hash: the step's `deployedSha`. */
  specHash: string
  /** <repo>@sha256:<64 hex> */
  image: string
  /** id → <repo>@sha256:<64 hex> */
  extensions: Record<string, string>
}

export interface DockerStepOps {
  /** null = stopped before the agent PUT (nothing applied); else what now runs. */
  deploy(
    s: PromotionStep,
    ctx: RunContext,
    log: StepLog,
    hooks?: DockerDeployHooks
  ): Promise<StackDeployed | null>
  verify(s: PromotionStep, ctx: RunContext, log: StepLog): Promise<void>
}

export interface AgentOps {
  agentHealth: typeof agentHealth
  agentStack: typeof agentStack
  agentApply: typeof agentApply
}

export interface DockerOpsDeps {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  agent?: Partial<AgentOps>
  readServedField?: (url: string, field: string) => Promise<ServedField>
  /** A fresh status read of the environment (hub link: version + preflight). */
  readStatus?: (env: HubStatusTarget) => Promise<HubEnvStatus>
  /** One look at the name (DNS, then /api/version); default lookName over `readServedField`. */
  lookName?: (env: { base_url: string }, version: string | null) => Promise<NameState>
  /** The DNS look the default lookName uses (tests). */
  dnsLookup?: (host: string) => Promise<unknown>
  /** Every name the OTHER Hub environments claim (HOSTNAME_TAKEN). */
  otherEnvironmentNames?: (envId: number) => Promise<Set<string>>
  /** The Hub's own origin; default deployment-mode.ts hubPublicOrigin() (ruling X-5). */
  hubPublicUrl?: () => string | null
  /**
   * Opens a phase 3 database record (db_ref `hub-db:<id>`) as the stack's DB_CLIENT + DB_URL;
   * default: services/hub/db openDatabaseConnection. Only the run opens it, never a plan.
   */
  openDatabase?: (id: number) => Promise<DatabaseRecordEnv>
}

/** Opens a database record for the run; its errors become PromotionErrors with their code. */
async function openDatabaseRecord(id: number): Promise<DatabaseRecordEnv> {
  const [{ openDatabaseConnection }, { connectionUrl }] = await Promise.all([
    import('../db/databases.js'),
    import('../db/connection.js')
  ])
  const conn = await openDatabaseConnection(id)
  return { client: conn.engine, url: connectionUrl(conn) }
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

/**
 * The HUB_URL a stack gets (ruling X-5): deployment-mode.ts hubPublicOrigin() — HUB_URL by the one
 * HUB_URL rule, else PUBLIC_URL's origin — the address created apps are told and the Hub issues
 * its sign-in tokens from.
 */
function envHubUrl(): string | null {
  return hubPublicOrigin()
}

/** Codes that pass through as they are; any other error becomes a PromotionError here. */
function asPromotionError(err: unknown, ctx: { stack: string; hostnames?: string[] }): unknown {
  if (err instanceof AgentError) return new PromotionError(err.code, describeAgentError(err, ctx))
  if (err instanceof StackRenderError || err instanceof StackTemplateError)
    return new PromotionError(err.code, err.message)
  return err
}

// ── the spec, rendered fresh ─────────────────────────────────────────────────────────────────

/** What a deploy (or a restart) asks to run. */
export interface StackWant {
  name: string
  driverId: number
  version: string
  /** <repo>@sha256:<64 hex> */
  image: string
  /** id → <repo>@sha256:<64 hex> */
  extensions: Record<string, string>
  /** The agent origin the plan saw; a different one now is refused (AGENT_CHANGED). */
  agentOrigin?: string
}

export interface PreparedStack {
  env: HubEnvironmentRow
  app: HubApp
  driver: DockerDriverRow
  origin: string
  health: AgentHealth
  row: StackSettingsRow
  /** Plain-text secrets inside: send it to the agent, never log or store it. */
  spec: StackSpec
}

/** Repository of a `<repo>@sha256:…` pin. */
const repoOf = (pin: string) => pin.slice(0, pin.indexOf('@'))

/**
 * Why the agent, as it answers NOW, no longer takes this deploy (empty = it does). The plan
 * checked the same with the health of its time; the agent's config may have changed since.
 */
function fitProblems(
  want: StackWant,
  env: HubEnvironmentRow,
  driver: DockerDriverRow,
  health: AgentHealth,
  row: StackSettingsRow,
  taken: Set<string>
): Array<{ code: string; text: string }> {
  const out: Array<{ code: string; text: string }> = []
  const images = Array.isArray(health.images) ? health.images : []
  if (!images.includes(repoOf(want.image)))
    out.push({
      code: 'IMAGE_NOT_ALLOWED',
      text: `the agent no longer allows ${repoOf(want.image)}`
    })
  for (const [id, pin] of Object.entries(want.extensions).sort(([a], [b]) => a.localeCompare(b)))
    if (!images.includes(repoOf(pin)))
      out.push({
        code: 'EXTENSION_NOT_ALLOWED',
        text: `the agent no longer allows extension ${id} (${repoOf(pin)})`
      })
  const edge = health.edge === 'publish' ? 'publish' : 'traefik'
  for (const p of hostnameRefusals(stackHostnames(env, edge), driver.config, {
    taken,
    hostSuffixes: edge === 'traefik' ? health.host_suffixes : undefined,
    edge
  }))
    out.push({
      code: p.code === 'HOSTNAME_TAKEN' ? 'HOSTNAME_TAKEN' : 'HOSTNAME_NOT_ALLOWED',
      text: p.message
    })
  const port = publishPortProblem(health, row)
  if (port) out.push({ code: 'PUBLISH_PORT_NOT_ALLOWED', text: port })
  return out
}

/**
 * Reads everything fresh and renders the spec the agent gets: the environment, its placement
 * (still this driver and stack name), the driver (still the agent the plan saw), the stack
 * settings, the agent's health NOW, the opened secrets and hub token. Refuses with a
 * PromotionError before anything is written anywhere. Also for a restart (ruling P4-16): pass
 * what the stack runs (version_pin, the recorded image, extension_pins).
 */
export async function prepareStackSpec(
  envId: number,
  want: StackWant,
  deps: DockerOpsDeps = {}
): Promise<PreparedStack> {
  const agent: AgentOps = { agentHealth, agentStack, agentApply, ...deps.agent }
  const extensions = strictPinMap(want.extensions)
  if (!STACK_NAME_RE.test(want.name) || !PIN_RE.test(want.image) || !extensions)
    throw new PromotionError(
      'PLAN_STACK_INVALID',
      'The plan does not name a usable stack, image or extension set — plan again'
    )

  const raw = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown> | undefined
  if (!raw) throw new PromotionError('NOT_FOUND', 'The environment no longer exists', 404)
  const env = environmentFromRow(raw) as HubEnvironmentRow
  const sealedHubToken = (raw.hub_token as string | null) ?? null
  const app = await readApp(env.app_id)
  if (!app) throw new PromotionError('NOT_FOUND', 'The app no longer exists', 404)

  const placement = env.placement_id ? await getPlacement(env.placement_id) : null
  if (!placement || placement.driver_id !== want.driverId || placement.target.stack !== want.name)
    throw new PromotionError(
      'STACK_CHANGED',
      `${env.key}'s placement no longer deploys stack ${want.name} through this driver — plan again`
    )
  const driver = await getDriver(want.driverId)
  if (!driver) throw new PromotionError('NO_DRIVER', 'The deploy driver no longer exists')
  if (driver.kind !== 'docker')
    throw new PromotionError('KIND_DRIVER_MISMATCH', `${want.name}: the driver is not a Docker one`)
  const origin = agentOrigin(driver.config?.agent_url)
  if (!origin)
    throw new PromotionError('NO_DRIVER', 'The Docker driver has no usable agent address')
  if (want.agentOrigin && origin !== want.agentOrigin)
    throw new PromotionError(
      'AGENT_CHANGED',
      `The driver now points at the agent at ${origin}, not ${want.agentOrigin} as planned — plan again`
    )

  const row = await readStackSettings(envId)
  if (!row) throw new PromotionError('STACK_SETTINGS_MISSING', `${env.key} has no stack settings`)

  let health: AgentHealth
  try {
    health = await agent.agentHealth(driver)
  } catch (err) {
    throw asPromotionError(err, { stack: want.name })
  }
  const taken = await (deps.otherEnvironmentNames ?? otherEnvironmentNames)(envId)
  const problems = fitProblems({ ...want, extensions }, env, driver, health, row, taken)
  if (problems.length)
    throw new PromotionError(
      problems[0].code,
      `The agent's limits no longer allow this stack (agent at ${origin}): ${problems.map((p) => p.text).join('; ')}`
    )

  const secrets = openStackSecrets(row)
  // Phase 3: a database record the environment names supplies its whole connection.
  const dbId = databaseRecordId(raw.db_ref)
  let database: DatabaseRecordEnv | null = null
  if (dbId != null) {
    try {
      database = await (deps.openDatabase ?? openDatabaseRecord)(dbId)
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      throw new PromotionError(
        typeof code === 'string'
          ? `DATABASE_${code.replace(/^DATABASE_/, '')}`
          : 'DATABASE_UNAVAILABLE',
        `${env.key}'s database (record ${dbId}) cannot be used: ${(err as Error)?.message ?? 'unknown error'}`,
        409
      )
    }
  }
  const missing = missingSettings(row, secrets, { databaseRecord: database !== null })
  if (missing.length)
    throw new PromotionError(
      'STACK_SETTINGS_MISSING',
      `${env.key}'s stack settings are missing ${missing.join(', ')}`
    )
  const hubToken = openSecret(sealedHubToken)
  if (!hubToken)
    throw new PromotionError(
      'NO_HUB_TOKEN',
      `${env.key} has no hub token — save its stack settings once to make one`
    )

  let spec: StackSpec
  try {
    spec = renderStackSpec({
      app,
      env,
      driver: driver.config,
      edge: health.edge === 'publish' ? 'publish' : 'traefik',
      row,
      secrets,
      hubToken,
      version: want.version,
      image: want.image,
      extensions,
      hubPublicUrl: (deps.hubPublicUrl ?? envHubUrl)(),
      database
    })
  } catch (err) {
    throw asPromotionError(err, { stack: want.name })
  }
  return { env, app, driver, origin, health, row, spec }
}

// ── the step ─────────────────────────────────────────────────────────────────────────────────

async function envIdOf(ctx: RunContext): Promise<number> {
  if (ctx.envId) return ctx.envId
  const r = (await db(DEPLOYS).where({ id: ctx.deployId }).first('environment_id')) as
    | { environment_id: number }
    | undefined
  if (!r) throw new PromotionError('NOT_FOUND', 'The deploy row no longer exists', 404)
  return Number(r.environment_id)
}

/** "web 1/2, worker 1/1" for a state-change line. */
function servicesLine(status: StackStatus | null): string {
  const services = Array.isArray(status?.services) ? (status?.services ?? []) : []
  if (!services.length) return ''
  return ` (${services
    .map(
      (s) =>
        `${s.role || s.name} ${Number(s.replicas?.running) || 0}/${Number(s.replicas?.desired) || 0}`
    )
    .join(', ')})`
}

/** An earlier deploy of this environment (not `deployId`) succeeded — so its verify passed. */
async function servedBefore(envId: number, deployId: number): Promise<boolean> {
  const row = await db(DEPLOYS)
    .where({ environment_id: envId, status: 'success' })
    .whereNot({ id: deployId })
    .first('id')
  return !!row
}

export function defaultDockerOps(deps: DockerOpsDeps = {}): DockerStepOps {
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  const agent: AgentOps = { agentHealth, agentStack, agentApply, ...deps.agent }
  const read = deps.readServedField ?? ((url: string, field: string) => readServedField(url, field))
  const readStatus =
    deps.readStatus ?? ((env: HubStatusTarget) => readEnvironmentStatus(env, { fresh: true }))
  const nameLook =
    deps.lookName ??
    ((env: { base_url: string }, version: string | null) =>
      lookName(env, version, {
        // Phase 3's own bounded fetch unless a reader was injected (tests).
        ...(deps.readServedField ? { readServedField: read } : {}),
        ...(deps.dnsLookup ? { lookup: deps.dnsLookup } : {})
      }))

  /** Waits for swarm on the applied spec; never stops half way. */
  const waitConverged = async (
    driver: DockerDriverRow,
    name: string,
    hash: string,
    log: StepLog
  ): Promise<StackStatus> => {
    const start = now()
    let last: string | null = null
    let misses = 0
    for (;;) {
      let status: StackStatus | null | undefined
      try {
        status = await agent.agentStack(driver, name, hash)
        misses = 0
      } catch (err) {
        if (!(err instanceof AgentError && err.code === 'AGENT_UNREACHABLE'))
          throw asPromotionError(err, { stack: name })
        misses++
        if (misses >= STACK_POLL_MISSES)
          throw new PromotionError(
            'AGENT_UNREACHABLE',
            `the Hub agent did not answer ${misses} times in a row while swarm updated ${name} — the update may still finish; check the stack before planning again`
          )
        await log(
          `stack ${name}: the agent did not answer (${misses}/${STACK_POLL_MISSES})`,
          'warn'
        )
      }
      if (status !== undefined) {
        const state = status ? status.state : 'missing'
        if (state !== last) {
          last = state
          await log(
            state === 'missing'
              ? `stack ${name}: the agent has no such stack yet`
              : `stack ${name}: ${state}${servicesLine(status)}`
          )
        }
        if (status?.state === 'converged') return status
        if (status?.state === 'rolled_back')
          throw new PromotionError(
            'SWARM_ROLLED_BACK',
            `swarm rolled ${name} back to its previous spec — the new tasks did not become healthy`
          )
        if (status?.state === 'paused')
          throw new PromotionError(
            'SWARM_UPDATE_PAUSED',
            `swarm paused the update of ${name} — a new task failed; roll back, or fix it and deploy again`
          )
      }
      if (now() - start >= STACK_DEPLOY_MINUTES * 60_000)
        throw new PromotionError(
          'STACK_DEPLOY_TIMEOUT',
          `${name} did not converge within ${STACK_DEPLOY_MINUTES} min (last: ${last ?? 'no answer'})`
        )
      await sleep(STACK_POLL_MS)
    }
  }

  const deploy: DockerStepOps['deploy'] = async (s, ctx, log, hooks = {}) => {
    const st = s.stack
    if (!st)
      throw new PromotionError('PLAN_STACK_INVALID', `${s.component}: the plan names no stack`)
    const label = `deploy ${s.component}`
    const envId = await envIdOf(ctx)
    const p = await prepareStackSpec(
      envId,
      {
        name: st.name,
        driverId: s.driverId,
        version: ctx.version,
        image: st.image,
        extensions: st.extensions,
        agentOrigin: st.agentOrigin || undefined
      },
      deps
    )
    await log(
      `${label}: the agent at ${p.origin} takes ${st.name} (${p.health.edge === 'publish' ? 'published port' : 'traefik'} edge)`
    )
    // Last chance to stop: once the PUT is sent the step waits for swarm, whatever is asked.
    if (await hooks.beforeApply?.()) return null

    let applied: Awaited<ReturnType<AgentOps['agentApply']>>
    try {
      applied = await agent.agentApply(p.driver, st.name, p.spec)
    } catch (err) {
      throw asPromotionError(err, { stack: st.name, hostnames: p.spec.hostnames })
    }
    const changed = Array.isArray(applied?.changed) ? applied.changed.length : 0
    await log(`stack ${st.name}: applied (${changed} services changed)`)
    if (typeof applied?.spec_hash !== 'string' || !HASH_RE.test(applied.spec_hash))
      throw new PromotionError(
        'AGENT_INCOMPATIBLE',
        `the Hub agent answered the apply of ${st.name} without a spec hash`
      )

    const done = await waitConverged(p.driver, st.name, applied.spec_hash, log)
    const pins = { ...st.extensions }
    try {
      await db(ENVS)
        .where({ id: envId })
        .update({
          version_pin: ctx.version,
          extension_pins: JSON.stringify(pins),
          updated_at: new Date()
        })
    } catch {
      throw new PromotionError(
        'PIN_NOT_RECORDED',
        `${st.name} converged on nivaro ${ctx.version}, but the Hub could not record the version and extension pins`
      )
    }
    const n = Object.keys(pins).length
    await log(
      `stack ${st.name}: converged — pinned nivaro ${ctx.version}${n ? ` and ${n} extension${n === 1 ? '' : 's'}` : ''}`
    )
    return {
      specHash: applied.spec_hash,
      image: typeof done.image === 'string' && PIN_RE.test(done.image) ? done.image : st.image,
      extensions: pins
    }
  }

  const verify: DockerStepOps['verify'] = async (s, ctx, log) => {
    const envId = await envIdOf(ctx)
    const raw = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown> | undefined
    if (!raw) throw new PromotionError('NOT_FOUND', 'The environment no longer exists', 404)
    const env = environmentFromRow(raw) as HubEnvironmentRow
    const driver = await getDriver(s.driverId)
    const base = env.base_url.replace(/\/+$/, '')
    const url = s.verifyUrl || `${base}/api/version`
    const where = urlForLog(url)

    const manual = driver?.kind === 'docker' && driver.config.dns_mode === 'manual'
    /**
     * P4-32: the name served before this deploy — decided from the record, never from the
     * status (every new environment starts `active`): an earlier deploy of this environment
     * succeeded, and the environment is not still waiting for its name.
     */
    const wasActive = env.status !== 'waiting_for_name' && (await servedBefore(envId, ctx.deployId))
    /** Manual DNS, the name not there (yet): the stack runs; the environment waits for it. */
    const waitForName = async (why: string) => {
      const host = (() => {
        try {
          return new URL(env.base_url).hostname
        } catch {
          return env.base_url
        }
      })()
      const ask = driver?.kind === 'docker' ? nameRequest(env, driver.config) : []
      await log(
        `verify: ${host} ${why} — the stack runs; ${env.key} waits for its name${ask.length ? ` (${ask.join('; ')})` : ''}`,
        'warn'
      )
      await markWaitingForName(envId)
    }

    // Manual DNS (ruling P4-17): the name counts as "not there yet" only when it does not resolve,
    // or when the environment never served before this deploy. A live name that answers wrong
    // once (a 502 while the edge refreshes, the old version still up) is verified like any other.
    if (manual) {
      const look = await nameLook(env, s.want)
      if (look === 'not_resolving') return waitForName('does not resolve yet')
      if (look === 'not_serving' && !wasActive)
        return waitForName(`does not serve nivaro ${s.want} yet`)
    }

    let streak = 0
    let answered = false
    for (let i = 1; ; i++) {
      const r = await read(url, s.verifyField || 'version')
      if (r.value) answered = true
      streak = r.value === s.want ? streak + 1 : 0
      if (streak >= 2) break
      if (i >= VERIFY_POLLS) {
        // Manual DNS, the name never answered at all and never served before: not there (yet).
        // A name that served before and went dark after the deploy is a failed deploy (P4-18).
        if (manual && !answered && !wasActive) return waitForName('never answered')
        if (!answered && wasActive)
          throw new PromotionError(
            'VERIFY_FAILED',
            `${s.component}: ${where} served before this deploy and has not answered since (${VERIFY_POLLS} reads, last: ${r.error ?? 'no answer'})`
          )
        throw new PromotionError(
          'VERIFY_FAILED',
          `${s.component}: ${where} never answered version = ${s.want} twice (last: ${r.value ?? r.error ?? 'no answer'})`
        )
      }
      await log(
        `verify: ${s.component} answered ${r.value ?? r.error ?? 'nothing'} (${i}/${VERIFY_POLLS})`
      )
      await sleep(VERIFY_POLL_MS)
    }
    await log(`verify: ${s.component} answers version = ${s.want} twice`)

    const status = await readStatus({
      id: envId,
      key: env.key,
      base_url: env.base_url,
      hub_token: (raw.hub_token as string | null) ?? null
    })
    if (status.preflight === 'fail')
      throw new PromotionError(
        'PREFLIGHT_FAILED',
        `preflight fails: ${status.failing?.length ? status.failing.join(', ') : '(no check named)'}`
      )
    await log(
      status.preflight
        ? `verify: ${s.component} preflight ${status.preflight}`
        : `verify: ${s.component} preflight not read (${status.error ?? status.state})`,
      status.preflight ? 'info' : 'warn'
    )
    // The name serves: an environment that waited for it is active now.
    await markNameServing(envId)
  }

  return { deploy, verify }
}

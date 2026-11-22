import { db } from '../../../db/index.js'
import { keyFingerprint } from '../../app-key-fingerprint.js'
import { type HubApp, readApp } from '../apps.js'
import { componentTargetBranch, listComponents } from '../components.js'
import { connectionUrl } from '../db/connection.js'
import { openDatabaseConnection } from '../db/databases.js'
import {
  AgentError,
  agentApply,
  agentHealth,
  agentRemove,
  agentStack,
  describeAgentError
} from '../docker/agent-client.js'
import type { StackSpec } from '../docker/agent-types.js'
import { agentOrigin } from '../docker/driver-config.js'
import { type DockerOpsDeps, prepareStackSpec } from '../docker/run-step.js'
import { databaseRecordId } from '../docker/stack-env.js'
import { strictPinMap } from '../docker/stack-gather.js'
import { deployedStack } from '../docker/stack-guards.js'
import { readStackSettings, saveStackSettings } from '../docker/stack-settings.js'
import {
  type DockerDriverRow,
  getDriver,
  getPlacement,
  type HubPlacementRow,
  STACK_NAME_RE
} from '../drivers.js'
import { sourceSubjectRe } from '../promote-gather.js'
import { driverGitCtx } from '../promote-heal.js'
import { PromotionError } from '../promote-lock.js'
import { deployComponentAt } from '../promote-run.js'
import type { PromotionStep } from '../promote-types.js'
import { hubImage, imageDigest, pinText } from '../registry.js'
import { HubSecretError, openSecret, sealSecret } from '../secrets.js'
import {
  type DeploymentClient,
  DeploymentLinkError,
  deploymentClient,
  type PullRequest,
  type PullStatus
} from '../shared/deployment-client.js'
import { replicasHolding } from '../shared/sightings.js'
import {
  getShared,
  linkUrlOrigin,
  openAppKey,
  type SharedDeployment,
  tenantIdFor
} from '../shared/store.js'
import { tenantsBody } from '../shared/tenants.js'
import type { MoveAddresses } from './addresses.js'
import { type HubLinkClient, HubLinkError, hubLinkClient, hubLinkOrigin } from './link-client.js'
import type { MovePlan, RouteAction } from './plan-port.js'
import { type HubMoveRow, MOVES, readMove } from './rows.js'
import { sharedStackRouter as defaultSharedStackRouter } from './shared-route.js'

/**
 * Nivaro Hub phase 6, Task 16: every side effect of a move, behind one injectable interface. The
 * runner (run.ts) and the rollback (rollback.ts) call only these; tests pass a fake.
 *
 * A move has two sides, each one of (Task 15 PlacementSide):
 *   shared  a shared deployment, reached over its deployment link (deployment-client.ts) with the
 *           app's tenant id (tenantIdFor); listed in its tenants by the Hub (tenants.ts);
 *   docker  a dedicated stack through the Hub agent (Docker driver), its app reached over its hub
 *           link (link-client.ts) with the environment's hub token;
 *   gitlab  a dedicated app deployed by its GitLab pipeline (Decision 9: pin + deploy job,
 *           promote-run.ts deployComponentAt), reached over its hub link.
 * Phase 6 kinds always have a shared side: to_shared (dedicated → shared), to_dedicated
 * (shared → dedicated), between_shared (shared → shared).
 *
 * Addresses (fix round 1, P6-19 C-2 / P6-18 #1): a dedicated side is reached only on the
 * address addresses.ts resolved and probed at start (steps.addresses): the source on one that
 * does not depend on the public name (or, automatic Docker traefik only, the public name while it
 * still holds it), the target on its per-move name / published port / GitLab check address. The
 * public name reaches the target only at release, after verify proved it serves the target.
 *
 * Secrets: the hub token, deployment token (inside deploymentClient), transfer tickets, the app
 * key and stack secrets are opened inside one call and never logged, stored or put in an error.
 * Every refusal is a MoveStepError (code + plain sentence) or a known safe error type.
 */

const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'

/** Strict maintenance reaches every replica of a dedicated source within 15 s (R14). */
export const MAINTENANCE_SPREAD_MS = 16_000
/** Every live replica of a shared deployment holds the new list (M10: 3 min). */
export const REPLICAS_WAIT_MS = 3 * 60_000
export const TARGET_READY_MS = 10 * 60_000
export const STACK_CONVERGE_MS = 30 * 60_000
/** A pull whose status cannot be read this long fails the step (the pull's own stall is 10 min). */
export const PULL_STATUS_GIVE_UP_MS = 10 * 60_000
const POLL_MS = 5_000
const STACK_POLL_MS = 10_000
const REFRESH_AGAIN_MS = 30_000

/** A step's refusal: a code and a plain sentence (never a value). */
export class MoveStepError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'MoveStepError'
    this.code = code
  }
}

export interface MoveOps {
  sourceMaintenance(on: boolean): Promise<void>
  targetMaintenance(on: boolean): Promise<void>
  sourceBusy(): Promise<{ imports: number; exports: number; renders: number }>
  /** Mints the ticket on the source, starts + polls the pull on the target, revokes the ticket. */
  pullFiles(mode: 'full' | 'delta'): Promise<PullStatus>
  /** Hub DB: the move's placed_at (B2) + a list refresh on a shared target. */
  placeOnTarget(): Promise<void>
  unplace(): Promise<void>
  /** refresh() + replicasHolding, ≤ 3 min (M10); no replica seen = keep waiting, never done. */
  waitReplicas(sharedId: number): Promise<void>
  /** Preflight B9: a dedicated target is never left retired from an earlier move away. */
  targetUnretire(): Promise<void>
  /** Schema ok + preflight ok + key fingerprint, ≤ 10 min. */
  targetReady(): Promise<void>
  deployTarget(): Promise<void>
  removeTarget(): Promise<void>
  route(a: RouteAction): Promise<void>
  unroute(a: RouteAction): Promise<void>
  verifyName(expect: { version: string; shared: string | null }): Promise<boolean>
  retireSource(): Promise<void>
  /** T10 carry: revokes any transfer ticket this move still holds (move end, rollback). */
  revokeTickets(): Promise<void>
  /**
   * R2: `engine|server|port|database` as that side reaches the app's database; null = cannot
   * tell. The run records the source's (hashed) at `check` and compares the target's at
   * `target_ready`: a target on another database never serves the app's name.
   */
  databaseIdentity(side: 'source' | 'target'): Promise<string | null>
}

/**
 * A move's name change on a `docker`-mode shared stack (an explicit name added or dropped),
 * through Task 5's renderer (shared-route.ts). Replaceable for tests.
 */
export type SharedStackRouter = (
  shared: SharedDeployment,
  change: { op: 'add_host' | 'drop_host'; host: string; moveId: number }
) => Promise<void>

let sharedStackRouter: SharedStackRouter = defaultSharedStackRouter()
export function setSharedStackRouter(fn: SharedStackRouter | null): void {
  sharedStackRouter = fn ?? defaultSharedStackRouter()
}

export interface MoveOpsDeps {
  client?: (shared: SharedDeployment) => DeploymentClient
  link?: (baseUrl: string, token: string | null) => HubLinkClient
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  agent?: Partial<{
    agentHealth: typeof agentHealth
    agentStack: typeof agentStack
    agentApply: typeof agentApply
    agentRemove: typeof agentRemove
  }>
  docker?: DockerOpsDeps
  imageDigest?: typeof imageDigest
  fetch?: typeof fetch
  /** A run log line (the job run's). */
  log?: (line: string, level?: 'info' | 'warn' | 'error') => void
  sharedStackRouter?: SharedStackRouter
  /** Gitlab target: one component through the promotion's own code (tests replace it). */
  deployComponent?: typeof deployComponentAt
}

type Side =
  | { kind: 'shared'; placement: HubPlacementRow; shared: SharedDeployment }
  | { kind: 'docker'; placement: HubPlacementRow; driver: DockerDriverRow; stack: string }
  | { kind: 'gitlab'; placement: HubPlacementRow }

interface Loaded {
  app: HubApp
  envKey: string
  baseUrl: string
  tenantId: string
  from: Side
  to: Side
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

/** An error's code (for a log line), never its text. */
function codeOf(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : 'ERROR'
}

/** An error turned into a MoveStepError whose message is safe to store and show. */
export function asStepError(err: unknown, fallback: string): MoveStepError {
  if (err instanceof MoveStepError) return err
  if (err instanceof DeploymentLinkError || err instanceof HubLinkError)
    return new MoveStepError(err.code, err.message)
  if (err instanceof AgentError)
    return new MoveStepError(err.code, describeAgentError(err, { stack: 'the stack' }))
  if (err instanceof PromotionError || err instanceof HubSecretError)
    return new MoveStepError(err.code, err.message)
  return new MoveStepError('STEP_FAILED', fallback)
}

async function sideOf(placementId: number): Promise<Side> {
  const placement = await getPlacement(placementId)
  if (!placement) throw new MoveStepError('PLACEMENT_GONE', 'A placement of this move is gone.')
  if (placement.kind === 'shared') {
    const shared = await getShared(placement.shared_deployment_id)
    if (!shared)
      throw new MoveStepError('SHARED_GONE', 'The shared deployment of this move is gone.')
    return { kind: 'shared', placement, shared }
  }
  const driver = await getDriver(placement.driver_id)
  if (driver?.kind === 'docker') {
    const stack = placement.target.stack
    if (typeof stack !== 'string' || !STACK_NAME_RE.test(stack))
      throw new MoveStepError('NO_STACK_NAME', 'The Docker placement names no stack.')
    return { kind: 'docker', placement, driver, stack }
  }
  if (driver?.kind === 'gitlab') return { kind: 'gitlab', placement }
  throw new MoveStepError('NO_DRIVER', 'The deploy driver of a placement of this move is gone.')
}

/** The env's hub token, opened for one call. */
async function hubToken(envId: number): Promise<string | null> {
  const r = (await db(ENVS).where({ id: envId }).first('hub_token')) as
    | { hub_token: string | null }
    | undefined
  try {
    return openSecret(r?.hub_token ?? null)
  } catch {
    throw new MoveStepError(
      'HUB_TOKEN_UNREADABLE',
      "The environment's hub token cannot be opened (wrong ENCRYPTION_KEY on the Hub, or a damaged value)."
    )
  }
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function defaultMoveOps(move: HubMoveRow, plan: MovePlan, deps: MoveOpsDeps = {}): MoveOps {
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  const clientFor = deps.client ?? ((s: SharedDeployment) => deploymentClient(s))
  const linkFor = deps.link ?? ((b: string, t: string | null) => hubLinkClient(b, t))
  const agent = { agentHealth, agentStack, agentApply, agentRemove, ...deps.agent }
  const log = (line: string, level: 'info' | 'warn' | 'error' = 'info') => {
    try {
      deps.log?.(line, level)
    } catch {
      // bookkeeping never breaks a step
    }
  }
  const envId = move.environment_id
  /** Tickets minted and not yet revoked: [revoke function]. Kept in memory only. */
  const tickets = new Map<string, () => Promise<unknown>>()
  let ticketSeq = 0

  let loaded: Promise<Loaded> | null = null
  const load = (): Promise<Loaded> => {
    loaded ??= (async () => {
      const env = (await db(ENVS).where({ id: envId }).first('app_id', 'key', 'base_url')) as
        | { app_id: number; key: string; base_url: string }
        | undefined
      if (!env) throw new MoveStepError('NOT_FOUND', 'The environment no longer exists.')
      const app = await readApp(Number(env.app_id))
      if (!app) throw new MoveStepError('NOT_FOUND', 'The app no longer exists.')
      const [from, to] = await Promise.all([
        sideOf(move.from_placement_id),
        sideOf(move.to_placement_id)
      ])
      return {
        app,
        envKey: String(env.key),
        baseUrl: String(env.base_url),
        tenantId: tenantIdFor(app, { id: envId }),
        from,
        to
      }
    })()
    loaded.catch(() => {
      loaded = null
    })
    return loaded
  }

  /** The addresses resolved and probed at start (addresses.ts), from the stored move. */
  const addresses = async (): Promise<MoveAddresses> => {
    const m = await readMove(move.id)
    const a = (m ?? move).steps.addresses ?? move.steps.addresses
    if (!a)
      throw new MoveStepError(
        'ADDRESSES_MISSING',
        'This move has no recorded addresses for its sides (it started on an older Hub); roll it back and start it again.'
      )
    return a
  }

  /**
   * C-2: the dedicated SOURCE's hub link, on the address recorded at start — never the public
   * name once the source has given it up. A public-name base (automatic Docker traefik only) is
   * refused while any route intent is recorded: the Hub moved the name, and puts it back first on
   * rollback (the undo clears the intents).
   */
  const sourceLink = async (): Promise<HubLinkClient> => {
    const a = await addresses()
    if (!a.source_link_base)
      throw new MoveStepError('SOURCE_UNREACHABLE', 'The move has no address for its source app.')
    if (a.source_link_public) {
      const m = await readMove(move.id)
      if ((m?.steps.routed ?? []).length)
        throw new MoveStepError(
          'SOURCE_UNREACHABLE',
          'The source gave its name up to the target; the Hub does not reach it there.'
        )
    }
    return linkFor(a.source_link_base, await hubToken(envId))
  }

  /** The per-move name a Docker traefik target runs on before its route (recorded at start). */
  const tempHost = async (): Promise<string | null> => (await addresses()).target_temp_host

  /** I-1: the address a dedicated TARGET answers on before its route; never the public name. */
  const targetLinkBase = async (): Promise<string> => {
    const l = await load()
    const a = await addresses()
    if (l.to.kind === 'docker' && a.target_publish_host) {
      const st = await agent.agentStack(l.to.driver, l.to.stack).catch(() => null)
      const base = st?.published_port
        ? `http://${a.target_publish_host}:${st.published_port}`
        : null
      if (base && hubLinkOrigin(base)) return base
      throw new MoveStepError('TARGET_UNREACHABLE', 'The target stack publishes no port yet.')
    }
    if (a.target_link_base) return a.target_link_base
    throw new MoveStepError('TARGET_UNREACHABLE', 'The move has no address for its target app.')
  }

  const targetLink = async (): Promise<HubLinkClient> =>
    linkFor(await targetLinkBase(), await hubToken(envId))

  /** The target over the public name: only once `verify` proved the name serves it (release). */
  const verifiedTargetLink = async (): Promise<HubLinkClient> => {
    const l = await load()
    return linkFor(l.baseUrl, await hubToken(envId))
  }

  /** A best-effort list refresh on a shared deployment (replicas poll every 30 s anyway). */
  const refresh = async (shared: SharedDeployment) => {
    try {
      await clientFor(shared).refresh()
    } catch (err) {
      log(`the shared deployment ${shared.key} did not take the refresh (${codeOf(err)})`, 'warn')
    }
  }

  // ── Docker helpers ───────────────────────────────────────────────────────────────────────

  /** The image of `version` on the registry, pinned. */
  const imageFor = async (version: string): Promise<string> => {
    const digest = await (deps.imageDigest ?? imageDigest)(hubImage(), version)
    if (!digest || digest === 'present')
      throw new MoveStepError(
        'IMAGE_UNKNOWN',
        `The registry has no pinned image for nivaro ${version}.`
      )
    return `${hubImage()}@${digest}`
  }

  /** The app's extension pins (the environment's recorded ones), only those the app uses. */
  const extensionPins = async (app: HubApp): Promise<Record<string, string>> => {
    const r = (await db(ENVS).where({ id: envId }).first('extension_pins')) as
      | { extension_pins: unknown }
      | undefined
    const pins = strictPinMap(r?.extension_pins ?? {}) ?? {}
    const out: Record<string, string> = {}
    for (const id of app.extensions) {
      if (!pins[id])
        throw new MoveStepError(
          'EXTENSION_PINS_MISSING',
          `The environment has no image pin for extension ${id}; save its extension pins first.`
        )
      out[id] = pins[id]
    }
    return out
  }

  /** R9: the stack settings carry the APP's key, never a fresh one; created when there are none. */
  const seedStackKey = async () => {
    const appKey = await openAppKey(envId)
    if (!appKey)
      throw new MoveStepError(
        'APP_KEY_UNKNOWN',
        "The Hub does not know this app's encryption key; enter it before moving."
      )
    const row = await readStackSettings(envId)
    let map: Record<string, string> = {}
    if (row?.secrets) {
      try {
        const raw = openSecret(row.secrets)
        map = raw ? (JSON.parse(raw) as Record<string, string>) : {}
      } catch {
        throw new MoveStepError(
          'STACK_SECRETS_UNREADABLE',
          "The environment's stack secrets cannot be opened on this Hub."
        )
      }
    }
    const stored = map.ENCRYPTION_KEY ? openSecret(map.ENCRYPTION_KEY) : null
    if (stored && stored.toLowerCase() === appKey) return
    if (stored)
      throw new MoveStepError(
        'APP_KEY_MISMATCH',
        "The environment's stack settings hold another ENCRYPTION_KEY than the app's own key; set it to the app's key first."
      )
    map.ENCRYPTION_KEY = sealSecret(appKey)
    await saveStackSettings(envId, {
      size: row?.size ?? 'small',
      redis: row?.redis ?? 'bundled',
      publish_port: row?.publish_port ?? null,
      settings: row?.settings ?? {},
      secrets: sealSecret(JSON.stringify(map))
    })
    log('the stack settings now carry the app’s own encryption key')
  }

  /** Renders the stack of a Docker side and applies it with `hostnames`; waits for converged. */
  const applyStack = async (
    side: Extract<Side, { kind: 'docker' }>,
    want: { version: string; image: string; extensions: Record<string, string> },
    shape: (spec: StackSpec) => void
  ): Promise<{ specHash: string; image: string }> => {
    const prepared = await prepareStackSpec(
      envId,
      { name: side.stack, driverId: side.driver.id, ...want },
      { ...deps.docker, placementId: side.placement.id }
    )
    shape(prepared.spec)
    let applied: Awaited<ReturnType<typeof agentApply>>
    try {
      applied = await agent.agentApply(prepared.driver, side.stack, prepared.spec)
    } catch (err) {
      if (err instanceof AgentError)
        throw new MoveStepError(
          err.code,
          describeAgentError(err, { stack: side.stack, hostnames: prepared.spec.hostnames })
        )
      throw err
    }
    const hash = applied?.spec_hash
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))
      throw new MoveStepError('AGENT_INCOMPATIBLE', 'The Hub agent answered without a spec hash.')
    const by = now() + STACK_CONVERGE_MS
    let misses = 0
    for (;;) {
      try {
        const st = await agent.agentStack(prepared.driver, side.stack, hash)
        misses = 0
        if (st?.state === 'converged')
          return {
            specHash: hash,
            image: typeof st.image === 'string' ? st.image : want.image
          }
        if (st?.state === 'rolled_back' || st?.state === 'paused')
          throw new MoveStepError(
            st.state === 'paused' ? 'SWARM_UPDATE_PAUSED' : 'SWARM_ROLLED_BACK',
            `Swarm did not run ${side.stack}: its new tasks did not become healthy.`
          )
      } catch (err) {
        if (err instanceof MoveStepError) throw err
        if (++misses >= 3)
          throw asStepError(err, `The agent stopped answering about ${side.stack}.`)
      }
      if (now() >= by)
        throw new MoveStepError(
          'STACK_DEPLOY_TIMEOUT',
          `${side.stack} did not converge within 30 minutes.`
        )
      await sleep(STACK_POLL_MS)
    }
  }

  /** What a Docker side's stack runs, by the Hub's own record (a re-apply renders the same). */
  const runningWant = async (side: Extract<Side, { kind: 'docker' }>) => {
    const d = await deployedStack(envId, side.stack)
    if (d.state !== 'ok')
      throw new MoveStepError(
        'STACK_STATE_UNKNOWN',
        `The Hub has no record of what ${side.stack} runs; it cannot re-apply it with other names.`
      )
    return { version: d.version, image: d.image, extensions: d.extensions }
  }

  const removeStack = async (
    side: Extract<Side, { kind: 'docker' }>,
    envKey: string,
    app: HubApp
  ) => {
    try {
      await agent.agentRemove(side.driver, side.stack, {
        removeVolumes: false,
        owner: { app: app.key, environment: envKey }
      })
    } catch (err) {
      if (err instanceof AgentError && err.code === 'STACK_NOT_FOUND') return
      throw asStepError(err, `${side.stack} could not be removed.`)
    }
  }

  /** Records the target stack on the move's deploy row, so Restart / Apply now know what runs. */
  const recordStack = async (
    side: Extract<Side, { kind: 'docker' }>,
    version: string,
    done: { specHash: string; image: string },
    extensions: Record<string, string>
  ) => {
    const row = await readStackSettings(envId)
    const step = {
      position: 0,
      component: 'stack',
      kind: 'stack',
      driver: 'docker',
      driverId: side.driver.id,
      stack: {
        name: side.stack,
        image: done.image,
        size: row?.size ?? 'small',
        extensions,
        agentOrigin: agentOrigin(side.driver.config?.agent_url) ?? ''
      },
      deployedSha: done.specHash,
      deployedSpecHash: done.specHash,
      deployedImage: done.image
    }
    await db(DEPLOYS)
      .where({ move_id: move.id })
      .update({ plan: JSON.stringify({ move_id: move.id, version, steps: [step] }) })
      .catch(() => null)
  }

  // ── Gitlab target: the promotion's own pin + deploy job (Decision 9) ──────────────────────

  const deployGitlab = async (side: Extract<Side, { kind: 'gitlab' }>, l: Loaded) => {
    const version = plan.version
    const comps = (await listComponents(side.placement.id)).filter((c) => c.kind === 'api')
    if (!comps.length)
      throw new MoveStepError('NO_API_COMPONENT', 'The GitLab placement has no API component.')
    const [digest, slim] = await Promise.all([
      (deps.imageDigest ?? imageDigest)(hubImage(), version),
      (deps.imageDigest ?? imageDigest)(hubImage(), `${version}-slim`)
    ])
    const deployRow = (await db(DEPLOYS).where({ move_id: move.id }).first('id')) as
      | { id: number }
      | undefined
    for (const c of comps) {
      const driver = await getDriver(c.driver_id)
      if (driver?.kind !== 'gitlab')
        throw new MoveStepError('NO_DRIVER', `${c.name}: its GitLab driver is gone.`)
      const ctx = await driverGitCtx(driver.id)
      const { latestCommitMatching } = await import('../gitlab-write.js')
      const src = await latestCommitMatching(ctx, c.source_branch, sourceSubjectRe(version))
      if (!src)
        throw new MoveStepError(
          'COMMIT_UNKNOWN',
          `${c.name}: ${c.source_branch} has no release commit for nivaro ${version}.`
        )
      const step: PromotionStep = {
        position: c.position,
        component: c.name,
        kind: 'api',
        driverId: driver.id,
        sourceSha: src.sha,
        targetBranch: componentTargetBranch(c, side.placement, driver.config.branch) ?? '',
        pinText: pinText(version, digest, slim),
        pinFile: driver.config.pin_file ?? null,
        beforeJob: c.before_job,
        deployJob: c.deploy_job ?? driver.config.deploy_job,
        // The move's own verify reads the public name once routed; the target is not yet.
        verifyUrl: null,
        verifyField: c.verify_field
      } as PromotionStep
      const out = await (deps.deployComponent ?? deployComponentAt)(
        step,
        version,
        {
          deployId: Number(deployRow?.id ?? 0),
          targetKey: l.envKey,
          gitCtx: driverGitCtx,
          envId
        },
        (line, level) => log(line, level)
      )
      if (out.status !== 'success')
        throw new MoveStepError(
          out.code ?? 'DEPLOY_FAILED',
          out.error ?? `${c.name} was not deployed (${out.status}).`
        )
    }
    log(
      'The GitLab target runs the version; its frontends keep what their own pipelines deployed.',
      'info'
    )
  }

  // ── the ops ──────────────────────────────────────────────────────────────────────────────

  const ops: MoveOps = {
    async sourceMaintenance(on) {
      const l = await load()
      if (l.from.kind === 'shared') {
        // The Hub list carries it (env status, B1); the replicas re-read it.
        await refresh(l.from.shared)
        return
      }
      const link = await sourceLink()
      await link.maintenance(on, move.id)
      if (on) {
        // Every source replica enforces it within its 15 s cache (R14).
        log('strict maintenance is on at the source; waiting for every replica to take it')
        await sleep(MAINTENANCE_SPREAD_MS)
      }
    },

    async targetMaintenance(on) {
      const l = await load()
      if (l.to.kind === 'shared') {
        await refresh(l.to.shared)
        return
      }
      // A Docker target boots in strict maintenance (HUB_BOOT_MAINTENANCE): only `off` is sent,
      // with the move id that releases it for good. A GitLab target is set both ways (M18).
      if (l.to.kind === 'docker' && on) return
      // `off` happens at release, after verify saw the name serve the target.
      const link = !on ? await verifiedTargetLink() : await targetLink()
      await link.maintenance(on, move.id)
    },

    async sourceBusy() {
      const l = await load()
      if (l.from.kind === 'shared')
        return (await clientFor(l.from.shared).appStatus(l.tenantId)).busy
      return (await (await sourceLink()).sharedReadiness()).busy
    },

    async pullFiles(mode) {
      const l = await load()
      // The source mints a ticket for its own transfer route.
      let source: string
      let ticket: string
      let revoke: () => Promise<unknown>
      if (l.from.kind === 'shared') {
        const sharedFrom = l.from.shared
        const origin = linkUrlOrigin(sharedFrom.link_url)
        if (!origin)
          throw new MoveStepError(
            'BAD_LINK_URL',
            "The source deployment's link address is not one the Hub may use."
          )
        source = `${origin}/api/hub-transfer/files`
        ticket = (await clientFor(sharedFrom).fileTicket(l.tenantId)).ticket
        const t = ticket
        revoke = () => clientFor(sharedFrom).revokeTicket(l.tenantId, t)
      } else {
        // The address checked pullable at start (addresses.ts), never a later public name.
        source = `${(await addresses()).pull_source}/api/hub-transfer/files`
        const link = await sourceLink()
        ticket = (await link.fileTicket()).ticket
        const t = ticket
        revoke = () => link.revokeTicket(t)
      }
      // Review minor 3: a counter, never the map's size (a kept un-revoked entry would collide).
      const key = String(++ticketSeq)
      tickets.set(key, revoke)
      const req: PullRequest = { source, ticket, mode }
      try {
        let start: () => Promise<{ run_id: string }>
        let status: (run: string) => Promise<PullStatus>
        if (l.to.kind === 'shared') {
          const c = clientFor(l.to.shared)
          start = () => c.pullFiles(l.tenantId, req)
          status = (run) => c.pullStatus(l.tenantId, run)
        } else {
          const link = await targetLink()
          start = () => link.pullFiles(req)
          status = (run) => link.pullStatus(run)
        }
        const { run_id } = await start()
        let lastRead = now()
        for (;;) {
          await sleep(POLL_MS)
          try {
            const s = await status(run_id)
            lastRead = now()
            if (s.state !== 'running') return s
          } catch (err) {
            if (now() - lastRead >= PULL_STATUS_GIVE_UP_MS)
              throw asStepError(err, 'The file copy could not be followed.')
          }
        }
      } finally {
        try {
          await revoke()
          tickets.delete(key)
        } catch (err) {
          log(
            `the transfer ticket could not be revoked yet (${codeOf(err)}); kept for the move end`,
            'warn'
          )
        }
      }
    },

    async placeOnTarget() {
      await db(MOVES)
        .where({ id: move.id })
        .update({ placed_at: new Date(now()) })
      const l = await load()
      if (l.to.kind === 'shared') await refresh(l.to.shared)
    },

    async unplace() {
      await db(MOVES).where({ id: move.id }).update({ placed_at: null })
      const l = await load()
      if (l.to.kind === 'shared') await refresh(l.to.shared)
    },

    async waitReplicas(sharedId) {
      const shared = await getShared(sharedId)
      if (!shared) throw new MoveStepError('SHARED_GONE', 'The shared deployment is gone.')
      await refresh(shared)
      const by = now() + REPLICAS_WAIT_MS
      let lastKick = now()
      let seen: { holding: string[]; behind: string[] } = { holding: [], behind: [] }
      let redisDown = false
      for (;;) {
        try {
          const fresh = (await getShared(sharedId)) ?? shared
          const { etag } = await tenantsBody(fresh)
          seen = await replicasHolding(sharedId, etag)
          redisDown = false
          // None seen = nobody polled yet: keep waiting, never "every replica holds it".
          if (seen.holding.length && !seen.behind.length) return
        } catch {
          redisDown = true
        }
        if (now() >= by)
          throw new MoveStepError(
            'REPLICAS_BEHIND',
            redisDown
              ? `The Hub could not read which replicas of ${shared.key} hold the new list (Redis).`
              : seen.behind.length
                ? `${seen.behind.length} replica(s) of ${shared.key} did not take the new list within 3 minutes.`
                : `No replica of ${shared.key} asked the Hub for its list within 3 minutes; check that it runs.`
          )
        if (now() - lastKick >= REFRESH_AGAIN_MS) {
          await refresh(shared)
          lastKick = now()
        }
        await sleep(POLL_MS)
      }
    },

    async targetUnretire() {
      const l = await load()
      if (l.to.kind === 'shared') return
      const by = now() + TARGET_READY_MS
      for (;;) {
        try {
          const link = await targetLink()
          await link.unretire()
          const st = await link.status()
          if (!st.retired) return
        } catch (err) {
          if (now() >= by) throw asStepError(err, 'The target did not answer on its hub link.')
        }
        if (now() >= by)
          throw new MoveStepError(
            'TARGET_RETIRED',
            'The target stays retired from an earlier move.'
          )
        await sleep(POLL_MS)
      }
    },

    async targetReady() {
      const l = await load()
      const fp = (
        (await db(ENVS).where({ id: envId }).first('encryption_key_fp')) as
          | { encryption_key_fp: string | null }
          | undefined
      )?.encryption_key_fp
      const by = now() + TARGET_READY_MS
      let last: MoveStepError = new MoveStepError(
        'TARGET_NOT_READY',
        'The target did not get ready within 10 minutes.'
      )
      for (;;) {
        try {
          if (l.to.kind === 'shared') {
            const c = clientFor(l.to.shared)
            const st = await c.status()
            const mine = st.apps.find((a) => a.id === l.tenantId)
            if (mine?.schema.state === 'failed')
              throw new MoveStepError(
                'SCHEMA_FAILED',
                (
                  mine.schema.error ?? 'The app could not be migrated on the shared deployment.'
                ).slice(0, 500)
              )
            if (mine?.schema.state !== 'ok') {
              last = new MoveStepError(
                'SCHEMA_PENDING',
                `The shared deployment has not finished migrating the app (${mine?.schema.state ?? 'not listed yet'}).`
              )
            } else {
              const app = await c.appStatus(l.tenantId)
              if (!app.key_fp)
                throw new MoveStepError(
                  'APP_KEY_UNKNOWN',
                  'The shared deployment holds no encryption key for this app.'
                )
              if (fp && app.key_fp !== fp)
                throw new MoveStepError(
                  'APP_KEY_MISMATCH',
                  "The shared deployment seals this app's values with another key than the app's own."
                )
              if (app.preflight.status === 'fail')
                last = new MoveStepError(
                  'PREFLIGHT_FAILING',
                  `The app's preflight fails on the target: ${app.preflight.failing.slice(0, 10).join(', ')}.`
                )
              else return
            }
          } else {
            const link = await targetLink()
            const st = await link.status()
            if (st.version !== plan.version)
              last = new MoveStepError(
                'TARGET_VERSION',
                `The target answers nivaro ${st.version}, not ${plan.version}.`
              )
            else if (st.retired)
              last = new MoveStepError('TARGET_RETIRED', 'The target is retired.')
            else if (st.preflight.status === 'fail')
              last = new MoveStepError(
                'PREFLIGHT_FAILING',
                `The app's preflight fails on the target: ${st.preflight.failing.slice(0, 10).join(', ')}.`
              )
            else {
              const r = await link.sharedReadiness()
              const appKey = await openAppKey(envId)
              const want = fp ?? (appKey ? keyFingerprint(appKey) : null)
              if (!r.key_fp || (want && r.key_fp !== want))
                throw new MoveStepError(
                  'APP_KEY_MISMATCH',
                  "The target runs with another ENCRYPTION_KEY than the app's own key."
                )
              return
            }
          }
        } catch (err) {
          if (err instanceof MoveStepError && err.code !== 'TARGET_NOT_READY') {
            if (['SCHEMA_FAILED', 'APP_KEY_MISMATCH', 'APP_KEY_UNKNOWN'].includes(err.code))
              throw err
            last = err
          } else last = asStepError(err, 'The target did not answer.')
        }
        if (now() >= by) throw last
        await sleep(POLL_MS)
      }
    },

    async deployTarget() {
      const l = await load()
      const to = l.to
      if (to.kind === 'shared') return
      if (to.kind === 'gitlab') return deployGitlab(to, l)
      await seedStackKey()
      const image = await imageFor(plan.version)
      const extensions = await extensionPins(l.app)
      const temp = await tempHost()
      const done = await applyStack(to, { version: plan.version, image, extensions }, (spec) => {
        // B5: no public name before the route; the per-move name (traefik) or nothing.
        spec.hostnames = temp ? [temp] : []
        // Decision 19: boots in strict maintenance until the move releases it.
        spec.env.HUB_BOOT_MAINTENANCE = String(move.id)
      })
      await recordStack(to, plan.version, done, extensions)
      log(`the target stack ${to.stack} runs nivaro ${plan.version}`)
    },

    async removeTarget() {
      const l = await load()
      const to = l.to
      if (to.kind === 'shared') return
      if (to.kind === 'docker') {
        await removeStack(to, l.envKey, l.app)
        log(`removed the target stack ${to.stack} (its volumes are kept)`)
        return
      }
      // A GitLab target cannot be removed by the Hub: retire it so it runs no jobs.
      try {
        await (await targetLink()).retire(move.id)
        log('the GitLab target is retired (its pipeline keeps the stack; stop it there)', 'warn')
      } catch (err) {
        log(`the GitLab target could not be retired (${codeOf(err)}); stop it in GitLab`, 'warn')
      }
    },

    async route(a) {
      const l = await load()
      const side = a.side === 'source' ? l.from : l.to
      if (side.kind === 'shared') {
        if (a.op !== 'add_host' && a.op !== 'drop_host')
          throw new MoveStepError('ROUTE_UNSUPPORTED', `A shared deployment does not take ${a.op}.`)
        const router = deps.sharedStackRouter ?? sharedStackRouter
        if (!a.host)
          throw new MoveStepError('ROUTE_UNSUPPORTED', 'A shared route change names no host.')
        await router(side.shared, { op: a.op, host: a.host, moveId: move.id })
        return
      }
      if (side.kind !== 'docker')
        throw new MoveStepError('ROUTE_UNSUPPORTED', 'A GitLab placement is routed by hand.')
      if (a.op === 'remove_stack') return removeStack(side, l.envKey, l.app)
      const want = await runningWant(side)
      // apply_stack (target): the environment's own names; drop_host (source): none.
      await applyStack(side, want, (spec) => {
        if (a.op === 'drop_host') spec.hostnames = []
        if (a.side === 'target') spec.env.HUB_BOOT_MAINTENANCE = String(move.id)
      })
    },

    async unroute(a) {
      const l = await load()
      const side = a.side === 'source' ? l.from : l.to
      if (side.kind === 'shared') {
        const router = deps.sharedStackRouter ?? sharedStackRouter
        if (!a.host || (a.op !== 'add_host' && a.op !== 'drop_host'))
          throw new MoveStepError('ROUTE_UNSUPPORTED', 'A shared route change names no host.')
        await router(side.shared, {
          op: a.op === 'add_host' ? 'drop_host' : 'add_host',
          host: a.host,
          moveId: move.id
        })
        return
      }
      if (side.kind !== 'docker')
        throw new MoveStepError('ROUTE_UNSUPPORTED', 'A GitLab placement is routed by hand.')
      const want = await runningWant(side)
      if (a.side === 'source') {
        // The source gets its own names back (as before the move).
        await applyStack(side, want, () => undefined)
        return
      }
      // The target goes back to the per-move name only.
      const temp = await tempHost()
      await applyStack(side, want, (spec) => {
        spec.hostnames = temp ? [temp] : []
        spec.env.HUB_BOOT_MAINTENANCE = String(move.id)
      })
    },

    async verifyName(expect) {
      const l = await load()
      const origin = originOf(l.baseUrl)
      if (!origin) return false
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 8_000)
      try {
        const res = await (deps.fetch ?? fetch)(`${origin}/api/version`, {
          headers: { Accept: 'application/json' },
          redirect: 'manual',
          signal: ctl.signal
        })
        if (res.status !== 200) {
          void res.body?.cancel().catch(() => {})
          return false
        }
        const b = (await res.json().catch(() => null)) as {
          version?: unknown
          shared_deployment?: unknown
          tenant?: unknown
        } | null
        if (!b || b.version !== expect.version) return false
        if (expect.shared === null) return b.shared_deployment == null
        // B3: a shared deployment answers its key and the tenant the name resolved to.
        return b.shared_deployment === expect.shared && b.tenant === l.tenantId
      } catch {
        return false
      } finally {
        clearTimeout(timer)
      }
    },

    async retireSource() {
      const l = await load()
      const from = l.from
      if (from.kind === 'shared') {
        // The list drops the app once the move's step is retire_source (tenants.ts).
        await ops.waitReplicas(from.shared.id)
        return
      }
      // A dedicated source over the address recorded at start (C-2). A Docker source that was
      // reached on its public name has given it up: its stack is removed instead.
      let retired = false
      const a = await addresses()
      if (!a.source_link_public) {
        try {
          await (await sourceLink()).retire(move.id)
          retired = true
        } catch (err) {
          log(`the source could not be retired over its hub link (${codeOf(err)})`, 'warn')
        }
      }
      if (from.kind === 'docker') {
        await removeStack(from, l.envKey, l.app)
        log(`removed the source stack ${from.stack} (its volumes are kept)`)
        return
      }
      if (!retired)
        throw new MoveStepError(
          'SOURCE_NOT_RETIRED',
          'The GitLab source could not be retired over its hub link; stop it in GitLab.'
        )
    },

    async databaseIdentity(which) {
      const l = await load()
      const side = which === 'source' ? l.from : l.to
      try {
        if (side.kind === 'shared') {
          const r = (await db(ENVS).where({ id: envId }).first('db_ref')) as
            | { db_ref: string | null }
            | undefined
          const id = databaseRecordId(r?.db_ref)
          if (id === null) return null
          const c = await openDatabaseConnection(id)
          const answer = await clientFor(side.shared).dbCheck({
            client: c.engine,
            connection: connectionUrl(c)
          })
          return answer.reachable ? answer.db_identity : null
        }
        const link = which === 'source' ? await sourceLink() : await targetLink()
        return (await link.sharedReadiness()).db_identity
      } catch (err) {
        log(`the ${which}'s database identity could not be read (${codeOf(err)})`, 'warn')
        return null
      }
    },

    async revokeTickets() {
      for (const [key, revoke] of [...tickets]) {
        try {
          await revoke()
          tickets.delete(key)
        } catch (err) {
          log(
            `a transfer ticket could not be revoked (${codeOf(err)}); it expires within 6 h`,
            'warn'
          )
        }
      }
    }
  }
  return ops
}

/** For a run's log: which shared deployments the sides of a move are on (ids), from placements. */
export async function sharedSidesOf(
  move: Pick<HubMoveRow, 'from_placement_id' | 'to_placement_id'>
): Promise<{
  from: number | null
  to: number | null
}> {
  const [from, to] = await Promise.all([
    getPlacement(move.from_placement_id),
    getPlacement(move.to_placement_id)
  ])
  return {
    from: from?.kind === 'shared' ? from.shared_deployment_id : null,
    to: to?.kind === 'shared' ? to.shared_deployment_id : null
  }
}

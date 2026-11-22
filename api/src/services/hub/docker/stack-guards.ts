import { db } from '../../../db/index.js'
import { type DockerDriverRow, getDriver, getPlacement, STACK_NAME_RE } from '../drivers.js'
import { defaultPromoteLock } from '../promote-lock.js'
import { AgentError, agentStack } from './agent-client.js'
import type { StackStatus } from './agent-types.js'
import { strictPinMap } from './stack-gather.js'

/**
 * What the Hub's Docker routes (Hub phase 4) read about an environment's stack, the guard on
 * deleting a Hub environment while its stack still runs, and the per-environment lock the
 * routes hold. Reads only, apart from the lock: nothing here writes to the Hub database or asks
 * the agent for anything but a status.
 *
 * Ownership (ruling P4-21): a placement's stack name is a claim, not proof. A stack is this
 * environment's only when the agent's status names this app's key AND this environment's key
 * (the labels the agent stamped when the Hub applied it).
 */

const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const DEPLOYS = 'nivaro_hub_deploys'
const PIN_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/
const HASH_RE = /^[0-9a-f]{64}$/

export interface DockerTarget {
  driver: DockerDriverRow
  /** The placement's swarm stack name; null when none (or an unusable one) is set. */
  stackName: string | null
  /** The keys the agent's labels must name for the stack to be this environment's. */
  appKey: string
  envKey: string
}

/**
 * The Docker driver and stack name an environment deploys through; null when the environment
 * does not exist, has no placement, or its placement's driver is not a Docker one.
 */
export async function dockerTargetOf(envId: number): Promise<DockerTarget | null> {
  const env = (await db(ENVS).where({ id: envId }).first('placement_id', 'app_id', 'key')) as
    | { placement_id: number | null; app_id: number; key: string }
    | undefined
  if (!env?.placement_id) return null
  const placement = await getPlacement(Number(env.placement_id))
  if (!placement) return null
  const driver = await getDriver(placement.driver_id)
  if (driver?.kind !== 'docker') return null
  const app = (await db(APPS).where({ id: env.app_id }).first('key')) as { key: string } | undefined
  const name = placement.target.stack
  return {
    driver,
    stackName: typeof name === 'string' && STACK_NAME_RE.test(name) ? name : null,
    appKey: String(app?.key ?? ''),
    envKey: String(env.key)
  }
}

/** The agent's status names this app and environment (ruling P4-21). */
export function ownsStack(status: StackStatus, t: Pick<DockerTarget, 'appKey' | 'envKey'>) {
  const owner = status?.owner as { app?: unknown } | undefined
  return !!t.appKey && !!t.envKey && owner?.app === t.appKey && status?.environment === t.envKey
}

export type DeployedStack =
  | { state: 'none' }
  | { state: 'unreadable' }
  | {
      state: 'ok'
      version: string
      image: string
      specHash: string | null
      /** The extension pins that same step installed (stack.extensions). */
      extensions: Record<string, string>
    }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * What swarm last converged to for this environment: the image, spec hash and extension pins
 * the runner recorded on the docker step of the newest deploy whose step carries one (run-step.ts
 * recordStackDeployed writes them only once swarm reports converged, whatever the deploy's final
 * outcome). A newest row whose plan cannot be read, or whose recorded image or pins are
 * malformed, stops the search (`unreadable`): an older deploy never stands in for it.
 * merge: phase 2's fix wave records the deployed state as an event + recorded plan; read it
 * from there when it lands.
 */
export async function deployedStack(envId: number, stackName: string): Promise<DeployedStack> {
  const rows = (await db(DEPLOYS)
    .where({ environment_id: envId })
    .whereNotNull('plan')
    .orderBy('id', 'desc')
    .limit(200)
    .select('version', 'plan')) as Array<{ version: string | null; plan: string | null }>
  for (const r of rows) {
    let plan: unknown
    try {
      plan = JSON.parse(String(r.plan ?? ''))
    } catch {
      return { state: 'unreadable' }
    }
    if (!isPlainObject(plan)) return { state: 'unreadable' }
    const steps: unknown[] = Array.isArray(plan.steps) ? plan.steps : []
    const step = steps.find(
      (x) =>
        isPlainObject(x) &&
        x.driver === 'docker' &&
        isPlainObject(x.stack) &&
        x.stack.name === stackName &&
        x.deployedImage !== undefined
    ) as (Record<string, unknown> & { stack: Record<string, unknown> }) | undefined
    if (!step) continue
    const image = step.deployedImage
    const extensions = strictPinMap(step.stack.extensions ?? {})
    if (typeof image !== 'string' || !PIN_RE.test(image) || !r.version || !extensions)
      return { state: 'unreadable' }
    const hash = step.deployedSpecHash
    return {
      state: 'ok',
      version: String(r.version),
      image,
      specHash: typeof hash === 'string' && HASH_RE.test(hash) ? hash : null,
      extensions
    }
  }
  return { state: 'none' }
}

/**
 * Runs `work` holding the environment's promotion lock (nvr:hub:promote:<envId>), so no
 * promotion starts meanwhile and none is running when it starts; `held: false` = a promotion
 * holds it now and `work` did not run.
 */
export type LockedRun<T> = { held: false } | { held: true; value: T }

export async function withEnvironmentLock<T>(
  envId: number,
  work: () => Promise<T>
): Promise<LockedRun<T>> {
  const lock = defaultPromoteLock()
  const token = await lock.take(envId)
  if (!token) return { held: false }
  try {
    return { held: true, value: await work() }
  } finally {
    await lock.release(envId, token)
  }
}

export interface DeleteRefusal {
  code: 'STACK_STILL_RUNNING' | 'AGENT_UNREACHABLE'
  message: string
}

/**
 * Why a Hub environment may not be deleted yet: its Docker stack still exists on the swarm
 * (remove it first), or the agent cannot say (unreachable, refused the token, or the token cannot
 * be opened — the stack may still run). Null for a non-docker environment, one with no stack
 * name, an agent answering 404 for the stack, a stack whose labels name another app or
 * environment, or a name the agent says a non-Hub stack uses (STACK_NOT_HUB): in those cases
 * nothing of this environment is there.
 */
export async function dockerEnvironmentDeleteRefusal(envId: number): Promise<DeleteRefusal | null> {
  const target = await dockerTargetOf(envId)
  if (!target?.stackName) return null
  const name = target.stackName
  try {
    const status = await agentStack(target.driver, name)
    if (!status || !ownsStack(status, target)) return null
    return {
      code: 'STACK_STILL_RUNNING',
      message: `The swarm still runs stack ${name} — remove the stack before deleting this environment`
    }
  } catch (err) {
    if (err instanceof AgentError && err.code === 'STACK_NOT_HUB') return null
    return {
      code: 'AGENT_UNREACHABLE',
      message: `The Hub agent could not say whether stack ${name} still runs — try again when it answers`
    }
  }
}

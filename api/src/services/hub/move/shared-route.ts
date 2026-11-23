import { db } from '../../../db/index.js'
import { hubPublicOrigin } from '../../deployment-mode.js'
import {
  AgentError,
  agentApply,
  agentHealth,
  agentStack,
  describeAgentError
} from '../docker/agent-client.js'
import { environmentNames } from '../docker/render-spec.js'
import { type DockerDriverRow, getDriver } from '../drivers.js'
import { PromotionError } from '../promote-lock.js'
import { renderSharedSpec, SharedRenderError } from '../shared/stack-render.js'
import { openSharedToken, type SharedDeployment } from '../shared/store.js'
import { tenantsOf } from '../shared/tenants.js'
import { ensureSharedSecrets } from '../shared/upgrade-run.js'

/**
 * Nivaro Hub phase 6, Task 16: a move's route change on a `docker`-mode shared deployment — one
 * explicit name added (a target whose name its pattern does not cover) or dropped (a source that
 * held the name explicitly), wired to Task 5's renderer (shared/stack-render.ts).
 *
 * The move holds the deployment's shared lock (`move`), so no upgrade or re-apply runs meanwhile;
 * a shared upgrade cannot be used here. The spec is rendered as Task 5's run renders it — the
 * version the deployment is pinned to, the image and extension pins its newest successful run at
 * that version recorded, its sealed secrets and token — with the explicit names of the apps it
 * lists (tenantsOf: a move in is listed once placed, a move out until retire_source), plus or
 * minus the one name of this change. Applied through the agent; waits for swarm to converge
 * (≤ 30 min). Every refusal is a PromotionError with a code and a plain sentence (never a token
 * or secret).
 *
 * Note: a changed name list is a service update, so swarm rolls the deployment's replicas (every
 * app on it keeps serving through the rolling update).
 */

const SHARED_DEPLOYS = 'nivaro_hub_shared_deploys'
const PIN_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/
const CONVERGE_MS = 30 * 60_000
const POLL_MS = 10_000

export interface SharedRouteDeps {
  agent?: Partial<{
    agentHealth: typeof agentHealth
    agentApply: typeof agentApply
    agentStack: typeof agentStack
  }>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

/** What the deployment's newest successful run at `version` deployed. */
async function recordedImage(
  sharedId: number,
  version: string
): Promise<{ image: string; extensions: Record<string, string> } | null> {
  const rows = (await db(SHARED_DEPLOYS)
    .where({ shared_deployment_id: sharedId, version, status: 'success' })
    .orderBy('id', 'desc')
    .limit(20)
    .select('plan')) as Array<{ plan: string | null }>
  for (const r of rows) {
    try {
      const p = JSON.parse(String(r.plan ?? '')) as { image?: unknown; extensions?: unknown }
      if (typeof p.image !== 'string' || !PIN_RE.test(p.image)) continue
      const ext =
        p.extensions && typeof p.extensions === 'object' && !Array.isArray(p.extensions)
          ? (p.extensions as Record<string, string>)
          : {}
      return { image: p.image, extensions: ext }
    } catch {
      // an unreadable plan proves nothing
    }
  }
  return null
}

export function sharedStackRouter(deps: SharedRouteDeps = {}) {
  const agent = { agentHealth, agentApply, agentStack, ...deps.agent }
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  return async (
    shared: SharedDeployment,
    change: {
      op: 'add_host' | 'drop_host'
      host: string
      moveId: number
      /** R2-M-8: the route step's own deadline (epoch ms); the 30-minute cap otherwise. */
      deadline?: number
    }
  ): Promise<void> => {
    if (shared.mode !== 'docker' || !shared.stack || shared.driver_id == null)
      throw new PromotionError(
        'ROUTE_UNSUPPORTED',
        `${shared.key} is not deployed by the Hub; its names are changed by whoever runs it.`
      )
    const found = await getDriver(shared.driver_id)
    if (found?.kind !== 'docker')
      throw new PromotionError('NO_DRIVER', 'The shared deployment names no Docker driver.')
    const driver: DockerDriverRow = found
    const version = shared.version_pin
    const recorded = version ? await recordedImage(shared.id, version) : null
    if (!version || !recorded)
      throw new PromotionError(
        'STACK_STATE_UNKNOWN',
        `The Hub has no record of what ${shared.stack} runs; deploy it once before routing a move through it.`
      )
    const token = await openSharedToken(shared.id)
    if (!token) throw new PromotionError('TOKEN_MISSING', 'The deployment token cannot be opened.')
    const secrets = await ensureSharedSecrets(shared.id)
    let edge: 'traefik' | 'publish' = 'traefik'
    try {
      edge = (await agent.agentHealth(driver)).edge === 'publish' ? 'publish' : 'traefik'
    } catch (err) {
      throw new PromotionError(
        'AGENT_UNREACHABLE',
        err instanceof AgentError
          ? describeAgentError(err, { stack: shared.stack })
          : 'The Hub agent does not answer.'
      )
    }
    const host = change.host.trim().toLowerCase()
    const names = new Set<string>()
    for (const r of await tenantsOf(shared)) for (const n of environmentNames(r.env)) names.add(n)
    if (change.op === 'add_host') names.add(host)
    else names.delete(host)
    let spec: ReturnType<typeof renderSharedSpec>
    try {
      spec = renderSharedSpec({
        shared,
        driver: driver.config,
        edge,
        secrets,
        token,
        version,
        image: recorded.image,
        extensions: { ...shared.extension_pins, ...recorded.extensions },
        hubPublicUrl: hubPublicOrigin() ?? '',
        explicitHosts: [...names]
      })
    } catch (err) {
      if (err instanceof SharedRenderError) throw new PromotionError(err.code, err.message)
      throw err
    }
    let hash: string
    try {
      hash = (await agent.agentApply(driver, shared.stack, spec)).spec_hash
    } catch (err) {
      throw new PromotionError(
        err instanceof AgentError ? err.code : 'APPLY_FAILED',
        err instanceof AgentError
          ? describeAgentError(err, { stack: shared.stack, hostnames: spec.hostnames })
          : 'The agent did not apply the shared stack.'
      )
    }
    const capped = change.deadline !== undefined && change.deadline < now() + CONVERGE_MS
    const by = capped ? (change.deadline as number) : now() + CONVERGE_MS
    let misses = 0
    for (;;) {
      try {
        const st = await agent.agentStack(driver, shared.stack, hash)
        misses = 0
        if (st?.state === 'converged') return
        if (st?.state === 'rolled_back' || st?.state === 'paused')
          throw new PromotionError(
            st.state === 'paused' ? 'SWARM_UPDATE_PAUSED' : 'SWARM_ROLLED_BACK',
            `Swarm did not run the new names on ${shared.stack}.`
          )
      } catch (err) {
        if (err instanceof PromotionError) throw err
        if (++misses >= 3)
          throw new PromotionError(
            'AGENT_UNREACHABLE',
            `The Hub agent stopped answering about ${shared.stack}.`
          )
      }
      if (now() >= by)
        throw capped
          ? new PromotionError(
              'ROUTE_TIMEOUT',
              `${shared.stack} did not run the new names within the route's 10 minutes.`
            )
          : new PromotionError(
              'STACK_DEPLOY_TIMEOUT',
              `${shared.stack} did not converge within 30 minutes.`
            )
      await sleep(POLL_MS)
    }
  }
}

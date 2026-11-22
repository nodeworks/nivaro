import { randomBytes } from 'node:crypto'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { logActivity } from '../../activity.js'
import { getApp } from '../../io-holder.js'
import { type JobRunHandle, readJobLog, resumeJobRun, startJobRun } from '../../job-runs.js'
import {
  AgentError,
  agentApply,
  agentHealth,
  agentStack,
  describeAgentError
} from '../docker/agent-client.js'
import type { AgentHealth, StackSpec, StackStatus } from '../docker/agent-types.js'
import { type DockerDriverRow, getDriver } from '../drivers.js'
import { readServedField, type ServedField } from '../promote-gather.js'
import { withoutFreshHeartbeat } from '../promote-heal.js'
import {
  appPromoteRedis,
  LOCK_RENEW_MS,
  lockHolderRefusal,
  type PromoteLock,
  type SharedLock,
  sharedLockRefusal
} from '../promote-lock.js'
import { HUB_MASK, sealSecret } from '../secrets.js'
import { DeploymentLinkError, deploymentClient } from './deployment-client.js'
import { liveSightings, type Sighting } from './sightings.js'
import { renderSharedSpec, SharedRenderError } from './stack-render.js'
import { openSharedToken, type SharedDeployment, type SharedStatus } from './store.js'
import {
  defaultSharedPlanDeps,
  gatherSharedUpgrade,
  OVERRIDABLE_CODES,
  readSharedSecrets,
  type SharedFacts,
  type SharedPlanDeps,
  SharedUpgradeError,
  type SharedUpgradeKind,
  type SharedUpgradePlan
} from './upgrade-plan.js'

/**
 * Nivaro Hub phase 6 (Task 5): the run of a Docker shared deployment's upgrade or rollback.
 *
 * Start: the confirm text is the deployment key (400 CONFIRM_MISMATCH); the plan is made again
 * and must have the hash the admin saw (409 PLAN_CHANGED, carrying the new plan); no blocker
 * (409 BLOCKED); every per-app blocker overridden (`<CODE>:<env_id>` for ORDER / PREFLIGHT_FAILING,
 * else 409 APP_BLOCKED — each override is logged). Then the deployment's shared lock (holder
 * `shared`, R10) and every listed environment's lock (holder `shared`) are taken, a
 * `nivaro_hub_shared_deploys` row (status running) and one `shared` mirror row in
 * `nivaro_hub_deploys` per environment placed here (`shared_deploy_id` set) are written, the
 * deployment's status becomes `upgrading`, and a job run starts (`hub-shared-<id>`).
 *
 * Run (heartbeat_at and every lock renewed each 60 s):
 *   1. render  — the deployment's SESSION_SECRET / ENCRYPTION_KEY made once and kept sealed on
 *                its row; the token opened; the agent asked again (edge); the spec rendered.
 *   2. apply   — PUT to the agent (cancel asked once more just before).
 *   3. wait_version ≤ 30 min — every replica the Hub saw in the last 2 min reports the version
 *                (an old replica drops out of that window once it is gone) and swarm says the
 *                stack converged; swarm rolling back or pausing the update fails at once.
 *   4. wait_schema ≤ 10 min — the deployment says every app's schema is `ok` on the version; an
 *                app whose migration failed fails the run, named by its tenant id (the others keep
 *                serving: the deployment blocks only that app).
 *   5. verify  ≤ 5 min — each active / maintenance app's public name answers /api/version = the
 *                version.
 * Success: version_pin on the deployment and on every environment placed here, the mirror rows
 * `success`, the job run complete. Failure: `failed`, naming the apps; nothing reverted (a rollback
 * is a new run of the previous version, kind `rollback`); pins unchanged. Cancel stops at the
 * next poll (`cancelled`). A lost lock stops it (`interrupted`).
 *
 * Healing (R8): a `running` row whose heartbeat is stale, that this process does not run and
 * whose shared lock nobody holds becomes `interrupted` (boot, a read, a cancel), with its mirror
 * rows — only rows with `shared_deploy_id` set (place-shared rows are place.ts's own) — and its
 * job run; the deployment's status goes back to what it was.
 *
 * Never logged, stored or answered: the token, the deployment's secrets, the rendered spec.
 */

const SHARED = 'nivaro_hub_shared_deployments'
const SHARED_DEPLOYS = 'nivaro_hub_shared_deploys'
const DEPLOYS = 'nivaro_hub_deploys'
const ENVS = 'nivaro_hub_environments'

export const VERSION_WAIT_MS = 30 * 60_000
export const SCHEMA_WAIT_MS = 10 * 60_000
export const VERIFY_WAIT_MS = 5 * 60_000
const POLL_MS = 10_000
const SCHEMA_POLL_MS = 5_000
const VERIFY_POLL_MS = 15_000
const AGENT_MISSES = 3
const CANCEL_TTL_MS = 2 * 60 * 60_000
const MAX_OVERRIDES = 200
const OVERRIDE_RE = /^([A-Z_]{1,40}):(\d{1,12})$/

export type SharedDeployStatus =
  | 'planned'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface SharedRunDeps extends Partial<SharedPlanDeps> {
  agentApply?: typeof agentApply
  agentStack?: typeof agentStack
  liveSightings?: (sharedId: number) => Promise<Sighting[]>
  status?: (shared: SharedDeployment) => ReturnType<ReturnType<typeof deploymentClient>['status']>
  readServedField?: (url: string, field: string) => Promise<ServedField>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  startJobRun?: (label: string, sharedId: number, by: string | null) => Promise<JobRunHandle>
  renewMs?: number
}

const realSleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })

// ── cancel requests (any Hub process) ─────────────────────────────────────────────────────────

const cancelKey = (id: number) => `nvr:hub:shared-cancel:${id}`
const cancelledHere = new Set<number>()

async function requestCancel(id: number): Promise<void> {
  cancelledHere.add(id)
  const r = appPromoteRedis()
  if (r)
    await Promise.resolve(r.set(cancelKey(id), '1', 'PX', CANCEL_TTL_MS)).catch(() => undefined)
}

async function cancelRequested(id: number): Promise<boolean> {
  if (cancelledHere.has(id)) return true
  const r = appPromoteRedis()
  if (!r) return false
  try {
    return (await r.get(cancelKey(id))) != null
  } catch {
    return false
  }
}

async function clearCancel(id: number): Promise<void> {
  cancelledHere.delete(id)
  const r = appPromoteRedis()
  if (r) await Promise.resolve(r.del(cancelKey(id))).catch(() => undefined)
}

// ── runs this process holds ───────────────────────────────────────────────────────────────────

const live = new Map<number, Promise<void>>()

/** Resolves when this process's run of `id` ends (tests, the reapply hook). */
export function awaitSharedUpgrade(id: number): Promise<void> {
  return live.get(id) ?? Promise.resolve()
}

// ── the deployment's own secrets ──────────────────────────────────────────────────────────────

/**
 * SESSION_SECRET and ENCRYPTION_KEY of the deployment, made once (32 random bytes, hex) and kept
 * sealed in its `secrets`; other stored secrets (REDIS_URL) are kept as they are. A write lost to
 * another run at the same moment reads the winner's.
 */
export async function ensureSharedSecrets(sharedId: number): Promise<Record<string, string>> {
  const row = await db(SHARED).where({ id: sharedId }).first('secrets')
  const have = await readSharedSecrets(sharedId)
  if (have.SESSION_SECRET && have.ENCRYPTION_KEY) return have
  const next = { ...have }
  if (!next.SESSION_SECRET) next.SESSION_SECRET = randomBytes(32).toString('hex')
  if (!next.ENCRYPTION_KEY) next.ENCRYPTION_KEY = randomBytes(32).toString('hex')
  const q = db(SHARED).where({ id: sharedId })
  if (row?.secrets == null) q.whereNull('secrets')
  else q.where({ secrets: row.secrets })
  const changed = await q.update({
    secrets: sealSecret(JSON.stringify(next)),
    updated_at: new Date()
  })
  return Number(changed) === 1 ? next : readSharedSecrets(sharedId)
}

/**
 * Writes (or with null clears) the deployment's own secrets, sealed with the rest (PATCH
 * `secrets`, ruling P6-16). Compare-and-set on the sealed text, retried, so a run making
 * SESSION_SECRET / ENCRYPTION_KEY at the same moment never loses either write.
 */
export async function setSharedSecrets(
  sharedId: number,
  patch: Record<string, string | null>
): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const row = await db(SHARED).where({ id: sharedId }).first('secrets')
    if (!row) return
    const next = { ...(await readSharedSecrets(sharedId)) }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k]
      else next[k] = v
    }
    const q = db(SHARED).where({ id: sharedId })
    if (row.secrets == null) q.whereNull('secrets')
    else q.where({ secrets: row.secrets })
    const changed = await q.update({
      secrets: Object.keys(next).length ? sealSecret(JSON.stringify(next)) : null,
      updated_at: new Date()
    })
    if (Number(changed) === 1) return
  }
  throw new SharedUpgradeError(
    'SECRETS_CHANGED',
    'The deployment secrets changed at the same moment — try again.'
  )
}

/** Which writable secrets are set: the mask, or null. Never a value. */
export async function sharedSecretsShown(
  sharedId: number
): Promise<Record<'REDIS_URL', string | null>> {
  const s = await readSharedSecrets(sharedId)
  return { REDIS_URL: s.REDIS_URL ? HUB_MASK : null }
}

// ── start ──────────────────────────────────────────────────────────────────────────────────────

export interface StartBody {
  version: string
  plan_hash: string
  confirm: string
  overrides?: string[]
  kind?: SharedUpgradeKind
}

function checkBody(raw: unknown): StartBody {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >
  if (typeof b.version !== 'string' || !b.version)
    throw new SharedUpgradeError('BAD_VERSION', 'The version is x.y.z (a Nivaro release).', 400)
  if (typeof b.plan_hash !== 'string' || !/^[0-9a-f]{64}$/.test(b.plan_hash))
    throw new SharedUpgradeError('BAD_PLAN_HASH', 'Send the plan_hash of the plan you saw.', 400)
  if (b.kind !== undefined && b.kind !== 'upgrade' && b.kind !== 'rollback')
    throw new SharedUpgradeError('BAD_KIND', 'kind is upgrade or rollback.', 400)
  let overrides: string[] = []
  if (b.overrides !== undefined) {
    if (
      !Array.isArray(b.overrides) ||
      b.overrides.length > MAX_OVERRIDES ||
      !b.overrides.every((o) => typeof o === 'string' && OVERRIDE_RE.test(o))
    )
      throw new SharedUpgradeError(
        'BAD_OVERRIDES',
        'overrides is a list of "<CODE>:<environment id>" entries.',
        400
      )
    overrides = b.overrides as string[]
  }
  return {
    version: b.version,
    plan_hash: b.plan_hash,
    confirm: typeof b.confirm === 'string' ? b.confirm : '',
    overrides,
    kind: (b.kind as SharedUpgradeKind | undefined) ?? 'upgrade'
  }
}

/** The per-app blockers left after the overrides, and the overrides that cleared one. */
function applyOverrides(
  plan: SharedUpgradePlan,
  overrides: string[]
): { open: string[]; used: string[] } {
  const given = new Set(overrides)
  const open: string[] = []
  const used: string[] = []
  for (const a of plan.apps)
    for (const code of a.blockers) {
      const o = `${code}:${a.env_id}`
      if ((OVERRIDABLE_CODES as readonly string[]).includes(code) && given.has(o)) used.push(o)
      else open.push(`${a.app}/${a.env}: ${code}`)
    }
  return { open, used }
}

export async function startSharedUpgrade(
  sharedId: number,
  rawBody: StartBody | unknown,
  by: string,
  deps: SharedRunDeps = {}
): Promise<{ shared_deploy_id: number }> {
  const body = checkBody(rawBody)
  await healSharedDeploys({ sharedId, deps })
  const planDeps = defaultSharedPlanDeps(deps)
  const { plan, facts } = await gatherSharedUpgrade(sharedId, body.version, body.kind, planDeps)
  if (body.confirm !== facts.shared.key)
    throw new SharedUpgradeError(
      'CONFIRM_MISMATCH',
      `Type the deployment key (${facts.shared.key}) to start.`,
      400
    )
  if (plan.plan_hash !== body.plan_hash)
    throw new SharedUpgradeError(
      'PLAN_CHANGED',
      'The plan changed since you saw it — check the new plan and start again.',
      409,
      plan
    )
  if (plan.blockers.length)
    throw new SharedUpgradeError(
      'BLOCKED',
      `The plan is blocked: ${plan.blockers[0].text}`,
      409,
      plan
    )
  const { open, used } = applyOverrides(plan, body.overrides ?? [])
  if (open.length)
    throw new SharedUpgradeError(
      'APP_BLOCKED',
      `Some apps are blocked and not overridden: ${open.slice(0, 5).join('; ')}.`,
      409,
      plan
    )

  const sharedLock = planDeps.sharedLock
  const envLock = planDeps.envLock
  const sharedToken = await sharedLock.take(sharedId, 'shared')
  if (!sharedToken) {
    const r = sharedLockRefusal(await sharedLock.holder(sharedId))
    throw new SharedUpgradeError(r.code, r.message)
  }
  const envTokens = new Map<number, string>()
  let handedOff = false
  /** Set once the run row exists: a start that breaks after it closes it (review minor 7). */
  let written: { id: number; prior: SharedStatus } | null = null
  try {
    for (const a of plan.apps) {
      const t = await envLock.take(a.env_id, 'shared')
      if (!t) {
        const r = lockHolderRefusal((await envLock.holder?.(a.env_id)) ?? null, {
          code: 'ENVIRONMENT_BUSY',
          message: `Another action holds ${a.app}/${a.env} — try again shortly.`
        })
        throw new SharedUpgradeError(r.code, r.message)
      }
      envTokens.set(a.env_id, t)
    }

    const at = new Date((deps.now ?? Date.now)())
    const priorStatus = facts.shared.status
    const stored = {
      plan,
      prior_status: priorStatus,
      overrides: used,
      image: facts.image,
      extensions: facts.extensions
    }
    const id = await insertReturningId(db, SHARED_DEPLOYS, {
      shared_deployment_id: sharedId,
      kind: plan.kind,
      version: plan.version,
      from_version: plan.from_version,
      status: 'running',
      step: 'render',
      plan: JSON.stringify(stored),
      started_by: by || null,
      started_at: at,
      heartbeat_at: at
    })
    const deployId = Number(id)
    written = { id: deployId, prior: priorStatus }
    const placed = facts.rows.filter((r) => r.placedHere)
    for (const r of placed)
      await db(DEPLOYS).insert({
        app_id: r.app.id,
        environment_id: r.env.id,
        kind: 'shared',
        version: plan.version,
        from_version: r.env.version_pin,
        status: 'running',
        step: 'shared upgrade',
        shared_deploy_id: deployId,
        started_by: by || null,
        started_at: at,
        heartbeat_at: at
      })
    await db(SHARED).where({ id: sharedId }).update({ status: 'upgrading', updated_at: at })

    const run = await (
      deps.startJobRun ??
      ((label, sid, who) =>
        startJobRun('deploy', `hub-shared-${sid}`, { label, triggeredBy: who ?? null }))
    )(
      `${plan.kind === 'rollback' ? 'Roll back' : 'Upgrade'} ${facts.shared.key} to ${plan.version}`,
      sharedId,
      by
    )
    if (run.id != null)
      await db(SHARED_DEPLOYS).where({ id: deployId }).update({ job_run_id: run.id })
    await logActivity({
      action: 'hub-shared-upgrade',
      user: by || null,
      collection: SHARED,
      item: String(sharedId),
      comment: JSON.stringify({
        shared_deploy: deployId,
        kind: plan.kind,
        version: plan.version,
        from: plan.from_version
      })
    }).catch(() => null)
    for (const o of used) {
      run.log(`override ${o} by ${by || 'an administrator'}`, 'warn')
      await logActivity({
        action: 'hub-shared-override',
        user: by || null,
        collection: SHARED,
        item: String(sharedId),
        comment: JSON.stringify({ shared_deploy: deployId, override: o })
      }).catch(() => null)
    }

    const ctx: RunCtx = {
      deployId,
      plan,
      facts,
      priorStatus,
      run,
      sharedLock,
      envLock,
      sharedToken,
      envTokens,
      by
    }
    const p = runInBackgroundPool(() => runUpgrade(ctx, deps)).catch((err) =>
      getApp()?.log?.error?.(
        { sharedDeploy: deployId, err: (err as Error | null)?.name ?? 'Error' },
        'hub shared upgrade bookkeeping failed'
      )
    )
    handedOff = true
    live.set(deployId, p)
    void p.finally(() => {
      if (live.get(deployId) === p) live.delete(deployId)
    })
    return { shared_deploy_id: deployId }
  } finally {
    if (!handedOff) {
      if (written) await abandonStart(written.id, sharedId, written.prior).catch(() => undefined)
      for (const [envId, t] of envTokens) await envLock.release(envId, t)
      await sharedLock.release(sharedId, sharedToken)
    }
  }
}

/** A start that broke after its rows were written: closed at once, not left for the heal. */
async function abandonStart(
  deployId: number,
  sharedId: number,
  prior: SharedStatus
): Promise<void> {
  const msg = 'START_FAILED: the run could not be started; nothing was applied.'
  const when = new Date()
  await db.transaction(async (trx) => {
    await trx(SHARED_DEPLOYS)
      .where({ id: deployId, status: 'running' })
      .update({ status: 'failed', error: msg, finished_at: when, heartbeat_at: null })
    await trx(DEPLOYS)
      .where({ shared_deploy_id: deployId, status: 'running' })
      .whereNotNull('shared_deploy_id')
      .update({ status: 'failed', error: msg, finished_at: when, heartbeat_at: null })
    await trx(SHARED)
      .where({ id: sharedId, status: 'upgrading' })
      .update({ status: prior === 'upgrading' ? 'active' : prior, updated_at: when })
  })
}

// ── the run ────────────────────────────────────────────────────────────────────────────────────

interface RunCtx {
  deployId: number
  plan: SharedUpgradePlan
  facts: SharedFacts
  priorStatus: SharedStatus
  run: JobRunHandle
  sharedLock: SharedLock
  envLock: PromoteLock
  sharedToken: string
  envTokens: Map<number, string>
  by: string
}

class Stop extends Error {
  status: 'failed' | 'cancelled' | 'interrupted'
  code: string
  constructor(status: Stop['status'], code: string, message: string) {
    super(message)
    this.name = 'Stop'
    this.status = status
    this.code = code
  }
}

async function runUpgrade(c: RunCtx, deps: SharedRunDeps): Promise<void> {
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  const { plan, facts, deployId, run } = c
  const shared = facts.shared
  const sharedId = shared.id
  const version = plan.version
  let lockLost = false

  const beat = async () => {
    try {
      if (!(await c.sharedLock.renew(sharedId, c.sharedToken))) lockLost = true
      for (const [envId, t] of c.envTokens) if (!(await c.envLock.renew(envId, t))) lockLost = true
      await db(SHARED_DEPLOYS)
        .where({ id: deployId, status: 'running' })
        .update({ heartbeat_at: new Date(now()) })
    } catch {
      // the next beat tries again
    }
  }
  const timer = setInterval(() => void beat(), deps.renewMs ?? LOCK_RENEW_MS)
  timer.unref?.()

  const step = async (name: string, line: string) => {
    run.log(line)
    await db(SHARED_DEPLOYS).where({ id: deployId, status: 'running' }).update({ step: name })
  }
  const checkpoint = async () => {
    if (lockLost) throw new Stop('interrupted', 'LOCK_LOST', 'The run lost its lock; plan again.')
    if (await cancelRequested(deployId))
      throw new Stop(
        'cancelled',
        'CANCELLED',
        'Cancelled. Whatever the agent already applied keeps running; the pins are unchanged.'
      )
  }

  try {
    // 1. render
    await step('render', `1. render ${shared.stack} at ${version}`)
    await checkpoint()
    const found = await getDriver(shared.driver_id)
    if (found?.kind !== 'docker')
      throw new Stop('failed', 'NO_DRIVER', 'The shared deployment names no Docker driver.')
    const driver: DockerDriverRow = found
    const token = await openSharedToken(sharedId)
    if (!token)
      throw new Stop(
        'failed',
        'TOKEN_MISSING',
        'The deployment token cannot be opened — rotate it, then upgrade again.'
      )
    const secrets = await ensureSharedSecrets(sharedId)
    let health: AgentHealth
    try {
      health = await (deps.agentHealth ?? agentHealth)(driver)
    } catch (err) {
      throw new Stop(
        'failed',
        'AGENT_UNREACHABLE',
        err instanceof AgentError
          ? describeAgentError(err, { stack: shared.stack ?? '' })
          : 'The Hub agent does not answer.'
      )
    }
    const edge = health.edge === 'publish' ? 'publish' : 'traefik'
    if (edge !== facts.edge)
      throw new Stop(
        'failed',
        'AGENT_CHANGED',
        "The agent's edge changed since the plan — plan again."
      )
    const hubUrl = defaultSharedPlanDeps(deps).hubPublicUrl()
    let spec: StackSpec
    try {
      spec = renderSharedSpec({
        shared,
        driver: driver.config,
        edge,
        secrets,
        token,
        version,
        image: facts.image ?? '',
        extensions: facts.extensions,
        hubPublicUrl: hubUrl ?? '',
        explicitHosts: facts.hostnames
      })
    } catch (err) {
      if (err instanceof SharedRenderError) throw new Stop('failed', err.code, err.message)
      throw err
    }
    const stackName = shared.stack as string

    // 2. apply
    await step('apply', `2. apply ${stackName} through the agent`)
    await checkpoint()
    let specHash: string
    try {
      specHash = (await (deps.agentApply ?? agentApply)(driver, stackName, spec)).spec_hash
    } catch (err) {
      throw new Stop(
        'failed',
        err instanceof AgentError ? err.code : 'APPLY_FAILED',
        err instanceof AgentError
          ? `The agent did not apply the stack: ${describeAgentError(err, { stack: stackName, hostnames: spec.hostnames })}`
          : 'The agent did not apply the stack.'
      )
    }
    await recordApplied(deployId, specHash)

    // 3. every live replica runs the version
    await step('wait_version', `3. waiting for every replica to run ${version} (≤ 30 min)`)
    const versionBy = now() + VERSION_WAIT_MS
    let misses = 0
    let lastLine = ''
    for (;;) {
      await checkpoint()
      let st: StackStatus | null | undefined
      try {
        st = await (deps.agentStack ?? agentStack)(driver, stackName, specHash)
        misses = 0
      } catch (err) {
        if (!(err instanceof AgentError && err.code === 'AGENT_UNREACHABLE')) throw err
        if (++misses >= AGENT_MISSES)
          throw new Stop(
            'failed',
            'AGENT_UNREACHABLE',
            `The Hub agent did not answer ${misses} times in a row while swarm updated ${stackName}.`
          )
      }
      if (st?.state === 'rolled_back')
        throw new Stop(
          'failed',
          'SWARM_ROLLED_BACK',
          `Swarm rolled ${stackName} back to its previous spec — the new tasks did not become healthy.`
        )
      if (st?.state === 'paused')
        throw new Stop(
          'failed',
          'SWARM_UPDATE_PAUSED',
          `Swarm paused the update of ${stackName} — a new task failed.`
        )
      let seen: Sighting[] = []
      try {
        seen = await (deps.liveSightings ?? ((id) => liveSightings(id)))(sharedId)
      } catch {
        seen = []
      }
      const behind = seen.filter((s) => s.version !== version)
      const line = `${
        seen.length
          ? `${seen.length - behind.length}/${seen.length} replicas run ${version}`
          : 'no replica seen yet'
      }; swarm ${st === undefined ? 'not answering' : (st?.state ?? 'has no such stack')}`
      if (line !== lastLine) {
        run.log(`3. ${line}`)
        lastLine = line
      }
      // Both: every live replica on the version AND swarm done replacing tasks — a same-version
      // re-apply has every sighting right at once while swarm is still rolling (review minor 6).
      const converged = st?.state === 'converged'
      if (seen.length && !behind.length && converged) break
      if (now() >= versionBy)
        throw new Stop(
          'failed',
          'VERSION_TIMEOUT',
          seen.length && !behind.length
            ? `Swarm did not finish updating ${stackName} within 30 minutes (last: ${st?.state ?? 'no answer'}).`
            : seen.length
              ? `Replicas still on another version after 30 minutes: ${behind
                  .slice(0, 5)
                  .map((s) => `${s.instance} (${s.version ?? 'unknown'})`)
                  .join(', ')}.`
              : 'No replica of the shared deployment asked the Hub for its list within 30 minutes.'
        )
      await sleep(POLL_MS)
    }

    // 4. every app's schema is ok
    await step('wait_schema', '4. waiting for every app to be migrated (≤ 10 min)')
    const schemaBy = now() + SCHEMA_WAIT_MS
    const ids = plan.apps.map((a) => a.tenant_id)
    const label = new Map(plan.apps.map((a) => [a.tenant_id, `${a.app}/${a.env} (${a.tenant_id})`]))
    const status = deps.status ?? ((s: SharedDeployment) => deploymentClient(s).status())
    let lastSchema = ''
    for (;;) {
      await checkpoint()
      let states: Map<string, { state: string; error: string | null }> | null = null
      try {
        const st = await status(shared)
        if (st.version === version)
          states = new Map(
            st.apps.map((a) => [a.id, { state: a.schema.state, error: a.schema.error }])
          )
      } catch (err) {
        if (!(err instanceof DeploymentLinkError)) throw err
      }
      if (states) {
        const failed = ids.filter((id) => states?.get(id)?.state === 'failed')
        const notDone = ids.filter((id) => {
          const s = states?.get(id)?.state
          return s !== 'ok' && s !== 'failed'
        })
        const line = `${ids.length - failed.length - notDone.length} ok, ${failed.length} failed, ${notDone.length} waiting`
        if (line !== lastSchema) {
          run.log(`4. ${line}`)
          lastSchema = line
        }
        if (!notDone.length) {
          if (failed.length)
            throw new Stop(
              'failed',
              'SCHEMA_FAILED',
              `Migrations failed for ${failed.map((id) => label.get(id)).join(', ')}: ${(
                states.get(failed[0])?.error ?? 'see the deployment status'
              ).slice(0, 300)}`
            )
          break
        }
        if (now() >= schemaBy)
          throw new Stop(
            'failed',
            'SCHEMA_TIMEOUT',
            `Not migrated within 10 minutes: ${notDone.map((id) => label.get(id)).join(', ')}${failed.length ? `; failed: ${failed.map((id) => label.get(id)).join(', ')}` : ''}.`
          )
      } else if (now() >= schemaBy)
        throw new Stop(
          'failed',
          'SCHEMA_TIMEOUT',
          `The deployment did not report ${version} with its apps' migrations within 10 minutes.`
        )
      await sleep(SCHEMA_POLL_MS)
    }

    // 5. each app's public name answers the version
    const toVerify = plan.apps.filter((a) => a.status === 'active' || a.status === 'maintenance')
    await step('verify', `5. verify ${toVerify.length} app name(s) answer ${version}`)
    const read = deps.readServedField ?? ((u: string, f: string) => readServedField(u, f))
    const verifyBy = now() + VERIFY_WAIT_MS
    let pending = toVerify
    for (;;) {
      await checkpoint()
      const answers = await Promise.all(
        pending.map(async (a) => ({
          a,
          v: await read(`${a.base_url.replace(/\/+$/, '')}/api/version`, 'version')
        }))
      )
      pending = answers.filter(({ v }) => v.value !== version).map(({ a }) => a)
      if (!pending.length) break
      if (now() >= verifyBy)
        throw new Stop(
          'failed',
          'VERIFY_FAILED',
          `These names do not answer ${version}: ${pending.map((a) => `${a.app}/${a.env} (${a.tenant_id})`).join(', ')}.`
        )
      await sleep(VERIFY_POLL_MS)
    }

    // done
    await checkpoint()
    await finish(c, 'success', null, now())
    run.log(`done: ${shared.key} runs ${version}`)
    await run.complete(`${shared.key} runs ${version}`)
  } catch (err) {
    const s =
      err instanceof Stop ? err : new Stop('failed', 'STEP_FAILED', 'The run stopped unexpectedly.')
    if (!(err instanceof Stop))
      getApp()?.log?.error?.(
        { sharedDeploy: deployId, err: (err as Error | null)?.name ?? 'Error' },
        'hub shared upgrade step failed'
      )
    await finish(c, s.status, `${s.code}: ${s.message}`, now()).catch(() => undefined)
    run.log(`${s.status}: ${s.code}: ${s.message}`, s.status === 'cancelled' ? 'warn' : 'error')
    if (s.status === 'cancelled') await run.complete(`Cancelled: ${shared.key} at ${version}`)
    else await run.fail(new Error(`${s.code}: ${s.message}`))
  } finally {
    clearInterval(timer)
    for (const [envId, t] of c.envTokens) await c.envLock.release(envId, t).catch(() => undefined)
    await c.sharedLock.release(sharedId, c.sharedToken).catch(() => undefined)
    await clearCancel(deployId)
  }
}

/** Notes what the agent applied in the stored plan (the spec hash; never the spec). */
async function recordApplied(deployId: number, specHash: string): Promise<void> {
  const row = await db(SHARED_DEPLOYS).where({ id: deployId }).first('plan')
  let stored: Record<string, unknown> = {}
  try {
    stored = JSON.parse(String(row?.plan ?? '{}')) as Record<string, unknown>
  } catch {
    /* keep going */
  }
  stored.spec_hash = /^[0-9a-f]{1,128}$/i.test(specHash) ? specHash : null
  await db(SHARED_DEPLOYS)
    .where({ id: deployId })
    .update({ plan: JSON.stringify(stored) })
}

/** The closing write: the run row, its mirror rows, the pins (success only), the status. */
async function finish(
  c: RunCtx,
  status: Exclude<SharedDeployStatus, 'planned' | 'running'>,
  error: string | null,
  at: number
): Promise<void> {
  const when = new Date(at)
  const sharedId = c.facts.shared.id
  await db.transaction(async (trx) => {
    const changed = await trx(SHARED_DEPLOYS)
      .where({ id: c.deployId, status: 'running' })
      .update({
        status,
        error: error ? error.slice(0, 1000) : null,
        finished_at: when,
        heartbeat_at: null
      })
    if (Number(changed) !== 1) return // healed meanwhile: its own write stands
    await trx(DEPLOYS)
      .where({ shared_deploy_id: c.deployId, status: 'running' })
      .whereNotNull('shared_deploy_id')
      .update({
        status,
        error: error ? error.slice(0, 1000) : null,
        finished_at: when,
        heartbeat_at: null
      })
    if (status === 'success') {
      await trx(SHARED)
        .where({ id: sharedId })
        .update({ version_pin: c.plan.version, status: 'active', updated_at: when })
      const placed = c.facts.rows.filter((r) => r.placedHere).map((r) => r.env.id)
      if (placed.length)
        await trx(ENVS)
          .whereIn('id', placed)
          .update({ version_pin: c.plan.version, updated_at: when })
    } else {
      await trx(SHARED)
        .where({ id: sharedId, status: 'upgrading' })
        .update({
          status: c.priorStatus === 'upgrading' ? 'active' : c.priorStatus,
          updated_at: when
        })
    }
  })
  await logActivity({
    action: `hub-shared-upgrade-${status}`,
    user: c.by || null,
    collection: SHARED,
    item: String(sharedId),
    comment: JSON.stringify({ shared_deploy: c.deployId, version: c.plan.version })
  }).catch(() => null)
}

// ── cancel ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Asks a running upgrade to stop at its next poll. A row nobody runs any more (not here, its
 * shared lock free, its heartbeat stale) is interrupted at once.
 */
export async function cancelSharedUpgrade(
  id: number,
  by: string,
  deps: SharedRunDeps = {}
): Promise<{ interrupted?: boolean }> {
  const row = await db(SHARED_DEPLOYS).where({ id }).first('id', 'status', 'shared_deployment_id')
  if (!row) throw new SharedUpgradeError('NOT_FOUND', 'No such shared deploy.', 404)
  if (row.status !== 'running')
    throw new SharedUpgradeError('NOT_RUNNING', 'This shared deploy is not running.')
  if (!live.has(id)) {
    const n = await healSharedDeploys({ sharedId: Number(row.shared_deployment_id), deps })
    if (n && (await db(SHARED_DEPLOYS).where({ id }).first('status'))?.status === 'interrupted')
      return { interrupted: true }
  }
  await requestCancel(id)
  await logActivity({
    action: 'hub-shared-upgrade-cancel',
    user: by || null,
    collection: SHARED,
    item: String(row.shared_deployment_id),
    comment: JSON.stringify({ shared_deploy: id })
  }).catch(() => null)
  return {}
}

// ── heal ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Marks stale running shared deploys `interrupted` (phase 2's heartbeat rule,
 * withoutFreshHeartbeat): not run by this process, the shared lock free (a held or unreadable
 * lock = maybe alive), heartbeat older than 2 min. Their mirror rows (shared_deploy_id set — never
 * a place-shared row) and job run follow; the deployment's status goes back. Answers how many.
 */
export async function healSharedDeploys(
  opts: { sharedId?: number; deps?: SharedRunDeps; message?: string } = {}
): Promise<number> {
  const deps = opts.deps ?? {}
  const now = (deps.now ?? Date.now)()
  const lock = deps.sharedLock ?? defaultSharedPlanDeps().sharedLock
  const q = db(SHARED_DEPLOYS).where({ status: 'running' })
  if (opts.sharedId != null) q.where({ shared_deployment_id: opts.sharedId })
  const rows = (await withoutFreshHeartbeat(q, now).select(
    'id',
    'shared_deployment_id',
    'step',
    'plan',
    'job_run_id',
    'started_at'
  )) as Array<Record<string, unknown>>
  let n = 0
  for (const r of rows) {
    const id = Number(r.id)
    const sharedId = Number(r.shared_deployment_id)
    if (live.has(id)) continue
    if ((await lock.holder(sharedId)) !== null) continue
    const msg = opts.message ?? `The Hub stopped during ${String(r.step ?? 'the start')}`
    const when = new Date(now)
    let prior: SharedStatus = 'active'
    try {
      const p = JSON.parse(String(r.plan ?? '{}')) as { prior_status?: unknown }
      if (typeof p.prior_status === 'string' && p.prior_status !== 'upgrading')
        prior = p.prior_status as SharedStatus
    } catch {
      /* default */
    }
    const healed = await db.transaction(async (trx) => {
      const changed = await trx(SHARED_DEPLOYS)
        .where({ id, status: 'running' })
        .update({ status: 'interrupted', error: msg, finished_at: when, heartbeat_at: null })
      if (Number(changed) !== 1) return false
      await trx(DEPLOYS)
        .where({ shared_deploy_id: id, status: 'running' })
        .whereNotNull('shared_deploy_id')
        .update({ status: 'interrupted', error: msg, finished_at: when, heartbeat_at: null })
      await trx(SHARED)
        .where({ id: sharedId, status: 'upgrading' })
        .update({ status: prior, updated_at: when })
      return true
    })
    if (!healed) continue
    n++
    if (r.job_run_id != null) {
      try {
        const at = r.started_at == null ? null : new Date(r.started_at as string)
        await resumeJobRun(Number(r.job_run_id), 'deploy', `hub-shared-${sharedId}`, {
          guardRunning: true,
          startedAt: at && Number.isFinite(at.getTime()) ? at : null
        }).fail(msg)
      } catch {
        /* bookkeeping never breaks healing */
      }
    }
  }
  return n
}

/** Heals at most `ms` before a read; never throws. */
export async function healSharedBeforeRead(sharedId?: number, ms = 3000): Promise<void> {
  try {
    await Promise.race([
      healSharedDeploys({ sharedId }),
      new Promise((r) => {
        const t = setTimeout(r, ms)
        t.unref?.()
      })
    ])
  } catch {
    /* a read never fails on its heal */
  }
}

let recovered = false

/** Once per process start (hub mode): runs the previous process left `running` are healed. */
export function recoverSharedOnceAtBoot(logger?: {
  info?: (o: unknown, msg?: string) => void
  warn?: (o: unknown, msg?: string) => void
}): void {
  if (recovered) return
  recovered = true
  void healSharedDeploys({})
    .then((n) => {
      if (n) logger?.info?.({ interrupted: n }, 'hub: shared upgrades interrupted by a restart')
    })
    .catch((err) =>
      logger?.warn?.({ err: (err as Error | null)?.name }, 'hub: shared upgrade recovery failed')
    )
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

export interface SharedDeployRead {
  id: number
  shared_deployment_id: number
  kind: string
  version: string
  from_version: string | null
  status: string
  step: string | null
  error: string | null
  job_run_id: number | null
  started_by: string | null
  started_at: string | null
  finished_at: string | null
  heartbeat_at: string | null
  plan: SharedUpgradePlan | null
  overrides: string[]
  apps: { env_id: number; app_id: number; status: string; from_version: string | null }[]
}

const isoOf = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

function readRow(r: Record<string, unknown>): Omit<SharedDeployRead, 'apps'> {
  let plan: SharedUpgradePlan | null = null
  let overrides: string[] = []
  try {
    const p = JSON.parse(String(r.plan ?? '')) as { plan?: SharedUpgradePlan; overrides?: unknown }
    plan = p.plan ?? null
    if (Array.isArray(p.overrides)) overrides = p.overrides.filter((x) => typeof x === 'string')
  } catch {
    /* an observed row has no plan */
  }
  return {
    id: Number(r.id),
    shared_deployment_id: Number(r.shared_deployment_id),
    kind: String(r.kind),
    version: String(r.version),
    from_version: r.from_version == null ? null : String(r.from_version),
    status: String(r.status),
    step: r.step == null ? null : String(r.step),
    error: r.error == null ? null : String(r.error),
    job_run_id: r.job_run_id == null ? null : Number(r.job_run_id),
    started_by: r.started_by == null ? null : String(r.started_by),
    started_at: isoOf(r.started_at),
    finished_at: isoOf(r.finished_at),
    heartbeat_at: isoOf(r.heartbeat_at),
    plan,
    overrides
  }
}

const READ_COLS = [
  'id',
  'shared_deployment_id',
  'kind',
  'version',
  'from_version',
  'status',
  'step',
  'error',
  'plan',
  'job_run_id',
  'started_by',
  'started_at',
  'finished_at',
  'heartbeat_at'
]

/** One shared deploy, with its mirror rows and job log; null when there is none. */
export async function readSharedDeploy(
  id: number
): Promise<(SharedDeployRead & { log: Awaited<ReturnType<typeof readJobLog>> }) | null> {
  const r = await db(SHARED_DEPLOYS).where({ id }).first(READ_COLS)
  if (!r) return null
  const apps = (await db(DEPLOYS)
    .where({ shared_deploy_id: id })
    .whereNotNull('shared_deploy_id')
    .orderBy('environment_id')
    .select('environment_id', 'app_id', 'status', 'from_version')) as Record<string, unknown>[]
  const base = readRow(r)
  const log = base.job_run_id == null ? [] : await readJobLog(base.job_run_id).catch(() => [])
  return {
    ...base,
    apps: apps.map((a) => ({
      env_id: Number(a.environment_id),
      app_id: Number(a.app_id),
      status: String(a.status),
      from_version: a.from_version == null ? null : String(a.from_version)
    })),
    log
  }
}

/** A deployment's shared deploys, newest first (no plan text). */
export async function listSharedDeploys(
  sharedId: number,
  limit = 20
): Promise<Omit<SharedDeployRead, 'apps' | 'plan'>[]> {
  const rows = (await db(SHARED_DEPLOYS)
    .where({ shared_deployment_id: sharedId })
    .orderBy('id', 'desc')
    .limit(Math.max(1, Math.min(100, limit)))
    .select(READ_COLS)) as Record<string, unknown>[]
  return rows.map((r) => {
    const { plan: _plan, ...rest } = readRow(r)
    return rest
  })
}

// ── re-apply after a token rotation (routes/hub-shared.ts setSharedReapply) ────────────────────

/**
 * Applies the stack again at the version it runs, so the deployment gets the new token (preflight
 * R7). The same run as an upgrade (kind `upgrade`, same version: no per-app checks). Not started
 * when the plan has a blocker (reason = its code), the deployment was never deployed, or its
 * newest run failed or was interrupted (LAST_RUN_FAILED: the stack may run another version than
 * the pin, so re-applying the pin would roll it back unannounced).
 */
export async function startSharedReapply(
  shared: SharedDeployment,
  by: string,
  deps: SharedRunDeps = {}
): Promise<{ started: boolean; reason?: string; shared_deploy_id?: number }> {
  if (shared.mode !== 'docker') return { started: false, reason: 'SHARED_NOT_HUB_DEPLOYED' }
  if (!shared.version_pin) return { started: false, reason: 'NOT_DEPLOYED' }
  // After a failed or interrupted run the stack may run another version than the pin: applying
  // the pin again would be a rollback nobody asked for (review minor 4). Upgrade or roll back.
  const last = await db(SHARED_DEPLOYS)
    .where({ shared_deployment_id: shared.id })
    .whereNot({ kind: 'observed' })
    .orderBy('id', 'desc')
    .first('status', 'plan')
  // A cancel after the agent applied (spec_hash recorded) leaves the stack on the new image too.
  const applied = /"spec_hash":"[0-9a-f]/i.test(String(last?.plan ?? ''))
  if (
    last &&
    (last.status === 'failed' ||
      last.status === 'interrupted' ||
      (last.status === 'cancelled' && applied))
  )
    return { started: false, reason: 'LAST_RUN_FAILED' }
  const plan = (await gatherSharedUpgrade(shared.id, shared.version_pin, 'upgrade', deps)).plan
  if (plan.blockers.length) return { started: false, reason: plan.blockers[0].code }
  const overrides = plan.apps.flatMap((a) => a.blockers.map((b) => `${b}:${a.env_id}`))
  try {
    const { shared_deploy_id } = await startSharedUpgrade(
      shared.id,
      { version: plan.version, plan_hash: plan.plan_hash, confirm: shared.key, overrides },
      by,
      deps
    )
    return { started: true, shared_deploy_id }
  } catch (err) {
    if (err instanceof SharedUpgradeError) return { started: false, reason: err.code }
    throw err
  }
}

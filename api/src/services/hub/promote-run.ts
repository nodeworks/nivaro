import { randomUUID } from 'node:crypto'
import { insertReturningId } from '../../db/dialect/ef.js'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import type { GitCtx } from '../gitlab-client.js'
import { getApp } from '../io-holder.js'
import { type JobRunHandle, startJobRun } from '../job-runs.js'
import { hubDeploysKeys } from './deploys.js'
import { DriverMisconfiguredError, driverCtx, getDriver } from './drivers.js'
import * as gitlab from './gitlab-write.js'
import {
  gatherPlanInput,
  hubPromoteLockKey,
  PromotionError,
  readServedField,
  resolveCommit,
  type ServedField
} from './promote-gather.js'
import { buildPromotionPlan } from './promote-plan.js'
import type {
  HubDeployKind,
  HubDeployRow,
  HubDeployStatus,
  PlanInput,
  PromotionBlocker,
  PromotionPlan,
  PromotionStep
} from './promote-types.js'
import { HubSecretError } from './secrets.js'
import { hubStatusKey } from './status.js'

/**
 * Hub promotion runner (phase 2): the GitLab-API port of scripts/promote-production.mjs.
 *
 *   start    re-gather + re-plan (blockers are never trusted from the client); the typed confirm
 *            must be the environment key; one promotion per environment (Redis lock
 *            nvr:hub:promote:<envId>, SET NX PX 2 h, renewed every 60 s, released at the end);
 *            a nivaro_hub_deploys row (running) + a job run (kind 'deploy'); the work runs in the
 *            background and the caller gets the ids at once.
 *   push     per component, in position order: when the target branch already holds the commit,
 *            nothing is merged (success); else a temporary branch at the commit, a merge request
 *            into the target branch, merged, the branch deleted in `finally`. An api component
 *            then commits the pin file (version + digests; identical content = no commit).
 *   deploy   right after its push: wait for the before job, then the deploy job — already
 *            succeeded, running on its own (waited for) or manual (played); api 60 min, frontend
 *            20 min. A component is pushed only once the one before it deployed, so an automatic
 *            frontend deploy never starts before the API passed. (The script pushed both first.)
 *   verify   after every deploy: each verify URL must answer its `want` twice in a row
 *            (≤ 40 × 15 s); a component without one is verified by its deploy job's gates.
 *
 * The deploy row's `step` is exactly `push <component>`, `deploy <component>` or `verify` (the
 * admin page reads it). Cancel stops at the next step boundary — never between a merge and its pin
 * commit. Log lines name the step and component; never a token (every line is also scrubbed of
 * the tokens the run opened) and never GitLab's answer text.
 */

const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'

export const LOCK_TTL_MS = 2 * 60 * 60_000
export const LOCK_RENEW_MS = 60_000
export const API_DEPLOY_MINUTES = 60
export const FRONTEND_DEPLOY_MINUTES = 20
export const VERIFY_POLLS = 40
export const VERIFY_POLL_MS = 15_000
const MASK = '••••••'

// ── lock + cancel flags ──────────────────────────────────────────────────────────────────────

/** The slice of ioredis the lock needs. */
export interface PromoteRedis {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<unknown>
  exists(key: string): Promise<number>
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>
}

export interface PromoteLock {
  /** A token when this caller now holds the environment's lock; null when someone else does. */
  take(envId: number): Promise<string | null>
  /** Extends the lock while `token` still holds it; false when it no longer does. */
  renew(envId: number, token: string): Promise<boolean>
  /** Deletes the lock only while `token` still holds it. */
  release(envId: number, token: string): Promise<void>
  /** Deletes the lock whoever holds it (boot recovery). */
  drop(envId: number): Promise<void>
  requestCancel(deployId: number): Promise<void>
  cancelRequested(deployId: number): Promise<boolean>
  clearCancel(deployId: number): Promise<void>
}

// Redis EVAL of two fixed Lua scripts (compare-and-pexpire, compare-and-delete), never input.
const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export function hubPromoteCancelKey(deployId: number | string): string {
  return `nvr:hub:promote-cancel:${deployId}`
}

/**
 * The lock on Redis. A Redis that fails while taking it refuses the start (503 LOCK_UNAVAILABLE):
 * a promotion never runs without knowing it is the only one.
 */
export function redisPromoteLock(redis: PromoteRedis): PromoteLock {
  return {
    async take(envId) {
      const token = randomUUID()
      let ok: unknown
      try {
        ok = await redis.set(hubPromoteLockKey(envId), token, 'PX', LOCK_TTL_MS, 'NX')
      } catch {
        throw new PromotionError(
          'LOCK_UNAVAILABLE',
          'The Hub cannot reach Redis to make sure only one promotion runs — try again shortly',
          503
        )
      }
      return ok === 'OK' ? token : null
    },
    async renew(envId, token) {
      try {
        return (
          Number(
            await redis.eval(RENEW_SCRIPT, 1, hubPromoteLockKey(envId), token, LOCK_TTL_MS)
          ) === 1
        )
      } catch {
        return true // a Redis blink is not a lost lock; the next renewal tries again
      }
    },
    async release(envId, token) {
      await Promise.resolve(redis.eval(RELEASE_SCRIPT, 1, hubPromoteLockKey(envId), token)).catch(
        () => undefined
      )
    },
    async drop(envId) {
      await Promise.resolve(redis.del(hubPromoteLockKey(envId))).catch(() => undefined)
    },
    async requestCancel(deployId) {
      await Promise.resolve(redis.set(hubPromoteCancelKey(deployId), '1', 'PX', LOCK_TTL_MS)).catch(
        () => undefined
      )
    },
    async cancelRequested(deployId) {
      try {
        return (await redis.get(hubPromoteCancelKey(deployId))) != null
      } catch {
        return false
      }
    },
    async clearCancel(deployId) {
      await Promise.resolve(redis.del(hubPromoteCancelKey(deployId))).catch(() => undefined)
    }
  }
}

/** No Redis (a single-process dev Hub): the same lock in this process only. */
const memLocks = new Map<string, { token: string; until: number }>()
const memCancels = new Set<number>()
export const memoryPromoteLock: PromoteLock = {
  async take(envId) {
    const key = hubPromoteLockKey(envId)
    const held = memLocks.get(key)
    if (held && held.until > Date.now()) return null
    const token = randomUUID()
    memLocks.set(key, { token, until: Date.now() + LOCK_TTL_MS })
    return token
  },
  async renew(envId, token) {
    const held = memLocks.get(hubPromoteLockKey(envId))
    if (held?.token !== token) return false
    held.until = Date.now() + LOCK_TTL_MS
    return true
  },
  async release(envId, token) {
    const key = hubPromoteLockKey(envId)
    if (memLocks.get(key)?.token === token) memLocks.delete(key)
  },
  async drop(envId) {
    memLocks.delete(hubPromoteLockKey(envId))
  },
  async requestCancel(deployId) {
    memCancels.add(deployId)
  },
  async cancelRequested(deployId) {
    return memCancels.has(deployId)
  },
  async clearCancel(deployId) {
    memCancels.delete(deployId)
  }
}

function appRedis(): PromoteRedis | null {
  return (getApp()?.redis as PromoteRedis | undefined) ?? null
}

export function defaultPromoteLock(): PromoteLock {
  const redis = appRedis()
  return redis ? redisPromoteLock(redis) : memoryPromoteLock
}

// ── execute ──────────────────────────────────────────────────────────────────────────────────

export interface RunContext {
  deployId: number
  version: string
  kind: HubDeployKind
  targetKey: string
  /** The GitLab context of a driver, token opened for this step only. */
  gitCtx(driverId: number): Promise<GitCtx>
}

export type PromoteEvent =
  | { kind: 'step'; step: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; line: string }

type GitlabOps = Pick<
  typeof gitlab,
  | 'createBranch'
  | 'deleteBranch'
  | 'openMergeRequest'
  | 'mergeMergeRequest'
  | 'commitFile'
  | 'commitExistsOn'
  | 'latestCommitMatching'
  | 'runDeployJob'
> & { resolveCommit: typeof resolveCommit }

export interface ExecuteDeps {
  sleep?: gitlab.Sleep
  now?: () => number
  gitlab?: Partial<GitlabOps>
  readServedField?: (url: string, field: string) => Promise<ServedField>
  /** Asked at every step boundary; true = stop there (cancel). */
  stopRequested?: () => boolean | Promise<boolean>
}

export interface RunOutcome {
  status: 'success' | 'failed' | 'cancelled'
  /** The last step started (null when nothing started). */
  step: string | null
  error: string | null
  /** The GitLab page of the job or pipeline that failed, when there is one. */
  webUrl?: string
}

const DEFAULT_OPS: GitlabOps = {
  createBranch: gitlab.createBranch,
  deleteBranch: gitlab.deleteBranch,
  openMergeRequest: gitlab.openMergeRequest,
  mergeMergeRequest: gitlab.mergeMergeRequest,
  commitFile: gitlab.commitFile,
  commitExistsOn: gitlab.commitExistsOn,
  latestCommitMatching: gitlab.latestCommitMatching,
  runDeployJob: gitlab.runDeployJob,
  resolveCommit
}

const realSleep: gitlab.Sleep = (ms) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : '?')

/** Error text safe for a log line, a row and an answer: never GitLab's body or a stack. */
function safeMessage(err: unknown): string {
  if (
    err instanceof gitlab.GitlabWriteError ||
    err instanceof PromotionError ||
    err instanceof HubSecretError ||
    err instanceof DriverMisconfiguredError
  )
    return err.message
  return 'Unexpected error in the Hub — see the server log'
}

export async function executePlan(
  plan: PromotionPlan,
  ctx: RunContext,
  opts: {
    signal?: AbortSignal
    onEvent?: (e: PromoteEvent) => void | Promise<void>
    deps?: ExecuteDeps
  } = {}
): Promise<RunOutcome> {
  const deps = opts.deps ?? {}
  const ops: GitlabOps = { ...DEFAULT_OPS, ...deps.gitlab }
  const sleep = deps.sleep ?? realSleep
  const poll: gitlab.PollOptions = { sleep, now: deps.now }
  const read = deps.readServedField ?? ((url: string, field: string) => readServedField(url, field))
  const tokens = new Set<string>()
  const scrub = (text: string) => {
    let out = text
    for (const t of tokens) out = out.split(t).join(MASK)
    return out
  }
  let step: string | null = null
  const emit = async (e: PromoteEvent) => {
    try {
      await opts.onEvent?.(e.kind === 'log' ? { ...e, line: scrub(e.line) } : e)
    } catch {
      /* bookkeeping never breaks the run */
    }
  }
  const log = (line: string, level: 'info' | 'warn' | 'error' = 'info') =>
    emit({ kind: 'log', level, line })
  const begin = async (s: string) => {
    step = s
    await emit({ kind: 'step', step: s })
    await log(`${s}: started`)
  }
  const git = async (driverId: number) => {
    const c = await ctx.gitCtx(driverId)
    if (c.token) tokens.add(c.token)
    return c
  }
  const stopped = async () =>
    opts.signal?.aborted === true || (await deps.stopRequested?.()) === true

  if (!plan.ok) {
    return {
      status: 'failed',
      step: null,
      error: `The plan has blockers: ${plan.blockers.map((b) => b.code).join(', ')}`
    }
  }

  const ordered = [...plan.steps].sort((a, b) => a.position - b.position)
  const deployed = new Map<number, string>()

  const push = async (s: PromotionStep): Promise<string> => {
    const label = `push ${s.component}`
    const c = await git(s.driverId)
    if (!s.sourceSha)
      throw new PromotionError('NO_SOURCE_COMMIT', `${s.component}: the plan names no commit`)
    if (!s.targetBranch)
      throw new PromotionError('NO_TARGET_BRANCH', `${s.component}: the plan names no branch`)
    let full = s.sourceSha
    if (s.kind === 'frontend') {
      const resolved = await ops.resolveCommit(c, s.sourceSha)
      if (!resolved)
        throw new PromotionError(
          'COMMIT_UNKNOWN',
          `${s.component}: GitLab does not know commit ${s.sourceSha}`
        )
      full = resolved
    }
    let tip: string | null = null
    if (await ops.commitExistsOn(c, full, s.targetBranch)) {
      await log(`${label}: ${s.targetBranch} already holds ${short(full)} — nothing to merge`)
    } else {
      const temp = `hub/promote-${ctx.deployId}-${s.position}`
      const title =
        s.kind === 'api'
          ? `${ctx.kind === 'rollback' ? 'Roll back' : 'Promote'} nivaro ${ctx.version} to ${ctx.targetKey}`
          : `${s.component} ${short(full)} for nivaro ${ctx.version} on ${ctx.targetKey}`
      await ops.createBranch(c, temp, full)
      try {
        const mr = await ops.openMergeRequest(c, temp, s.targetBranch, title, poll)
        await log(`${label}: opened merge request !${mr.iid} into ${s.targetBranch}`)
        try {
          tip = (await ops.mergeMergeRequest(c, mr.iid, mr.sha, poll)).mergeSha
          await log(`${label}: merged ${short(full)} into ${s.targetBranch} (${short(tip)})`)
        } catch (err) {
          // GitLab refuses a merge that changes nothing: the branch already holds the commit.
          if (
            !(err instanceof gitlab.GitlabWriteError && err.code === 'MERGE_REFUSED') ||
            !(await ops.commitExistsOn(c, full, s.targetBranch))
          )
            throw err
          await log(`${label}: ${s.targetBranch} already holds ${short(full)} — nothing to merge`)
        }
      } finally {
        try {
          await ops.deleteBranch(c, temp)
        } catch {
          await log(`${label}: could not delete the temporary branch ${temp}`, 'warn')
        }
      }
    }
    if (s.kind === 'api') {
      if (!s.pinFile || s.pinText == null)
        throw new PromotionError('NO_PIN_FILE', `${s.component}: the driver names no pin file`)
      const verb = ctx.kind === 'rollback' ? 'roll back' : 'promote'
      const pin = await ops.commitFile(
        c,
        s.targetBranch,
        s.pinFile,
        s.pinText,
        `chore: ${verb} nivaro ${ctx.version} to ${ctx.targetKey}`
      )
      await log(
        pin.changed
          ? `${label}: pinned ${ctx.version} in ${s.pinFile} (${short(pin.sha)})`
          : `${label}: ${s.pinFile} already pins ${ctx.version} — no commit`
      )
      return pin.sha
    }
    if (tip) return tip
    const head = await ops.latestCommitMatching(c, s.targetBranch, /^/, 1)
    if (!head)
      throw new PromotionError('BRANCH_UNKNOWN', `${s.component}: ${s.targetBranch} has no commits`)
    return head.sha
  }

  const deploy = async (s: PromotionStep, sha: string) => {
    const label = `deploy ${s.component}`
    const c = await git(s.driverId)
    const res = await ops.runDeployJob(c, s.targetBranch, sha, {
      ...poll,
      before: s.beforeJob,
      deploy: s.deployJob,
      minutes: s.kind === 'api' ? API_DEPLOY_MINUTES : FRONTEND_DEPLOY_MINUTES,
      onEvent: (e) => void log(`${label}: ${e.message}`)
    })
    await log(`${label}: ${s.deployJob} passed${res.job.web_url ? ` (${res.job.web_url})` : ''}`)
  }

  const verify = async (s: PromotionStep, sha: string | undefined) => {
    if (!s.verifyUrl) {
      await log(`verify: ${s.component} has no verify URL — its deploy job's gates verified it`)
      return
    }
    // A frontend built from a merge commit answers that commit's short sha.
    const ok = (v: string) =>
      v === s.want || (s.kind === 'frontend' && v.length >= 7 && !!sha && sha.startsWith(v))
    let streak = 0
    for (let i = 1; ; i++) {
      const r = await read(s.verifyUrl, s.verifyField)
      streak = r.value && ok(r.value) ? streak + 1 : 0
      if (streak >= 2) break
      if (i >= VERIFY_POLLS)
        throw new PromotionError(
          'VERIFY_FAILED',
          `${s.component}: ${s.verifyUrl} never answered ${s.verifyField} = ${s.want} twice (last: ${r.value ?? r.error ?? 'no answer'})`
        )
      await log(
        `verify: ${s.component} answered ${r.value ?? r.error ?? 'nothing'} (${i}/${VERIFY_POLLS})`
      )
      await sleep(VERIFY_POLL_MS)
    }
    await log(`verify: ${s.component} answers ${s.verifyField} = ${s.want} twice`)
  }

  const cancelled = async (note?: string): Promise<RunOutcome> => {
    await log(`cancelled before ${note ?? 'the next step'}`, 'warn')
    return { status: 'cancelled', step, error: null }
  }

  try {
    for (const s of ordered) {
      if (await stopped()) return cancelled(`push ${s.component}`)
      await begin(`push ${s.component}`)
      const sha = await push(s)
      if (await stopped()) {
        await log(
          `${s.component} was merged but not deployed by the Hub — a pipeline that deploys on its own may still run it`,
          'warn'
        )
        return cancelled(`deploy ${s.component}`)
      }
      await begin(`deploy ${s.component}`)
      await deploy(s, sha)
      deployed.set(s.position, sha)
    }
    if (await stopped()) return cancelled('verify')
    await begin('verify')
    for (const s of ordered) await verify(s, deployed.get(s.position))
    await log(`done: ${ctx.kind === 'rollback' ? 'rolled back to' : 'promoted'} ${ctx.version}`)
    return { status: 'success', step, error: null }
  } catch (err) {
    const error = scrub(safeMessage(err)).slice(0, 1000)
    await log(`${step ?? 'start'}: ${error}`, 'error')
    if (!(err instanceof gitlab.GitlabWriteError || err instanceof PromotionError))
      getApp()?.log?.warn?.(
        { deployId: ctx.deployId, err: (err as Error | null)?.name ?? 'Error' },
        'hub promotion failed unexpectedly'
      )
    const webUrl = err instanceof gitlab.GitlabWriteError ? err.webUrl : undefined
    return { status: 'failed', step, error, ...(webUrl ? { webUrl } : {}) }
  }
}

// ── start / cancel / recover ─────────────────────────────────────────────────────────────────

export interface StartDeps {
  gather(
    envId: number,
    opts: { kind: HubDeployKind; version: string; lockHeld?: boolean }
  ): Promise<PlanInput>
  lock: PromoteLock
  startJobRun(label: string, envId: number, userId: string | null): Promise<JobRunHandle>
  gitCtx(driverId: number): Promise<GitCtx>
  execute?: ExecuteDeps
}

export function defaultStartDeps(): StartDeps {
  return {
    gather: (envId, opts) => gatherPlanInput(envId, opts),
    lock: defaultPromoteLock(),
    startJobRun: (label, envId, userId) =>
      startJobRun('deploy', `hub-promote-${envId}`, { label, triggeredBy: userId }),
    gitCtx: async (driverId) => {
      const d = await getDriver(driverId)
      if (!d) throw new PromotionError('NO_DRIVER', 'The deploy driver no longer exists')
      return driverCtx(d)
    }
  }
}

interface Live {
  done: Promise<void>
  run: JobRunHandle
  cancel: boolean
}
/** Promotions this process is running now. */
const live = new Map<number, Live>()

/** Resolves when this process's run of the promotion ends (tests, shutdown). */
export function awaitPromotion(deployId: number): Promise<void> {
  return live.get(deployId)?.done ?? Promise.resolve()
}

export async function startPromotion(
  envId: number,
  req: { kind: HubDeployKind; version: string; confirm: unknown; user: { id: string } | null },
  deps: StartDeps = defaultStartDeps()
): Promise<{ deployId: number; jobRunId: number | null }> {
  const env = (await db(ENVS).where({ id: envId }).first('id', 'key', 'app_id')) as
    | { id: number; key: string; app_id: number }
    | undefined
  if (!env) throw new PromotionError('NOT_FOUND', 'Not found', 404)
  if (req.kind !== 'promote' && req.kind !== 'rollback')
    throw new PromotionError('BAD_KIND', 'kind must be promote or rollback')
  if (typeof req.confirm !== 'string' || req.confirm.trim() !== env.key)
    throw new PromotionError('CONFIRM_REQUIRED', `Type ${env.key} to confirm`, 400)

  const token = await deps.lock.take(envId)
  if (!token) {
    const blockers: PromotionBlocker[] = [
      { code: 'PROMOTION_RUNNING', text: `a promotion of ${env.key} is already running` }
    ]
    throw new PromotionError('PROMOTION_RUNNING', blockers[0].text, 409, blockers)
  }
  let handedOff = false
  try {
    const input = await deps.gather(envId, { kind: req.kind, version: req.version, lockHeld: true })
    const plan = buildPromotionPlan(input)
    if (!plan.ok)
      throw new PromotionError(plan.blockers[0].code, plan.blockers[0].text, 409, plan.blockers)

    const userId = req.user?.id ?? null
    const deployId = Number(
      await insertReturningId(db, DEPLOYS, {
        app_id: env.app_id,
        environment_id: envId,
        kind: req.kind,
        version: req.version,
        from_version: input.targetVersion,
        status: 'running',
        step: null,
        error: null,
        plan: JSON.stringify(plan),
        started_by: userId,
        started_at: new Date()
      })
    )
    const verb = req.kind === 'rollback' ? 'Roll back' : 'Promote'
    const run = await deps.startJobRun(
      `${verb} ${input.app.key} ${env.key} to ${req.version}`,
      envId,
      userId
    )
    if (run.id != null)
      await db(DEPLOYS)
        .where({ id: deployId })
        .update({ job_run_id: run.id })
        .catch(() => undefined)

    const entry: Live = { done: Promise.resolve(), run, cancel: false }
    live.set(deployId, entry)
    handedOff = true
    entry.done = runInBackgroundPool(() =>
      runPromotion({
        deployId,
        envId,
        envKey: env.key,
        kind: req.kind,
        version: req.version,
        plan,
        token,
        entry,
        deps
      })
    ).finally(() => live.delete(deployId))
    return { deployId, jobRunId: run.id }
  } finally {
    if (!handedOff) await deps.lock.release(envId, token)
  }
}

async function runPromotion(o: {
  deployId: number
  envId: number
  envKey: string
  kind: HubDeployKind
  version: string
  plan: PromotionPlan
  token: string
  entry: Live
  deps: StartDeps
}): Promise<void> {
  const { deployId, envId, deps, entry } = o
  const { run } = entry
  const renew = setInterval(() => {
    void deps.lock
      .renew(envId, o.token)
      .then((held) => {
        if (!held) run.log('the promotion lock was lost — another start may run now', 'warn')
      })
      .catch(() => undefined)
  }, LOCK_RENEW_MS)
  renew.unref?.()
  const setRow = (patch: Record<string, unknown>) =>
    db(DEPLOYS)
      .where({ id: deployId })
      .update(patch)
      .catch(() => undefined)
  let outcome: RunOutcome
  try {
    outcome = await executePlan(
      o.plan,
      { deployId, version: o.version, kind: o.kind, targetKey: o.envKey, gitCtx: deps.gitCtx },
      {
        onEvent: async (e) => {
          if (e.kind === 'step') await setRow({ step: e.step.slice(0, 200) })
          else run.log(e.line, e.level)
        },
        deps: {
          ...deps.execute,
          stopRequested: async () =>
            entry.cancel ||
            (await deps.lock.cancelRequested(deployId)) ||
            (await deps.execute?.stopRequested?.()) === true
        }
      }
    )
  } catch (err) {
    outcome = { status: 'failed', step: null, error: safeMessage(err) }
  } finally {
    clearInterval(renew)
  }
  try {
    const status: HubDeployStatus = outcome.status
    await setRow({
      status,
      error: outcome.error ? outcome.error.slice(0, 1000) : null,
      finished_at: new Date()
    })
    const what = `${o.kind === 'rollback' ? 'roll back to' : 'promote'} ${o.version} on ${o.envKey}`
    if (outcome.status === 'success') await run.complete(`${what}: done`)
    else if (outcome.status === 'cancelled')
      await run.complete(`${what}: cancelled after ${outcome.step ?? 'the start'}`)
    else
      await run.fail(new Error(`${what}: failed at ${outcome.step ?? 'start'} — ${outcome.error}`))
  } finally {
    await deps.lock.release(envId, o.token)
    await deps.lock.clearCancel(deployId)
    await forgetEnvironmentCaches(envId)
  }
}

/** The environment's cached status and deploy history are stale after a deploy. Best effort. */
async function forgetEnvironmentCaches(envId: number): Promise<void> {
  const redis = appRedis()
  if (!redis) return
  await Promise.resolve(redis.del(hubStatusKey(envId), ...hubDeploysKeys(envId))).catch(
    () => undefined
  )
}

export type CancelResult = { ok: true } | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING' }

/** Asks a running promotion to stop at its next step boundary (any process may be running it). */
export async function cancelPromotion(
  deployId: number,
  user: { id: string } | null,
  deps: { lock: PromoteLock } = { lock: defaultPromoteLock() }
): Promise<CancelResult> {
  const row = (await db(DEPLOYS).where({ id: deployId }).first('id', 'status')) as
    | { id: number; status: string }
    | undefined
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  if (row.status !== 'running') return { ok: false, code: 'NOT_RUNNING' }
  await deps.lock.requestCancel(deployId)
  const here = live.get(deployId)
  if (here) {
    here.cancel = true
    here.run.log(
      `cancel asked${user?.id ? ` by ${user.id}` : ''} — stopping after the current step`,
      'warn'
    )
  }
  return { ok: true }
}

/**
 * Hub boot: a promotion row still `running` belongs to a process that is gone. Each becomes
 * `interrupted` ("The Hub restarted during <step>") and its environment's lock is deleted.
 */
export async function recoverInterruptedPromotions(
  deps: { lock: PromoteLock } = { lock: defaultPromoteLock() }
): Promise<number> {
  const rows = (await db(DEPLOYS)
    .where({ status: 'running' })
    .select('id', 'environment_id', 'step')) as Array<{
    id: number
    environment_id: number
    step: string | null
  }>
  let n = 0
  for (const r of rows) {
    if (live.has(Number(r.id))) continue
    const changed = await db(DEPLOYS)
      .where({ id: r.id, status: 'running' })
      .update({
        status: 'interrupted',
        error: `The Hub restarted during ${r.step ?? 'the start'}`,
        finished_at: new Date()
      })
    if (Number(changed) > 0) n++
    await deps.lock.drop(Number(r.environment_id))
    await deps.lock.clearCancel(Number(r.id))
  }
  return n
}

let recoveryStarted = false

/** Runs recoverInterruptedPromotions once per process start (hub mode only). Never throws. */
export function recoverOnceAtBoot(logger?: {
  info?: (o: unknown, msg?: string) => void
  warn?: (o: unknown, msg?: string) => void
}): void {
  if (recoveryStarted) return
  recoveryStarted = true
  void recoverInterruptedPromotions()
    .then((n) => {
      if (n) logger?.info?.({ interrupted: n }, 'hub: promotions interrupted by a restart')
    })
    .catch((err) =>
      logger?.warn?.({ err: (err as Error | null)?.name }, 'hub: promotion recovery failed')
    )
}

// ── history reads (routes) ───────────────────────────────────────────────────────────────────

export type HubDeployListRow = HubDeployRow & { started_by_name: string | null }

function toDeployRow(r: Record<string, unknown>): HubDeployRow {
  const s = (v: unknown) => (v == null ? null : String(v))
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    kind: r.kind === 'rollback' ? 'rollback' : 'promote',
    version: String(r.version),
    from_version: s(r.from_version),
    status: String(r.status) as HubDeployStatus,
    step: s(r.step),
    error: s(r.error),
    plan: s(r.plan),
    job_run_id: r.job_run_id == null ? null : Number(r.job_run_id),
    started_by: s(r.started_by),
    started_at: r.started_at as string | Date,
    finished_at: (r.finished_at as string | Date | null) ?? null
  }
}

/** Display names of the people who started these rows (one read; unknown = null). */
async function withNames(rows: HubDeployRow[]): Promise<HubDeployListRow[]> {
  const ids = [...new Set(rows.map((r) => r.started_by).filter((v): v is string => !!v))]
  const names = new Map<string, string>()
  if (ids.length) {
    const users = (await db('nivaro_users')
      .whereIn('id', ids)
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
    for (const u of users) {
      const full = [u.first_name, u.last_name]
        .filter((x) => typeof x === 'string' && x.trim())
        .join(' ')
        .trim()
      const name = full || (typeof u.email === 'string' ? u.email : '')
      if (name) names.set(String(u.id).toLowerCase(), name)
    }
  }
  return rows.map((r) => ({
    ...r,
    started_by_name: r.started_by ? (names.get(r.started_by.toLowerCase()) ?? null) : null
  }))
}

/** The Hub's own deploy records of an environment, newest first, with who started each. */
export async function listHubDeploys(envId: number, limit = 20): Promise<HubDeployListRow[]> {
  const n = Math.max(1, Math.min(Math.trunc(limit) || 20, 100))
  const rows = (await db(DEPLOYS)
    .where({ environment_id: envId })
    .orderBy('id', 'desc')
    .limit(n)) as Array<Record<string, unknown>>
  return withNames(rows.map(toDeployRow))
}

export async function readHubDeploy(id: number): Promise<HubDeployListRow | null> {
  const r = (await db(DEPLOYS).where({ id }).first()) as Record<string, unknown> | undefined
  if (!r) return null
  return (await withNames([toDeployRow(r)]))[0]
}

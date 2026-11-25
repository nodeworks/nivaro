import { insertReturningId } from '../../db/dialect/ef.js'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import type { GitCtx } from '../gitlab-client.js'
import { getApp } from '../io-holder.js'
import { type JobRunHandle, startJobRun } from '../job-runs.js'
import { ciConfigVerifier } from './create/promote-ci-check.js'
import { hubDeploysKeys } from './deploys.js'
import { type DockerStepOps, defaultDockerOps, type StackDeployed } from './docker/run-step.js'
import { DriverMisconfiguredError, repositoryIdentity } from './drivers.js'
import * as gitlab from './gitlab-write.js'
import { moveOpenRefusal } from './move-open.js'
import {
  currentVersionReader,
  gatherPlanInput,
  lastDeployedBuildReader,
  RERUNNABLE_JOB,
  readServedField,
  resolveCommit,
  type ServedField
} from './promote-gather.js'
import {
  bounded,
  driverGitCtx,
  type HealDeps,
  healDeps,
  interruptRow,
  interruptStaleRows,
  isLiveHere,
  liveHereFor,
  markLive,
  PROMOTION_KINDS,
  unmarkLive,
  withoutFreshHeartbeat
} from './promote-heal.js'
import {
  appPromoteRedis,
  type BranchHold,
  type BranchLock,
  defaultBranchLock,
  defaultPromoteLock,
  holdBranches,
  LOCK_RENEW_MS,
  lockHolderRefusal,
  type PromoteLock,
  PromotionError
} from './promote-lock.js'
import { buildPromotionPlan, runOrder, urlForLog } from './promote-plan.js'
import type {
  HubDeployKind,
  HubDeployRow,
  HubDeployStatus,
  PlanInput,
  PromotionBlocker,
  PromotionBlockerCode,
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
 *            nvr:hub:promote:<envId>, SET NX PX 5 min, renewed every 60 s, released at the end);
 *            a nivaro_hub_deploys row (running) + a job run (kind 'deploy'); the work runs in the
 *            background and the caller gets the ids at once.
 *   push     per component, in position order (a rollback takes every frontend first, then the
 *            API — runOrder); the target branch moves exactly ONCE per
 *            component (its deploy may run on every push — two pushes would race two deploys):
 *            - api, target already holds the release commit: the pin commit straight on the target
 *              (identical content = no commit); a `noop` step (pin there, version answered) does
 *              nothing at all and is not deployed again;
 *            - api, not held: branch hub/promote-<id>-<n> at the target head, the release commit
 *              merged into it (through hub/promote-<id>-<n>-src, so the pin file never conflicts
 *              with the target's own pin commits), the pin committed on it, then ONE merge request
 *              into the target branch, merged;
 *            - frontend, not held: hub/promote-<id>-<n> at the commit, one merge request, merged.
 *            Temporary branches are deleted in `finally`. Cancel is asked right before the merge
 *            into the target branch: after it the component is deployed.
 *   deploy   right after its push: wait for the before job, then the deploy job — already
 *            succeeded, running on its own (waited for) or manual (played); api 60 min, frontend
 *            20 min. A component is pushed only once the one before it deployed, so an automatic
 *            frontend deploy never starts before the API passed. (The script pushed both first.)
 *            A cancel aborts the wait and never plays a manual job. The commit the deploy job ran
 *            on and its pipeline are written into the row's stored plan (step `deployedSha`,
 *            `deployedPipelineId`): a rollback redeploys exactly that build.
 *            A rollback (API and frontend alike) retries the deploy job of the recorded build's
 *            pipeline: nothing is merged and no pin is committed. The API's build is the commit
 *            that carried the old pin, so Nivaro and the extension go back together; the target
 *            branch keeps the newer pin, and the next promotion or deploy from it moves forward
 *            again. GitLab refusing the retry ("Prevent outdated deployment jobs") is
 *            ROLLBACK_REFUSED_BY_GITLAB. A promote of a held commit deploys the branch head, as
 *            the script does.
 *   verify   after every deploy: each verify URL must answer its planned `want` twice in a row
 *            (≤ 40 × 15 s); a frontend may answer the commit its deploy job actually ran on (a
 *            merge commit, the branch head). A component without one is verified by its deploy
 *            job's gates.
 *
 * A running row belongs to whoever holds its lock: a runner that loses it stops at the next step
 * boundary (`interrupted`, "Lost the promotion lock"); the closing write only touches a row still
 * `running`; boot recovery and the next start interrupt only rows nobody holds the lock of. The
 * runner also renews the row's heartbeat_at with every lock renewal (and clears it when it ends),
 * so a row whose lock vanished from Redis while its runner lives (in this process — `live` — or
 * another, heartbeat < 2 min) is never healed, and a start refuses PROMOTION_RUNNING beside it.
 *
 * The deploy row's `step` is exactly `push <component>`, `deploy <component>` or `verify` (the
 * admin page reads it). Cancel stops at the next step boundary, before the merge into a target
 * branch, or during a deploy wait (status `cancelled`). Log lines name the step and component;
 * never a token (every line is also scrubbed of the tokens the run opened) and never GitLab's
 * answer text.
 */

const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'

export const API_DEPLOY_MINUTES = 60
export const FRONTEND_DEPLOY_MINUTES = 20
export const VERIFY_POLLS = 40
export const VERIFY_POLL_MS = 15_000
const MASK = '••••••'

export {
  defaultPromoteLock,
  hubPromoteCancelKey,
  LOCK_RENEW_MS,
  LOCK_TTL_MS,
  memoryPromoteLock,
  type PromoteLock,
  type PromoteRedis,
  redisPromoteLock
} from './promote-lock.js'

// ── execute ──────────────────────────────────────────────────────────────────────────────────

export interface RunContext {
  deployId: number
  version: string
  kind: HubDeployKind
  targetKey: string
  /** The GitLab context of a driver, token opened for this step only. */
  gitCtx(driverId: number): Promise<GitCtx>
  /** phase 4: the target environment (docker steps read it fresh); absent = the deploy row's. */
  envId?: number
}

export type PromoteEvent =
  | { kind: 'step'; step: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; line: string }
  /** A component's deploy passed (or had nothing to do): the commit and pipeline it ran on. */
  | {
      kind: 'deployed'
      position: number
      sha: string
      pipelineId: number | null
      /** phase 4, docker steps: what the stack runs (sha = its spec hash). */
      stack?: StackDeployed
    }

type GitlabOps = Pick<
  typeof gitlab,
  | 'createBranch'
  | 'deleteBranch'
  | 'openMergeRequest'
  | 'mergeMergeRequest'
  | 'commitFile'
  | 'readFile'
  | 'commitExistsOn'
  | 'latestCommitMatching'
  | 'runDeployJob'
  | 'playJob'
  | 'findPipeline'
  | 'jobNamed'
  | 'retryJob'
  | 'waitJob'
> & { resolveCommit: typeof resolveCommit }

export interface ExecuteDeps {
  sleep?: gitlab.Sleep
  now?: () => number
  gitlab?: Partial<GitlabOps>
  readServedField?: (url: string, field: string) => Promise<ServedField>
  /** Asked at every step boundary; true = stop there (cancel). */
  stopRequested?: () => boolean | Promise<boolean>
  /** Asked at every step boundary first; true = this run no longer holds its lock. */
  lockLost?: () => boolean | Promise<boolean>
  /**
   * What the environment runs now for a step, read the way the plan reads it: the API's version
   * (the status reader), a frontend's served commit (its check address). null = cannot tell.
   * Asked when a held promote finds its deploy job already succeeded (P30).
   */
  currentVersion?: (s: PromotionStep) => Promise<string | null>
  /**
   * The build the Hub's own runs on this environment last deployed for a step's component (the
   * newest recorded deployedSha / deployedPipelineId), or null when it has no record. Asked
   * instead of currentVersion for a frontend with no check address (P32): nothing can be read
   * there, so only a recorded different build (after a rollback) reruns its deploy job.
   */
  lastDeployedBuild?: (
    s: PromotionStep
  ) => Promise<{ sha: string; pipelineId: number | null } | null>
  /** phase 4: the docker step's deploy and verify (default: through the Hub agent). */
  docker?: Partial<DockerStepOps>
  /**
   * Asked at the start of every step, before anything is written or deployed there: an app the
   * Hub created must still run the pinned template's CI (create/promote-ci-check.ts). Throws
   * CI_CONFIG_REFUSED to stop the run (nothing written for that step).
   */
  verifyCiConfig?: (s: PromotionStep, c: GitCtx) => Promise<void>
}

export interface RunOutcome {
  status: 'success' | 'failed' | 'cancelled' | 'interrupted'
  /** The last step started (null when nothing started). */
  step: string | null
  error: string | null
  /** The GitLab page of the job or pipeline that failed, when there is one. */
  webUrl?: string
  /** The failing error's code (GitlabWriteError / PromotionError), when it has one. */
  code?: string
}

const DEFAULT_OPS: GitlabOps = {
  createBranch: gitlab.createBranch,
  deleteBranch: gitlab.deleteBranch,
  openMergeRequest: gitlab.openMergeRequest,
  mergeMergeRequest: gitlab.mergeMergeRequest,
  commitFile: gitlab.commitFile,
  readFile: gitlab.readFile,
  commitExistsOn: gitlab.commitExistsOn,
  latestCommitMatching: gitlab.latestCommitMatching,
  runDeployJob: gitlab.runDeployJob,
  playJob: gitlab.playJob,
  findPipeline: gitlab.findPipeline,
  jobNamed: gitlab.jobNamed,
  retryJob: gitlab.retryJob,
  waitJob: gitlab.waitJob,
  resolveCommit
}

/** Waits `ms`; an abort ends the wait at once. */
const realSleep: gitlab.Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    t.unref?.()
    signal?.addEventListener('abort', done, { once: true })
  })

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 8) : '?')

/** GitLab's failure_reason for a deploy job dropped by "Prevent outdated deployment jobs". */
const OUTDATED_DEPLOYMENT = 'forward_deployment_failure'

/** A GitLab refusal's own code by HTTP status (gitlab-write's call() mapping). */
function gitlabCodeFor(status: number | null): string {
  if (status === 401) return 'GITLAB_UNAUTHORIZED'
  if (status === 403) return 'GITLAB_FORBIDDEN'
  if (status === 404) return 'GITLAB_NOT_FOUND'
  return 'GITLAB_REFUSED'
}

/** The refusal code of a rollback whose build cannot be redeployed. */
const rollbackNoBuild = (s: PromotionStep) =>
  s.kind === 'frontend' ? 'FRONTEND_ROLLBACK_NO_BUILD' : 'ROLLBACK_NO_BUILD'

/** Thrown from runDeployJob's `play` event: the Hub plays the manual job itself, after a cancel check. */
class PlayHere extends Error {}

/** A cancel seen inside a step (before a merge into the target branch). */
class StopRun extends Error {
  constructor(readonly before: string) {
    super(`cancelled before ${before}`)
  }
}

/** What a push left for the deploy and verify of its component. */
interface Pushed {
  /** The commit the deploy runs on. */
  sha: string
  /** The planned commit, full sha. */
  full: string
  /** The merge commit this run made (null when nothing was merged). */
  merged: string | null
  /** The target branch already held the planned commit before this run. */
  held: boolean
  /** Nothing was done and nothing is deployed (a `noop` api step). */
  noop?: boolean
}

/** What a deploy ran on. */
interface Deployed {
  sha: string
  pipelineId: number | null
  /** phase 4, docker steps. */
  stack?: StackDeployed
}

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
  /**
   * The GitLab context of a step's driver, token opened for this call. The driver must still
   * point at the repository it pointed at when the run started (bound in the plan): an admin
   * edit mid-run never sends a push or a deploy somewhere the confirmed plan did not name.
   */
  const git = async (s: PromotionStep) => {
    const c = await ctx.gitCtx(s.driverId)
    if (c.token) tokens.add(c.token)
    if (s.driverIdentity && repositoryIdentity(c.base, c.project) !== s.driverIdentity)
      throw new PromotionError(
        'DRIVER_CHANGED',
        `${s.component}: its driver was changed to another repository after this run started — nothing more was done; check the driver, then plan and start again`
      )
    return c
  }
  // A cancel (or the caller's signal) aborts the deploy waits: polled at every wait and checked
  // right before a manual deploy job would be played.
  const ac = new AbortController()
  if (opts.signal?.aborted) ac.abort()
  else opts.signal?.addEventListener('abort', () => ac.abort(), { once: true })
  const stopped = async () => {
    if (ac.signal.aborted) return true
    if ((await deps.stopRequested?.()) === true) ac.abort()
    return ac.signal.aborted
  }
  /** The deploy waits' sleep: asks for a cancel before every wait. */
  const watchSleep: gitlab.Sleep = async (ms) => {
    if (await stopped()) return
    await sleep(ms, ac.signal)
  }
  const aborted = () =>
    new gitlab.GitlabWriteError('ABORTED', 'Stopped before GitLab finished', {
      step: 'runDeployJob'
    })

  if (!plan.ok) {
    return {
      status: 'failed',
      step: null,
      error: `The plan has blockers: ${plan.blockers.map((b) => b.code).join(', ')}`
    }
  }

  // Promote: by position (API first). Rollback: the portal first, then the API.
  const ordered = runOrder(plan.steps, ctx.kind)
  const deployedAt = new Map<number, Deployed>()
  /**
   * What this run already deployed, said with a refusal (a rollback takes the portal first, so a
   * refused API step does not mean nothing changed). '' when nothing was.
   */
  const partDone = (): string => {
    const done = ordered.filter((x) => deployedAt.has(x.position)).map((x) => x.component)
    if (!done.length) return ''
    return ctx.kind === 'rollback'
      ? ` — ${done.join(', ')} was already rolled back to ${ctx.version} by this run and stays there; check ${ctx.targetKey}, then roll back again or promote`
      : ` — ${done.join(', ')} was already deployed by this run`
  }
  /** "nothing was changed", or what this run already changed. */
  const unchanged = () => partDone().replace(/^ — /, '') || 'nothing was changed'

  /** Opens a merge request `source` → `target` and merges it; answers the commit it left. */
  const mergeInto = async (
    c: GitCtx,
    label: string,
    source: string,
    target: string,
    title: string
  ): Promise<string> => {
    const mr = await ops.openMergeRequest(c, source, target, title, poll)
    await log(`${label}: opened merge request !${mr.iid} into ${target}`)
    return (await ops.mergeMergeRequest(c, mr.iid, mr.sha, poll)).mergeSha
  }

  /**
   * A promote that finds its frontend commit already on the target deploys the branch head — only
   * the head its plan named. A plan that saw the commit unheld named none (someone merged it in
   * since), and a head that moved is not what was confirmed: HEAD_MOVED, nothing written.
   */
  const refuseUnplannedHead = (
    s: PromotionStep,
    head: string,
    unchanged = 'nothing was changed'
  ) => {
    if (s.expectHead && head === s.expectHead) return
    throw new PromotionError(
      'HEAD_MOVED',
      s.expectHead
        ? `${s.component}: ${s.targetBranch} moved since the plan (planned head ${short(s.expectHead)}, now ${short(head)}) — ${unchanged}; plan again`
        : `${s.component}: ${s.targetBranch} took ${short(s.sourceSha)} since the plan, which planned a merge (head now ${short(head)}) — ${unchanged}; plan again`
    )
  }

  // phase 4: docker steps (driver 'docker') run through the Hub agent, never GitLab.
  const docker: DockerStepOps = {
    ...defaultDockerOps({ sleep, now: deps.now, readServedField: read }),
    ...deps.docker
  }

  const push = async (s: PromotionStep): Promise<Pushed> => {
    const label = `push ${s.component}`
    const c = await git(s)
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
    // A rollback redeploys a recorded build from its own branch: it never merges an old commit
    // back in and never commits a pin (the build's commit carries that version's pin).
    if (ctx.kind === 'rollback') {
      if (!(await ops.commitExistsOn(c, full, s.targetBranch)))
        throw new PromotionError(
          rollbackNoBuild(s),
          `${s.component}: ${short(full)} is no longer on ${s.targetBranch} — that build can't be redeployed; ${unchanged()}`
        )
      await log(`${label}: ${s.targetBranch} still holds ${s.component}'s build ${short(full)}`)
      return { sha: full, full, merged: null, held: true }
    }
    if (s.kind === 'api' && (!s.pinFile || s.pinText == null))
      throw new PromotionError('NO_PIN_FILE', `${s.component}: the driver names no pin file`)
    const pinMessage = `chore: promote nivaro ${ctx.version} to ${ctx.targetKey}`

    if (s.noop) {
      const head = await ops.latestCommitMatching(c, s.targetBranch, /^/, 1)
      await log(
        `${label}: ${s.targetBranch} already holds ${short(full)} and pins ${ctx.version} — nothing to do`
      )
      return { sha: head?.sha ?? full, full, merged: null, held: true, noop: true }
    }

    // The version running here keeps the pin it was deployed with: never create one for it.
    if (
      s.kind === 'api' &&
      s.pinMustExist &&
      (await ops.readFile(c, s.pinFile as string, s.targetBranch)) == null
    )
      throw new PromotionError(
        'PIN_CHANGED',
        `${s.component}: ${s.targetBranch} has no recorded pin for ${ctx.version} (no ${s.pinFile}) — the Hub never creates a pin for the version that is running; nothing was changed`
      )

    const held = await ops.commitExistsOn(c, full, s.targetBranch)
    // The plan saw the commit held and named the head to deploy: a commit gone from the branch
    // since is not that plan (and is never merged back in on its own say-so).
    if (!held && s.kind === 'frontend' && ctx.kind === 'promote' && s.expectHead)
      throw new PromotionError(
        'HEAD_MOVED',
        `${s.component}: ${s.targetBranch} no longer holds ${short(full)} (the plan deployed its head ${short(s.expectHead)}) — nothing was changed; plan again`
      )
    if (held) {
      await log(`${label}: ${s.targetBranch} already holds ${short(full)} — nothing to merge`)
      if (s.kind === 'api') {
        // One commit on the target branch (none when it already pins this content).
        if (await stopped()) throw new StopRun(`pinning ${ctx.version} on ${s.targetBranch}`)
        const pin = await ops.commitFile(
          c,
          s.targetBranch,
          s.pinFile as string,
          s.pinText as string,
          pinMessage
        )
        await log(
          pin.changed
            ? `${label}: pinned ${ctx.version} in ${s.pinFile} on ${s.targetBranch} (${short(pin.sha)})`
            : `${label}: ${s.pinFile} already pins ${ctx.version} — no commit`
        )
        return { sha: pin.sha, full, merged: null, held: true }
      }
      // Promote, branch already holds it (maybe with newer commits): deploy the head, as the
      // script does.
      const head = await ops.latestCommitMatching(c, s.targetBranch, /^/, 1)
      if (!head)
        throw new PromotionError(
          'BRANCH_UNKNOWN',
          `${s.component}: ${s.targetBranch} has no commits`
        )
      // Deploy only the head the plan named and the person confirmed.
      refuseUnplannedHead(s, head.sha)
      await log(`${label}: deploying ${s.targetBranch}'s current head ${short(head.sha)}`)
      return { sha: head.sha, full, merged: null, held: true }
    }

    const temp = `hub/promote-${ctx.deployId}-${s.position}`
    const made: string[] = []
    try {
      let tip: string
      if (s.kind === 'api') {
        // The temporary branch starts at the target head and gets the release commit merged in
        // and the pin committed on top; the target branch then moves once, to all of it.
        const src = `${temp}-src`
        await ops.createBranch(c, temp, s.targetBranch)
        made.push(temp)
        await ops.createBranch(c, src, full)
        made.push(src)
        try {
          await mergeInto(
            c,
            label,
            src,
            temp,
            `Merge ${short(full)} for nivaro ${ctx.version} on ${ctx.targetKey}`
          )
        } catch (err) {
          if (!(err instanceof gitlab.GitlabWriteError && err.code === 'MERGE_REFUSED')) throw err
          // GitLab's own merge status says why (conflict, not_approved, ci_must_pass, …).
          const why = err.mergeStatus
          const conflict = !why || why === 'conflict' || why === 'cannot_be_merged'
          throw new gitlab.GitlabWriteError(
            'MERGE_REFUSED',
            conflict
              ? `${s.component}: release commit ${short(full)} does not merge cleanly onto ${s.targetBranch} (on the temporary branch ${temp}; GitLab merge status ${why ?? 'unknown'}) — ${s.targetBranch} is untouched`
              : `${s.component}: GitLab refused to merge release commit ${short(full)} onto ${s.targetBranch} (on the temporary branch ${temp}; GitLab merge status ${why}) — ${s.targetBranch} is untouched`,
            { status: err.status, step: err.step, mergeStatus: why }
          )
        }
        const pin = await ops.commitFile(
          c,
          temp,
          s.pinFile as string,
          s.pinText as string,
          pinMessage
        )
        await log(
          pin.changed
            ? `${label}: pinned ${ctx.version} in ${s.pinFile} on ${temp} (${short(pin.sha)})`
            : `${label}: ${s.pinFile} already pins ${ctx.version} — no pin commit`
        )
        if (await stopped()) throw new StopRun(`merging into ${s.targetBranch}`)
        tip = await mergeInto(
          c,
          label,
          temp,
          s.targetBranch,
          `Promote nivaro ${ctx.version} to ${ctx.targetKey}`
        )
      } else {
        await ops.createBranch(c, temp, full)
        made.push(temp)
        if (await stopped()) throw new StopRun(`merging into ${s.targetBranch}`)
        try {
          tip = await mergeInto(
            c,
            label,
            temp,
            s.targetBranch,
            `${s.component} ${short(full)} for nivaro ${ctx.version} on ${ctx.targetKey}`
          )
        } catch (err) {
          // GitLab refuses a merge that changes nothing: the branch already holds the commit.
          if (
            !(err instanceof gitlab.GitlabWriteError && err.code === 'MERGE_REFUSED') ||
            !(await ops.commitExistsOn(c, full, s.targetBranch))
          )
            throw err
          await log(`${label}: ${s.targetBranch} already holds ${short(full)} — nothing to merge`)
          const head = await ops.latestCommitMatching(c, s.targetBranch, /^/, 1)
          // The temporary branch is deleted below; the target branch was never written.
          refuseUnplannedHead(s, head?.sha ?? '', `${s.targetBranch} was not changed`)
          return { sha: head?.sha ?? full, full, merged: null, held: true }
        }
      }
      await log(`${label}: merged ${short(full)} into ${s.targetBranch} (${short(tip)})`)
      return { sha: tip, full, merged: tip, held: false }
    } finally {
      for (const b of made.reverse()) {
        try {
          await ops.deleteBranch(c, b)
        } catch {
          await log(`${label}: could not delete the temporary branch ${b}`, 'warn')
        }
      }
    }
  }

  /**
   * Rollback: retry the deploy job of the build recorded for that version (an API build is only
   * the recorded pipeline; a frontend's is looked up by commit when none was recorded).
   */
  const redeployBuild = async (s: PromotionStep, full: string): Promise<Deployed> => {
    const label = `deploy ${s.component}`
    const c = await git(s)
    const code = rollbackNoBuild(s)
    const pipelineId =
      s.buildPipelineId ??
      (s.kind === 'frontend' ? (await ops.findPipeline(c, s.targetBranch, full))?.id : null)
    if (!pipelineId)
      throw new PromotionError(
        s.kind === 'api' ? 'ROLLBACK_NOT_RECORDED' : code,
        s.kind === 'api'
          ? `${s.component}: the Hub did not record which pipeline deployed ${ctx.version} here — that build can't be redeployed; ${unchanged()}`
          : `${s.component}: ${s.targetBranch} has no pipeline for ${short(full)} — there is no build of that commit to redeploy`
      )
    const job = await ops.jobNamed(c, pipelineId, s.deployJob)
    if (!job)
      throw new PromotionError(
        code,
        `${s.component}: pipeline ${pipelineId} for ${short(full)} has no ${s.deployJob} job to redeploy`
      )
    // GitLab reruns only a finished job; a manual, pending or running one is not a build to redo.
    const cannotRerun = (why: string) =>
      new PromotionError(
        code,
        `${s.component}'s earlier build can't be rerun (${why})${partDone()}`
      )
    if (!RERUNNABLE_JOB.includes(job.status)) throw cannotRerun(`job is ${job.status || 'unknown'}`)
    if (await stopped()) throw aborted()
    await log(
      `${label}: redeploying ${s.component}'s build ${short(full)} — retrying ${s.deployJob} of pipeline ${pipelineId}`
    )
    await retryDeployJob(c, s, job.id, pipelineId, 'ROLLBACK_REFUSED_BY_GITLAB')
    return { sha: full, pipelineId }
  }

  /**
   * Reruns a finished deploy job and waits for it. GitLab refusing the rerun — a 403 from the
   * retry, or the new job dropped as an outdated deployment ("Prevent outdated deployment jobs")
   * — is `refusedCode`; any other answer keeps its own GitLab code (unauthorized, unreachable…).
   */
  const retryDeployJob = async (
    c: GitCtx,
    s: PromotionStep,
    jobId: number,
    pipelineId: number,
    refusedCode: 'ROLLBACK_REFUSED_BY_GITLAB' | 'REDEPLOY_REFUSED_BY_GITLAB'
  ): Promise<void> => {
    const label = `deploy ${s.component}`
    const refusedByGitlab = (why: string) =>
      new PromotionError(
        refusedCode,
        `${s.component}: GitLab refused to rerun ${s.deployJob} of pipeline ${pipelineId} (${why}). The project's "Prevent outdated deployment jobs" setting refuses an older deploy job — allow job retries for rollback deployments in GitLab, or deploy by hand${partDone()}`
      )
    let retried: gitlab.HubJob
    try {
      retried = await ops.retryJob(c, jobId)
    } catch (err) {
      if (err instanceof gitlab.GitlabWriteError && err.code === 'JOB_RETRY_REFUSED') {
        if (err.status === 403) throw refusedByGitlab('HTTP 403')
        // Not that setting: keep GitLab's own code for the answer.
        throw new gitlab.GitlabWriteError(gitlabCodeFor(err.status), err.message, {
          status: err.status,
          step: err.step
        })
      }
      throw err
    }
    const done = await ops.waitJob(c, retried.id, {
      ...poll,
      signal: ac.signal,
      sleep: watchSleep,
      minutes: s.kind === 'api' ? API_DEPLOY_MINUTES : FRONTEND_DEPLOY_MINUTES,
      onStatus: (st) => void log(`${label}: ${s.deployJob}: ${st}`)
    })
    // GitLab starts the retry, then drops it as an outdated deployment.
    if (done.status === 'failed' && done.failure_reason === OUTDATED_DEPLOYMENT)
      throw refusedByGitlab('the job was dropped as an outdated deployment')
    if (done.status !== 'success')
      throw new gitlab.GitlabWriteError(
        'DEPLOY_FAILED',
        `${s.deployJob} ${done.status} — the deploy script rolled back (${done.web_url})`,
        { step: 'retryJob', webUrl: done.web_url || undefined }
      )
    await log(`${label}: ${s.deployJob} passed${done.web_url ? ` (${done.web_url})` : ''}`)
  }

  const deploy = async (s: PromotionStep, p: Pushed): Promise<Deployed> => {
    if (ctx.kind === 'rollback') return redeployBuild(s, p.full)
    const label = `deploy ${s.component}`
    const c = await git(s)
    // Filled by the deploy events (closures: kept on an object so the reads below are not narrowed).
    const seen: {
      pipelineId: number | null
      how: 'played' | 'auto' | 'already'
      /** "already succeeded … not run again": said only once the Hub knows it is not rerun. */
      already: string | null
    } = {
      pipelineId: null,
      how: 'played',
      already: null
    }
    /** A later pass after the Hub asked: lines already said are not said again. */
    let repeat = false
    const runOnce = () =>
      ops.runDeployJob(c, s.targetBranch, p.sha, {
        ...poll,
        signal: ac.signal,
        sleep: watchSleep,
        before: s.beforeJob,
        deploy: s.deployJob,
        minutes: s.kind === 'api' ? API_DEPLOY_MINUTES : FRONTEND_DEPLOY_MINUTES,
        onEvent: (e) => {
          if (e.kind === 'pipeline') {
            seen.pipelineId = e.id
            if (repeat) return
          } else if (e.kind === 'play') {
            // Every manual play is the Hub's, after asking for a cancel (any replica).
            throw new PlayHere()
          } else if (e.kind === 'auto-run' || e.kind === 'already-succeeded') {
            if (repeat) return
            seen.how = e.kind === 'auto-run' ? 'auto' : 'already'
            if (e.kind === 'already-succeeded') {
              seen.already = `${label}: ${e.message}`
              return
            }
          }
          // The closing line below says it once, with the job's address.
          if (e.kind === 'passed') return
          void log(`${label}: ${e.message}`)
        }
      })
    let res: Awaited<ReturnType<typeof runOnce>> | null = null
    for (let pass = 1; !res; pass++) {
      try {
        res = await runOnce()
        break
      } catch (err) {
        if (!(err instanceof PlayHere)) throw err
      }
      // Asked right before the deploy job is read and played, so a cancel that landed on
      // another replica since the last wait is seen and the job is never played.
      if (await stopped()) throw aborted()
      const job = seen.pipelineId ? await ops.jobNamed(c, seen.pipelineId, s.deployJob) : null
      if (job?.status === 'manual') {
        if (await stopped()) throw aborted()
        await log(`${label}: playing ${s.deployJob}`)
        seen.how = 'played'
        const played = await ops.playJob(c, job.id)
        const done = await ops.waitJob(c, played.id, {
          ...poll,
          signal: ac.signal,
          sleep: watchSleep,
          minutes: s.kind === 'api' ? API_DEPLOY_MINUTES : FRONTEND_DEPLOY_MINUTES,
          onStatus: (st) => void log(`${label}: ${s.deployJob}: ${st}`)
        })
        if (done.status !== 'success')
          throw new gitlab.GitlabWriteError(
            'DEPLOY_FAILED',
            `${s.deployJob} ${done.status} — the deploy script rolled back (${done.web_url})`,
            { step: 'runDeployJob', webUrl: done.web_url || undefined }
          )
        res = { status: 'success', job: { ...job, ...played, ...done, name: job.name } }
        break
      }
      // It started (or finished) on its own meanwhile: wait for it as runDeployJob does. A pass
      // that finds it manual again comes back here and asks again before any play.
      if (pass >= 3)
        throw new gitlab.GitlabWriteError(
          'DEPLOY_JOB_UNEXPECTED',
          `${s.deployJob} kept changing between manual and running — the Hub did not play it`,
          { step: 'runDeployJob' }
        )
      seen.how = 'auto'
      repeat = true
    }
    if (!res) throw new PromotionError('DEPLOY_JOB_UNEXPECTED', `${s.deployJob} never ran`)
    // P30: the branch already held this commit and its deploy job already succeeded — but a
    // rollback since redeployed an older build without moving the branch. When the environment
    // does not run what this step promotes, the job is rerun (as a rollback reruns one).
    if (seen.how === 'already' && p.held && !p.merged && seen.pipelineId) {
      const same = (a: string, b: string) =>
        a === b || (a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)))
      let why: string | null = null
      if (s.kind === 'frontend' && !s.verifyUrl) {
        // P32: no check address, so nothing can be read: only the Hub's own record decides —
        // a different build deployed here since (a rollback) reruns; no record = not again.
        const last = deps.lastDeployedBuild
          ? await deps.lastDeployedBuild(s).catch(() => null)
          : null
        if (last && !same(last.sha, p.sha))
          why = `the Hub last deployed ${short(last.sha)} here, not ${short(p.sha)}`
      } else if (deps.currentVersion) {
        // A failed read (null) with a check address = cannot tell: rerun (a redeploy of the
        // same build is safe; reporting success without knowing is not).
        const now = await deps.currentVersion(s).catch(() => null)
        const runs =
          now != null && (s.kind === 'api' ? now === s.want : same(now, p.sha) || same(now, s.want))
        if (!runs)
          why =
            now == null
              ? `what ${ctx.targetKey} runs could not be read`
              : `${ctx.targetKey} runs ${now}, not what this promotes`
      }
      if (why) {
        if (await stopped()) throw aborted()
        await log(
          `${label}: ${s.deployJob} of pipeline ${seen.pipelineId} already passed, but ${why} — rerunning it`
        )
        await retryDeployJob(c, s, res.job.id, seen.pipelineId, 'REDEPLOY_REFUSED_BY_GITLAB')
        return { sha: p.sha, pipelineId: seen.pipelineId }
      }
    }
    if (seen.already) await log(seen.already)
    const url = res.job.web_url ? ` (${res.job.web_url})` : ''
    if (seen.how === 'auto')
      await log(`${label}: ${s.deployJob} ran automatically and passed${url}`)
    else if (seen.how === 'played') await log(`${label}: ${s.deployJob} passed${url}`)
    return { sha: p.sha, pipelineId: seen.pipelineId }
  }

  const verify = async (s: PromotionStep, d: Deployed | undefined) => {
    if (!s.verifyUrl) {
      await log(`verify: ${s.component} has no verify URL — its deploy job's gates verified it`)
      return
    }
    // The api answers the version. A frontend answers a (short) commit: the planned one, or the
    // one its deploy job actually ran on (a merge commit this run made, the branch head).
    const deployed = s.kind === 'frontend' ? (d?.sha ?? null) : null
    const prefix = (a: string, b: string) =>
      a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))
    const ok = (v: string) =>
      v === s.want ||
      (s.kind === 'frontend' && (prefix(v, s.want) || (!!deployed && prefix(v, deployed))))
    const where = urlForLog(s.verifyUrl)
    let streak = 0
    let answered = ''
    for (let i = 1; ; i++) {
      const r = await read(s.verifyUrl, s.verifyField)
      streak = r.value && ok(r.value) ? streak + 1 : 0
      if (r.value) answered = r.value
      if (streak >= 2) break
      if (i >= VERIFY_POLLS)
        throw new PromotionError(
          'VERIFY_FAILED',
          `${s.component}: ${where} never answered ${s.verifyField} = ${s.want} twice (last: ${r.value ?? r.error ?? 'no answer'})`
        )
      await log(
        `verify: ${s.component} answered ${r.value ?? r.error ?? 'nothing'} (${i}/${VERIFY_POLLS})`
      )
      await sleep(VERIFY_POLL_MS)
    }
    await log(`verify: ${s.component} answers ${s.verifyField} = ${answered} twice`)
  }

  const cancelled = async (note?: string): Promise<RunOutcome> => {
    await log(`cancelled before ${note ?? 'the next step'}`, 'warn')
    return { status: 'cancelled', step, error: null }
  }
  /** At a step boundary: a lost lock stops the run (interrupted), then a cancel (cancelled). */
  const halt = async (before: string): Promise<RunOutcome | null> => {
    if (deps.lockLost && (await deps.lockLost()) === true) {
      await log(`stopped before ${before}: lost the promotion lock`, 'error')
      return { status: 'interrupted', step, error: 'Lost the promotion lock' }
    }
    if (await stopped()) return cancelled(before)
    return null
  }
  const recordDeploy = async (s: PromotionStep, d: Deployed) => {
    deployedAt.set(s.position, d)
    await emit({
      kind: 'deployed',
      position: s.position,
      sha: d.sha,
      pipelineId: d.pipelineId,
      ...(d.stack ? { stack: d.stack } : {})
    })
  }

  /**
   * phase 4: a docker step — no push. Cancel is asked at the boundary and once more right before
   * the agent PUT; once the PUT is sent the step waits for swarm and never stops half way.
   */
  const dockerStep = async (s: PromotionStep): Promise<RunOutcome | null> => {
    const before = await halt(`deploy ${s.component}`)
    if (before) return before
    await begin(`deploy ${s.component}`)
    let held: RunOutcome | null = null
    const done = await docker.deploy(s, ctx, log, {
      beforeApply: async () => {
        held = await halt('the agent applies the stack')
        return held !== null
      }
    })
    // Recorded like a GitLab deploy's commit: the spec hash is the step's deployed "sha".
    if (done) await recordDeploy(s, { sha: done.specHash, pipelineId: null, stack: done })
    return held
  }

  try {
    for (const s of ordered) {
      if (s.driver === 'docker') {
        const stop = await dockerStep(s) // phase 4
        if (stop) return stop
        continue
      }
      const before = await halt(`push ${s.component}`)
      if (before) return before
      await begin(`push ${s.component}`)
      if (deps.verifyCiConfig) await deps.verifyCiConfig(s, await git(s))
      const p = await push(s)
      if (p.noop) {
        await recordDeploy(s, { sha: p.sha, pipelineId: null })
        continue
      }
      const between = await halt(`deploy ${s.component}`)
      if (between) {
        await log(
          `${s.component} was merged but not deployed by the Hub — a pipeline that deploys on its own may still run it`,
          'warn'
        )
        return between
      }
      await begin(`deploy ${s.component}`)
      await recordDeploy(s, await deploy(s, p))
    }
    const last = await halt('verify')
    if (last) return last
    await begin('verify')
    for (const s of ordered)
      if (s.driver === 'docker')
        await docker.verify(s, ctx, log) // phase 4
      else await verify(s, deployedAt.get(s.position))
    await log(`done: ${ctx.kind === 'rollback' ? 'rolled back to' : 'promoted'} ${ctx.version}`)
    return { status: 'success', step, error: null }
  } catch (err) {
    if (err instanceof StopRun) return cancelled(err.before)
    if (err instanceof gitlab.GitlabWriteError && err.code === 'ABORTED' && ac.signal.aborted) {
      await log(
        `cancelled during ${step ?? 'the start'} — a deploy job GitLab already started keeps running there`,
        'warn'
      )
      return { status: 'cancelled', step, error: null }
    }
    const error = scrub(safeMessage(err)).slice(0, 1000)
    await log(`${step ?? 'start'}: ${error}`, 'error')
    if (!(err instanceof gitlab.GitlabWriteError || err instanceof PromotionError))
      getApp()?.log?.warn?.(
        { deployId: ctx.deployId, err: (err as Error | null)?.name ?? 'Error' },
        'hub promotion failed unexpectedly'
      )
    const webUrl = err instanceof gitlab.GitlabWriteError ? err.webUrl : undefined
    const code =
      err instanceof gitlab.GitlabWriteError || err instanceof PromotionError ? err.code : undefined
    return {
      status: 'failed',
      step,
      error,
      ...(webUrl ? { webUrl } : {}),
      ...(code ? { code } : {})
    }
  }
}

/**
 * Phase 6 (Task 16, Decision 9): deploy ONE component at `version` the way a promotion does — the
 * pin write (an api step: the release commit merged in and the pin committed, or the pin straight
 * on a branch that already holds the commit) and the deploy job, waited for, played when manual.
 * A move deploys a GitLab dedicated target with it. It runs the step through `executePlan`
 * unchanged (a one-step plan, kind `promote`), so it is the promotion's own code path, never a
 * copy of it: a refusal, a cancel or a lost lock answers the same RunOutcome a promotion's would.
 * Log lines go to `log` (scrubbed of any token the step opened, as every promotion line is).
 */
export async function deployComponentAt(
  component: PromotionStep,
  version: string,
  ctx: Omit<RunContext, 'version' | 'kind'>,
  log: (line: string, level?: 'info' | 'warn' | 'error') => void,
  opts: { signal?: AbortSignal; deps?: ExecuteDeps } = {}
): Promise<RunOutcome> {
  const plan: PromotionPlan = {
    ok: true,
    blockers: [],
    lines: [],
    steps: [component],
    plan_hash: ''
  }
  return executePlan(
    plan,
    { ...ctx, version, kind: 'promote' },
    {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.deps ? { deps: opts.deps } : {}),
      onEvent: (e) => {
        if (e.kind === 'log') log(e.line, e.level)
      }
    }
  )
}

// ── start / cancel / recover ─────────────────────────────────────────────────────────────────

/** The final status write of a deploy row; answers how many rows it changed. */
export type FinishRow = (deployId: number, patch: Record<string, unknown>) => Promise<number>

export interface StartDeps {
  gather(
    envId: number,
    opts: { kind: HubDeployKind; version: string; lockHeld?: boolean; apply?: boolean }
  ): Promise<PlanInput>
  lock: PromoteLock
  startJobRun(label: string, envId: number, userId: string | null): Promise<JobRunHandle>
  gitCtx(driverId: number): Promise<GitCtx>
  execute?: ExecuteDeps
  /** Default: an UPDATE of the row while it is still `running`. */
  finishRow?: FinishRow
  /** The clock heartbeats are judged by (tests). */
  now?: () => number
  /** One writer per GitLab branch (review H1): default the Hub's Redis lock. */
  branchLock?: BranchLock
}

export function defaultStartDeps(): StartDeps {
  return {
    gather: (envId, opts) => gatherPlanInput(envId, opts),
    lock: defaultPromoteLock(),
    startJobRun: (label, envId, userId) =>
      startJobRun('deploy', `hub-promote-${envId}`, { label, triggeredBy: userId }),
    gitCtx: driverGitCtx
  }
}

/** The closing write never overwrites a row that is no longer running (interrupted elsewhere). */
const finishRunningRow: FinishRow = async (deployId, patch) =>
  Number(await db(DEPLOYS).where({ id: deployId, status: 'running' }).update(patch))

interface Live {
  envId: number
  done: Promise<void>
  run: JobRunHandle
  cancel: boolean
  lockLost: boolean
  /** Aborted by a cancel in this process: ends a deploy wait at once. */
  abort: AbortController
}
/** Promotions this process is running now. */
const live = new Map<number, Live>()

/** Resolves when this process's run of the promotion ends (tests, shutdown). */
export function awaitPromotion(deployId: number): Promise<void> {
  return live.get(deployId)?.done ?? Promise.resolve()
}

export async function startPromotion(
  envId: number,
  req: {
    kind: HubDeployKind
    version: string
    confirm: unknown
    /** The plan_hash of the plan the person previewed and confirmed (not asked for Apply now). */
    planHash: unknown
    user: { id: string } | null
    /**
     * phase 4, Apply now (P4-30; startStackApply): the running version again with the saved
     * stack settings and pins. Confirmed by the typed key, like a restart: no plan preview.
     */
    apply?: boolean
  },
  deps: StartDeps = defaultStartDeps()
): Promise<{ deployId: number; jobRunId: number | null }> {
  const env = (await db(ENVS).where({ id: envId }).first('id', 'key', 'app_id')) as
    | { id: number; key: string; app_id: number }
    | undefined
  if (!env) throw new PromotionError('NOT_FOUND', 'Not found', 404)
  // Final review moves I-2 (P6-37): promote, rollback and Apply now (startStackApply) all start
  // here; an open move (an interrupted one holds no lock) refuses them. A move's own deploys use
  // deployComponentAt, never this.
  const open = await moveOpenRefusal({ envIds: [envId] })
  if (open) throw new PromotionError(open.code, open.message, open.status)
  if (req.kind !== 'promote' && req.kind !== 'rollback')
    throw new PromotionError('BAD_KIND', 'kind must be promote or rollback')
  const apply = req.apply === true
  if (apply && req.kind !== 'promote')
    throw new PromotionError('BAD_KIND', 'Apply now redeploys the running version (kind promote)')
  if (typeof req.confirm !== 'string' || req.confirm.trim() !== env.key)
    throw new PromotionError('CONFIRM_REQUIRED', `Type ${env.key} to confirm`, 400)
  if (!apply && (typeof req.planHash !== 'string' || !/^[0-9a-f]{64}$/.test(req.planHash)))
    throw new PromotionError(
      'PLAN_HASH_REQUIRED',
      'Send the plan_hash of the plan you checked',
      400
    )

  const alreadyRunning = () => {
    const blockers: PromotionBlocker[] = [
      { code: 'PROMOTION_RUNNING', text: `a promotion of ${env.key} is already running` }
    ]
    return new PromotionError('PROMOTION_RUNNING', blockers[0].text, 409, blockers)
  }
  const token = await deps.lock.take(envId, 'promotion')
  if (!token) {
    // X-6b: name the real holder (a creation leg or a stack action takes the same lock).
    const holder = (await deps.lock.holder?.(envId)) ?? null
    const r = lockHolderRefusal(
      holder,
      { code: 'PROMOTION_RUNNING', message: `a promotion of ${env.key} is already running` },
      'promotion'
    )
    if (r.code === 'PROMOTION_RUNNING') throw alreadyRunning()
    throw new PromotionError(r.code, r.message, 409, [
      { code: r.code as PromotionBlockerCode, text: r.message }
    ])
  }
  let handedOff = false
  /** Every GitLab branch the run deploys, held for the whole run (review H1). */
  let branches: BranchHold | null = null
  try {
    // A run of this environment alive in this process (its Redis lock may have vanished).
    if (liveHereFor(envId)) throw alreadyRunning()
    // We hold the lock now: a row still `running` here belongs to a process that lost it —
    // unless its heartbeat says its runner is alive (then it stays, and so does the refusal).
    await interruptStaleRows(envId, true, async () => true, {
      gitCtx: deps.gitCtx,
      ...(deps.now ? { now: deps.now } : {})
    })
    if (await db(DEPLOYS).where({ environment_id: envId, status: 'running' }).first('id'))
      throw alreadyRunning()
    const input = await deps.gather(envId, {
      kind: req.kind,
      version: req.version,
      lockHeld: true,
      ...(apply ? { apply: true } : {})
    })
    const plan = buildPromotionPlan(input)
    if (!plan.ok)
      throw new PromotionError(plan.blockers[0].code, plan.blockers[0].text, 409, plan.blockers)
    // Only the plan the person saw starts: anything it would do differently is checked again.
    if (!apply && plan.plan_hash !== req.planHash)
      throw new PromotionError(
        'PLAN_CHANGED',
        'The plan changed since you checked it — check it again',
        409,
        undefined,
        plan
      )

    // One writer per GitLab branch: a shared deployment upgrade or a move deploying the same
    // branch refuses this start (BRANCH_BUSY), and this run refuses theirs.
    branches = await holdBranches(
      deps.branchLock ?? defaultBranchLock(),
      plan.steps
        .filter((s) => s.driver !== 'docker' && s.kind !== 'stack' && !!s.targetBranch)
        .map((s) => ({
          identity: s.driverIdentity ?? `driver:${s.driverId}`,
          branch: s.targetBranch
        })),
      'promotion'
    )

    const userId = req.user?.id ?? null
    const verb = req.kind === 'rollback' ? 'Roll back' : 'Promote'
    // The job run first: a start that fails there leaves no `running` row behind.
    const run = await deps.startJobRun(
      apply
        ? `Apply stack settings to ${input.app.key} ${env.key} (${req.version})`
        : `${verb} ${input.app.key} ${env.key} to ${req.version}`,
      envId,
      userId
    )
    let deployId: number
    try {
      deployId = Number(
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
          job_run_id: run.id,
          started_by: userId,
          started_at: new Date(),
          heartbeat_at: new Date()
        })
      )
    } catch (err) {
      await run.fail(new Error('The Hub could not record the promotion')).catch(() => undefined)
      throw err
    }

    const entry: Live = {
      envId,
      done: Promise.resolve(),
      run,
      cancel: false,
      lockLost: false,
      abort: new AbortController()
    }
    live.set(deployId, entry)
    markLive(deployId, envId)
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
        deps,
        branches
      })
    )
      .catch((err) =>
        getApp()?.log?.error?.(
          { deployId, err: (err as Error | null)?.name ?? 'Error' },
          'hub promotion bookkeeping failed'
        )
      )
      .finally(() => {
        live.delete(deployId)
        unmarkLive(deployId)
      })
    return { deployId, jobRunId: run.id }
  } finally {
    if (!handedOff) {
      await branches?.release()
      await deps.lock.release(envId, token)
    }
  }
}

/**
 * phase 4, Apply now (P4-30): redeploys the version a Docker environment runs with the image the
 * Hub recorded for it and the environment's saved stack settings and extension pins — a stack
 * update through the agent, run and recorded like a promotion (lock, job run, deploy row, verify,
 * history). Confirmed by typing the environment key. NOT_DEPLOYED when nothing was deployed.
 */
export async function startStackApply(
  envId: number,
  req: { confirm: unknown; user: { id: string } | null },
  deps: StartDeps = defaultStartDeps()
): Promise<{ deployId: number; jobRunId: number | null }> {
  const env = (await db(ENVS).where({ id: envId }).first('key', 'version_pin')) as
    | { key: string; version_pin: string | null }
    | undefined
  if (!env) throw new PromotionError('NOT_FOUND', 'Not found', 404)
  const version = env.version_pin == null ? '' : String(env.version_pin)
  if (!version)
    throw new PromotionError(
      'NOT_DEPLOYED',
      `${env.key} has no deployed stack to apply settings to — deploy it first`
    )
  return startPromotion(
    envId,
    { kind: 'promote', version, confirm: req.confirm, planHash: null, user: req.user, apply: true },
    deps
  )
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
  branches: BranchHold | null
}): Promise<void> {
  const { deployId, envId, deps, entry } = o
  const { run } = entry
  const lostLock = () => {
    if (entry.lockLost) return
    entry.lockLost = true
    run.log('the promotion lock was lost — stopping at the next step', 'error')
  }
  /** This runner is alive: written with every lock renewal, whether or not the lock held. */
  const heartbeat = () =>
    db(DEPLOYS)
      .where({ id: deployId, status: 'running' })
      .update({ heartbeat_at: new Date() })
      .catch(() => undefined)
  const renew = setInterval(() => {
    void deps.lock
      .renew(envId, o.token)
      .then((held) => {
        if (!held) lostLock()
      })
      .catch(() => undefined)
    void heartbeat()
  }, LOCK_RENEW_MS)
  renew.unref?.()
  const setStep = (step: string) =>
    db(DEPLOYS)
      .where({ id: deployId, status: 'running' })
      .update({ step: step.slice(0, 200) })
      .catch(() => undefined)
  // The stored plan carries what each deploy actually ran on (a rollback redeploys exactly that).
  const recorded = JSON.parse(JSON.stringify(o.plan)) as PromotionPlan
  const recordDeploy = async (
    position: number,
    sha: string,
    pipelineId: number | null,
    stack?: StackDeployed
  ) => {
    const st = recorded.steps.find((x) => x.position === position)
    if (!st) return
    st.deployedSha = sha
    st.deployedPipelineId = pipelineId
    // phase 4: what the stack runs — rollback and restart redeploy exactly this.
    if (stack && st.stack) {
      st.deployedSpecHash = stack.specHash
      st.deployedImage = stack.image
      st.stack = { ...st.stack, extensions: { ...stack.extensions } }
    }
    // Only while the row is still this run's (never over a row healed or closed elsewhere).
    await db(DEPLOYS)
      .where({ id: deployId, status: 'running' })
      .update({ plan: JSON.stringify(recorded) })
      .catch(() =>
        run.log(`could not record what ${st.component} deployed on deploy #${deployId}`, 'warn')
      )
  }
  let outcome: RunOutcome
  try {
    outcome = await executePlan(
      o.plan,
      {
        deployId,
        version: o.version,
        kind: o.kind,
        targetKey: o.envKey,
        gitCtx: deps.gitCtx,
        envId // phase 4
      },
      {
        signal: entry.abort.signal,
        onEvent: async (e) => {
          if (e.kind === 'step') await setStep(e.step)
          else if (e.kind === 'deployed')
            await recordDeploy(e.position, e.sha, e.pipelineId, e.stack)
          else run.log(e.line, e.level)
        },
        deps: {
          ...deps.execute,
          currentVersion: deps.execute?.currentVersion ?? currentVersionReader(envId),
          lastDeployedBuild: deps.execute?.lastDeployedBuild ?? lastDeployedBuildReader(envId),
          verifyCiConfig: deps.execute?.verifyCiConfig ?? ciConfigVerifier(envId),
          lockLost: async () => {
            if (!entry.lockLost && o.branches?.lost()) lostLock()
            if (!entry.lockLost && !(await deps.lock.renew(envId, o.token))) lostLock()
            await heartbeat()
            return entry.lockLost
          },
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
    await closeRow(deployId, outcome, run, deps.finishRow ?? finishRunningRow)
    const what = o.plan.apply
      ? `apply stack settings to ${o.envKey} (${o.version})`
      : `${o.kind === 'rollback' ? 'roll back to' : 'promote'} ${o.version} on ${o.envKey}`
    if (outcome.status === 'success') await run.complete(`${what}: done`)
    else if (outcome.status === 'cancelled')
      await run.complete(`${what}: cancelled after ${outcome.step ?? 'the start'}`)
    else
      await run.fail(
        new Error(
          `${what}: ${outcome.status === 'interrupted' ? 'stopped' : 'failed'} at ${outcome.step ?? 'start'} — ${outcome.error}`
        )
      )
  } finally {
    // This runner no longer vouches for the row: one the closing write could not move off
    // `running` becomes stale for the next start or read at once.
    await db(DEPLOYS)
      .where({ id: deployId, status: 'running' })
      .update({ heartbeat_at: null })
      .catch(() => undefined)
    await o.branches?.release().catch(() => undefined)
    await deps.lock.release(envId, o.token)
    await deps.lock.clearCancel(deployId)
    await forgetEnvironmentCaches(envId)
  }
}

/**
 * The closing status write: tried twice. When both fail it is said in the job-run log and the
 * server log with the deploy id; the row stays `running`, and the next start of the environment
 * (or the next plan read) finds it without a lock and marks it interrupted.
 */
async function closeRow(
  deployId: number,
  outcome: RunOutcome,
  run: JobRunHandle,
  write: FinishRow
): Promise<void> {
  const status: HubDeployStatus = outcome.status
  const patch = {
    status,
    error: outcome.error ? outcome.error.slice(0, 1000) : null,
    finished_at: new Date()
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const changed = await write(deployId, patch)
      if (!changed)
        run.log(`deploy #${deployId} is no longer running — its status was left as it is`, 'warn')
      return
    } catch (err) {
      if (attempt < 2) continue
      run.log(
        `could not record the final status (${status}) of deploy #${deployId} — the next start marks it interrupted`,
        'error'
      )
      getApp()?.log?.error?.(
        { deployId, status, err: (err as Error | null)?.name ?? 'Error' },
        'hub: could not record a promotion outcome'
      )
    }
  }
}

/** The environment's cached status and deploy history are stale after a deploy. Best effort. */
async function forgetEnvironmentCaches(envId: number): Promise<void> {
  const redis = appPromoteRedis()
  if (!redis) return
  await Promise.resolve(redis.del(hubStatusKey(envId), ...hubDeploysKeys(envId))).catch(
    () => undefined
  )
}

export type CancelResult =
  | { ok: true; interrupted?: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING' }

/**
 * Asks a running promotion to stop at its next step boundary (any process may be running it).
 * A row nobody runs any more — not here, its lock free and its heartbeat stale — has no runner to
 * see the cancel: it is marked interrupted at once (`interrupted: true`).
 */
export async function cancelPromotion(
  deployId: number,
  user: { id: string } | null,
  deps: { lock: PromoteLock; heal?: Partial<HealDeps> } = { lock: defaultPromoteLock() }
): Promise<CancelResult> {
  const row = (await db(DEPLOYS)
    .where({ id: deployId })
    // A move / shared mirror row is not a promotion (R8): cancelled through its own routes.
    .whereIn('kind', PROMOTION_KINDS)
    .first('id', 'status', 'environment_id', 'step', 'plan', 'job_run_id', 'started_at')) as
    | {
        id: number
        status: string
        environment_id: number
        step: string | null
        plan: string | null
        job_run_id: number | null
        started_at: Date | string | null
      }
    | undefined
  if (!row) return { ok: false, code: 'NOT_FOUND' }
  if (row.status !== 'running') return { ok: false, code: 'NOT_RUNNING' }
  const here = live.get(deployId)
  if (!here && !isLiveHere(deployId)) {
    const heal = healDeps(deps.heal)
    const stale =
      (await deps.lock.held(Number(row.environment_id))) === false &&
      !!(await withoutFreshHeartbeat(
        db(DEPLOYS).where({ id: deployId, status: 'running' }),
        heal.now?.()
      ).first('id'))
    if (
      stale &&
      (await interruptRow(row, `The Hub stopped during ${row.step ?? 'the start'}`, heal))
    )
      return { ok: true, interrupted: true }
  }
  await deps.lock.requestCancel(deployId)
  if (here) {
    here.cancel = true
    here.abort.abort()
    here.run.log(
      `cancel asked${user?.id ? ` by ${user.id}` : ''} — stopping at the next step boundary or deploy wait`,
      'warn'
    )
  }
  return { ok: true }
}

/** How long a status read waits for the heal before it answers anyway. */
export const READ_HEAL_WAIT_MS = 3000

/**
 * Before a status read (GET /promotions/:id, GET /deploys/hub): marks the environment's stale
 * running rows interrupted — only rows nobody holds the lock of and whose heartbeat is stale, so
 * a crashed run does not stay Running until someone opens the Promote panel. Waits at most `ms`
 * (the heal goes on after); never throws, never fails the read.
 */
export async function healBeforeRead(
  envId: number,
  opts: { ms?: number; lock?: PromoteLock; heal?: Partial<HealDeps> } = {}
): Promise<void> {
  try {
    const lock = opts.lock ?? defaultPromoteLock()
    await bounded(
      interruptStaleRows(envId, false, (id) => lock.held(id), opts.heal),
      opts.ms ?? READ_HEAL_WAIT_MS
    )
  } catch {
    /* a read never fails on its heal */
  }
}

export interface RecoverDeps extends Partial<HealDeps> {
  lock: PromoteLock
}

/**
 * Hub boot. A `running` row belongs to whoever holds its environment's lock (5 min, renewed every
 * 60 s): a held (or unreadable) lock means its runner may be alive in some process, and the row is
 * left alone — recovery never deletes a lock. A row whose lock is gone becomes `interrupted` ("The
 * Hub restarted during <step>") and its temporary branches are deleted (promote-heal.ts). A lock
 * a crash left behind expires within 5 min; the next plan read or start heals the row then.
 */
export async function recoverInterruptedPromotions(
  deps: RecoverDeps = { lock: defaultPromoteLock() }
): Promise<number> {
  const heal = healDeps(deps)
  // A fresh heartbeat = a runner alive in some process (its lock may be gone): left alone.
  // Promotion rows only (R8): a move / shared mirror row is healed by its own runner.
  const rows = (await withoutFreshHeartbeat(
    db(DEPLOYS).where({ status: 'running' }).whereIn('kind', PROMOTION_KINDS),
    heal.now?.()
  ).select('id', 'environment_id', 'step', 'plan', 'job_run_id', 'started_at')) as Array<{
    id: number
    environment_id: number
    step: string | null
    plan: string | null
    job_run_id: number | null
    started_at: Date | string | null
  }>
  let n = 0
  for (const r of rows) {
    const id = Number(r.id)
    if (live.has(id) || isLiveHere(id)) continue
    if ((await deps.lock.held(Number(r.environment_id))) !== false) continue
    if (!(await interruptRow(r, `The Hub restarted during ${r.step ?? 'the start'}`, heal)))
      continue
    n++
    await deps.lock.clearCancel(id)
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
  void recoverInterruptedPromotions({ lock: defaultPromoteLock(), logger })
    .then((n) => {
      if (n) logger?.info?.({ interrupted: n }, 'hub: promotions interrupted by a restart')
    })
    .catch((err) =>
      logger?.warn?.({ err: (err as Error | null)?.name }, 'hub: promotion recovery failed')
    )
}

// ── history reads (routes) ───────────────────────────────────────────────────────────────────

const DEPLOY_KINDS: readonly HubDeployKind[] = ['promote', 'rollback', 'move', 'shared']

export type HubDeployListRow = HubDeployRow & { started_by_name: string | null }

function toDeployRow(r: Record<string, unknown>): HubDeployRow {
  const s = (v: unknown) => (v == null ? null : String(v))
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    // Phase 6: move / shared mirror rows keep their kind (history labels them).
    kind: (DEPLOY_KINDS as readonly string[]).includes(String(r.kind))
      ? (r.kind as HubDeployKind)
      : 'promote',
    version: String(r.version),
    from_version: s(r.from_version),
    status: String(r.status) as HubDeployStatus,
    step: s(r.step),
    error: s(r.error),
    plan: s(r.plan),
    job_run_id: r.job_run_id == null ? null : Number(r.job_run_id),
    started_by: s(r.started_by),
    started_at: r.started_at as string | Date,
    finished_at: (r.finished_at as string | Date | null) ?? null,
    ...(planIsApply(r.plan) ? { apply: true as const } : {})
  }
}

/** The stored plan says Apply now (P4-30). An unreadable plan is not one. */
function planIsApply(plan: unknown): boolean {
  if (typeof plan !== 'string' || !plan.includes('"apply"')) return false
  try {
    return (JSON.parse(plan) as { apply?: unknown }).apply === true
  } catch {
    return false
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

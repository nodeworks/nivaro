import { db } from '../../../db/index.js'
import type { GitCtx } from '../../gitlab-client.js'
import { DriverMisconfiguredError, driverCtx, type GitlabDriverRow, getDriver } from '../drivers.js'
import * as gitlab from '../gitlab-write.js'
import { driverIdentity, RERUNNABLE_JOB, sourceSubjectRe } from '../promote-gather.js'
import {
  type BranchLock,
  type BranchRef,
  defaultBranchLock,
  PromotionError
} from '../promote-lock.js'
import { pinContent } from '../promote-plan.js'
import type { PromotionStep } from '../promote-types.js'
import { hubImage, pinText, imageDigest as registryDigest } from '../registry.js'
import { HubSecretError } from '../secrets.js'
import { branchRefOf, gitlabBranchUsers } from './branch-users.js'
import { type SharedDeployment, sharedGitlab } from './store.js'

/**
 * A registered shared deployment the Hub upgrades through GitLab: one that names a GitLab driver
 * and `settings.gitlab` (store.ts sharedGitlab). The deployment's own pipeline deploys it; the
 * Hub drives that pipeline exactly as a promotion drives an api component (promote-run.ts
 * executePlan): the `nivaro <version>` release commit from `source_branch` merged onto the target
 * branch with the pin file (`<version>\n<digest>\n<slim digest>\n`) committed on top, one merge,
 * then the deploy job waited for (played when manual). A rollback reruns the deploy job of the
 * pipeline the Hub recorded for that version (no merge, no pin). The shared upgrade run then waits
 * for the replicas, each app's schema and each app's name as for a Docker deployment.
 *
 * This file gathers what the plan needs from GitLab (reads only) and names the one step the run
 * executes. A same-version run follows a promotion's PIN_CHANGED rules: the pin of the version
 * that runs is never created or rewritten, and nothing new to deploy is ALREADY_RUNS.
 *
 * One writer per branch (review H1): the deploy branch is the deployment's own (required, never
 * the driver's default), BRANCH_IN_USE while an environment's component or another shared
 * deployment deploys it, BRANCH_BUSY while a run holds its branch lock (the run takes it, as
 * promotions and moves do), PIPELINE_RUNNING while a pipeline on it is not over (review M1: a
 * cancelled run's deploy job may still roll). "The version that runs" is what the deployment
 * link answers, not the stored pin (review M3), and the pin on the deploy branch is part of the
 * plan (and its hash).
 *
 * Never a token in a line, a blocker or an answer: GitLab refusals carry the client's own sentence
 * (gitlab-write.ts), any other error a plain one.
 */

const SHARED_DEPLOYS = 'nivaro_hub_shared_deploys'

/**
 * The step's position. executePlan names its temporary branches `hub/promote-<run id>-<position>`;
 * a shared deploy id may equal a promotion's deploy id, and a component position is 1–100, so this
 * one never meets a promotion's branch.
 */
export const SHARED_GITLAB_POSITION = 9000
/** The component name in run lines (`push api`, `deploy api`). */
export const SHARED_GITLAB_COMPONENT = 'api'

/** What the plan answers about the GitLab side (never a token). */
export interface SharedGitlabPlan {
  driver_id: number
  driver: string
  /** The GitLab project path the driver deploys. */
  project: string
  /** repositoryIdentity of the driver when planned (heal checks it before deleting branches). */
  identity: string
  source_branch: string
  target_branch: string
  pin_file: string | null
  before_job: string | null
  deploy_job: string
  /** The release commit an upgrade merges; the recorded build a rollback reruns. */
  commit: string | null
  /** Rollback: the pipeline whose deploy job is rerun. */
  build_pipeline_id: number | null
  /** The pin file the upgrade commits (null on a rollback). */
  pin: string | null
  /** The pin file on the deploy branch now (null: none, or a rollback); bound by plan_hash. */
  pin_on_target: string | null
}

export interface GitlabReadOps {
  latestCommitMatching: typeof gitlab.latestCommitMatching
  commitExistsOn: typeof gitlab.commitExistsOn
  readFile: typeof gitlab.readFile
  jobNamed: typeof gitlab.jobNamed
  activePipelines: typeof gitlab.activePipelines
}

export interface GitlabPlanDeps {
  /** The GitLab context of a driver (token opened for the reads). Default: driverCtx. */
  gitCtx?: (driver: GitlabDriverRow) => GitCtx
  gitlabRead?: Partial<GitlabReadOps>
  imageDigest?: (image: string, tag: string) => Promise<string | 'present' | null>
  /** The per-branch lock (promote-lock.ts); default the Hub's Redis one. */
  branchLock?: BranchLock
}

export interface GitlabGathered {
  driver: GitlabDriverRow | null
  /** The one step the run executes; null when a blocker stops the plan before it. */
  step: PromotionStep | null
  summary: SharedGitlabPlan | null
  /** The repository branch the run locks and deploys. */
  ref: BranchRef | null
}

type Block = (code: string, text: string) => void

/** A GitLab build the Hub recorded for a version on this deployment (its own runs only). */
export interface RecordedGitlabBuild {
  sha: string
  pipeline_id: number | null
}

/**
 * The build of the newest successful Hub run of `version` on this deployment, as its stored plan
 * recorded it (`gitlab_build`, written once the deploy job passed); null when no Hub run of it
 * succeeded, `{sha:'', pipeline_id:null}` when one did but recorded no build (an observed version
 * never counts: the Hub saw it, it did not deploy it).
 */
export async function recordedGitlabBuild(
  sharedId: number,
  version: string
): Promise<RecordedGitlabBuild | null> {
  const rows = (await db(SHARED_DEPLOYS)
    .where({ shared_deployment_id: sharedId, version, status: 'success' })
    .whereNot({ kind: 'observed' })
    .orderBy('id', 'desc')
    .limit(20)
    .select('plan')) as Array<{ plan: string | null }>
  if (!rows.length) return null
  for (const r of rows) {
    try {
      const p = JSON.parse(String(r.plan ?? '')) as { gitlab_build?: unknown }
      const b = p.gitlab_build as { sha?: unknown; pipeline_id?: unknown } | undefined
      if (b && typeof b.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(b.sha))
        return {
          sha: b.sha,
          pipeline_id:
            typeof b.pipeline_id === 'number' && Number.isInteger(b.pipeline_id)
              ? b.pipeline_id
              : null
        }
    } catch {
      /* an unreadable plan proves nothing */
    }
  }
  return { sha: '', pipeline_id: null }
}

/** The plain sentence of a failed GitLab read (never GitLab's body or a token). */
function readFailure(err: unknown): string {
  if (
    err instanceof gitlab.GitlabWriteError ||
    err instanceof PromotionError ||
    err instanceof HubSecretError ||
    err instanceof DriverMisconfiguredError
  )
    return err.message
  return 'GitLab did not answer'
}

const short = (sha: string) => sha.slice(0, 8)

/**
 * Reads what an upgrade (or rollback) of a GitLab-run shared deployment needs and blocks what
 * stops it: NO_DRIVER, GITLAB_UNREACHABLE, BRANCH_IN_USE, BRANCH_BUSY, LOCK_UNAVAILABLE,
 * PIPELINE_RUNNING (both kinds); NO_SOURCE_COMMIT, VERSION_UNKNOWN, PIN_CHANGED, ALREADY_RUNS
 * (upgrade); NOT_DEPLOYED_BEFORE, ROLLBACK_NOT_RECORDED, ROLLBACK_NO_BUILD (rollback). `running`
 * is the version the deployment answers now (its link), else its stored pin. Only called for a
 * version that is x.y.z on a deployment sharedGitlab() names.
 */
export async function gatherGitlabUpgrade(
  shared: SharedDeployment,
  version: string,
  kind: 'upgrade' | 'rollback',
  block: Block,
  deps: GitlabPlanDeps = {},
  running: string | null = shared.version_pin
): Promise<GitlabGathered> {
  const cfg = sharedGitlab(shared)
  const none: GitlabGathered = { driver: null, step: null, summary: null, ref: null }
  if (!cfg) return none
  const found = await getDriver(shared.driver_id)
  if (found?.kind !== 'gitlab') {
    block('NO_DRIVER', 'The shared deployment names no GitLab driver.')
    return none
  }
  const driver: GitlabDriverRow = found
  const ops: GitlabReadOps = {
    latestCommitMatching: gitlab.latestCommitMatching,
    commitExistsOn: gitlab.commitExistsOn,
    readFile: gitlab.readFile,
    jobNamed: gitlab.jobNamed,
    activePipelines: gitlab.activePipelines,
    ...deps.gitlabRead
  }
  const targetBranch = cfg.target_branch
  const pinFile = cfg.pin_file ?? driver.config.pin_file
  const deployJob = cfg.deploy_job ?? driver.config.deploy_job
  const ref = branchRefOf(driver, targetBranch)
  const summary: SharedGitlabPlan = {
    driver_id: driver.id,
    driver: driver.name,
    project: driver.config.project,
    identity: driverIdentity(driver),
    source_branch: cfg.source_branch,
    target_branch: targetBranch,
    pin_file: kind === 'rollback' ? null : pinFile,
    before_job: cfg.before_job,
    deploy_job: deployJob,
    commit: null,
    build_pipeline_id: null,
    pin: null,
    pin_on_target: null
  }
  const base = {
    position: SHARED_GITLAB_POSITION,
    component: SHARED_GITLAB_COMPONENT,
    kind: 'api' as const,
    driverId: driver.id,
    driverIdentity: driverIdentity(driver),
    targetBranch,
    beforeJob: cfg.before_job,
    deployJob,
    // The run verifies each app's own name after the schema wait; the step has no check address.
    verifyUrl: null,
    verifyField: 'version',
    want: version
  }

  // One writer per branch (H1): nothing else deploys it, and no run holds it now.
  const users = await gitlabBranchUsers(ref, { exceptSharedId: shared.id })
  if (users.length)
    block(
      'BRANCH_IN_USE',
      `${targetBranch} of ${driver.config.project} is also deployed by ${users.slice(0, 3).join(', ')} — give this deployment a deploy branch of its own.`
    )
  try {
    const holder = await (deps.branchLock ?? defaultBranchLock()).holder(ref)
    if (holder)
      block(
        'BRANCH_BUSY',
        `${targetBranch} is being deployed by ${holder === 'promotion' ? 'a promotion' : holder === 'move' ? 'a move' : 'a shared deployment upgrade'} — wait for it to end.`
      )
  } catch {
    block(
      'LOCK_UNAVAILABLE',
      `The Hub cannot reach Redis to tell who deploys ${targetBranch} — try again shortly.`
    )
  }

  let ctx: GitCtx
  try {
    ctx = (deps.gitCtx ?? driverCtx)(driver)
  } catch (err) {
    block(
      'GITLAB_UNREACHABLE',
      `The GitLab driver ${driver.name} cannot be used: ${readFailure(err)}.`
    )
    return { driver, step: null, summary, ref }
  }

  // M1: a pipeline on the deploy branch that is not over may still be deploying (a cancelled
  // run's job, the project's own push): never start another deploy beside it.
  try {
    const active = await ops.activePipelines(ctx, targetBranch)
    if (active.length)
      block(
        'PIPELINE_RUNNING',
        `${targetBranch} has a pipeline that is not over yet (${active
          .slice(0, 3)
          .map((p) => `${p.id} ${p.status}`)
          .join(', ')}) — wait for it to end, then plan again.`
      )
  } catch (err) {
    block('GITLAB_UNREACHABLE', `GitLab did not answer the Hub: ${readFailure(err)}.`)
    return { driver, step: null, summary, ref }
  }

  if (kind === 'rollback') {
    const rec = await recordedGitlabBuild(shared.id, version)
    if (!rec) {
      block(
        'NOT_DEPLOYED_BEFORE',
        `The Hub never deployed ${version} on this deployment successfully — nothing to roll back to.`
      )
      return { driver, step: null, summary, ref }
    }
    if (!rec.sha || rec.pipeline_id == null) {
      block(
        'ROLLBACK_NOT_RECORDED',
        `The Hub did not record which pipeline deployed ${version} here, so it cannot redeploy that build.`
      )
      return { driver, step: null, summary, ref }
    }
    summary.commit = rec.sha
    summary.build_pipeline_id = rec.pipeline_id
    try {
      if (!(await ops.commitExistsOn(ctx, rec.sha, targetBranch)))
        block(
          'ROLLBACK_NO_BUILD',
          `${short(rec.sha)} is no longer on ${targetBranch} — that build can't be redeployed.`
        )
      else {
        const job = await ops.jobNamed(ctx, rec.pipeline_id, deployJob)
        if (!job)
          block(
            'ROLLBACK_NO_BUILD',
            `Pipeline ${rec.pipeline_id} for ${short(rec.sha)} has no ${deployJob} job to redeploy.`
          )
        else if (!RERUNNABLE_JOB.includes(job.status))
          block(
            'ROLLBACK_NO_BUILD',
            `The earlier build can't be rerun (its ${deployJob} job is ${job.status || 'unknown'}).`
          )
      }
    } catch (err) {
      if (err instanceof gitlab.GitlabWriteError && err.status === 404)
        block(
          'ROLLBACK_NO_BUILD',
          `GitLab no longer has pipeline ${rec.pipeline_id} for ${short(rec.sha)} — that build can't be redeployed.`
        )
      else block('GITLAB_UNREACHABLE', `GitLab did not answer the Hub: ${readFailure(err)}.`)
    }
    return {
      driver,
      summary,
      ref,
      step: {
        ...base,
        sourceSha: rec.sha,
        pinText: null,
        pinFile: null,
        buildPipelineId: rec.pipeline_id
      }
    }
  }

  // Upgrade: the release commit, the image digests for the pin, and the pin there now (M3: bound
  // into the plan, and judged against the version the deployment answers).
  let src: { sha: string; subject: string } | null = null
  let held = false
  let onTarget: string | null = null
  const sameVersion = version === running
  try {
    src = await ops.latestCommitMatching(ctx, cfg.source_branch, sourceSubjectRe(version))
    if (src) held = await ops.commitExistsOn(ctx, src.sha, targetBranch)
    onTarget = await ops.readFile(ctx, pinFile, targetBranch)
  } catch (err) {
    block('GITLAB_UNREACHABLE', `GitLab did not answer the Hub: ${readFailure(err)}.`)
    return { driver, step: null, summary, ref }
  }
  summary.pin_on_target = onTarget
  if (!src)
    block(
      'NO_SOURCE_COMMIT',
      `No commit on ${cfg.source_branch} names nivaro ${version} (a subject ending "nivaro ${version}").`
    )
  else summary.commit = src.sha

  const digestOf = deps.imageDigest ?? registryDigest
  const repo = hubImage()
  const [digest, slim] = await Promise.all([
    digestOf(repo, version).catch(() => null),
    digestOf(repo, `${version}-slim`).catch(() => null)
  ])
  if (!digest || digest === 'present' || !/^sha256:[0-9a-f]{64}$/.test(digest))
    block(
      'VERSION_UNKNOWN',
      digest === 'present'
        ? `${repo}:${version} is published without a digest the Hub can pin.`
        : `${repo}:${version} is not in the registry.`
    )
  const pin = pinText(version, digest && digest !== 'present' ? digest : null, slim)
  summary.pin = pin

  if (sameVersion && src) {
    const there = pinContent(onTarget)
    if (there === null)
      block(
        'PIN_CHANGED',
        `${targetBranch} has no recorded pin for ${version} (no ${pinFile}). The Hub never creates a pin for the version that is running.`
      )
    else if (there !== pin)
      block(
        'PIN_CHANGED',
        `The image for ${version} changed since it was deployed — ${pinFile} on ${targetBranch} pins another digest than the registry has now. The Hub never rewrites the pin of the version that is running.`
      )
    else if (held)
      block(
        'ALREADY_RUNS',
        `The deployment already runs ${version}, and ${targetBranch} holds its release commit and pin: nothing to deploy.`
      )
  }

  return {
    driver,
    summary,
    ref,
    step: src
      ? {
          ...base,
          sourceSha: src.sha,
          pinText: pin,
          pinFile,
          ...(sameVersion ? { pinMustExist: true } : {})
        }
      : null
  }
}

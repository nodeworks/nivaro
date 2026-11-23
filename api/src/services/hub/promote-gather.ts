import { db } from '../../db/index.js'
import { fetchJson, type GitCtx, gitlabApi } from '../gitlab-client.js'
import { getApp } from '../io-holder.js'
import { environmentFromRow, type HubApp, readApp } from './apps.js'
import { componentTargetBranch, listComponents } from './components.js'
import { gitlabDeployedVersions } from './deploy-evidence.js'
import { type ImageVersions, listImageVersions } from './docker/image-tags.js'
import {
  defaultStackGatherDeps,
  gatherStackFacts,
  type StackGatherDeps
} from './docker/stack-gather.js'
import {
  type DockerDriverRow,
  driverCtx,
  type GitlabDriverRow,
  getDriver,
  getPlacement,
  repositoryIdentity
} from './drivers.js'
import {
  commitExistsOn,
  findPipeline,
  GitlabWriteError,
  jobNamed,
  latestCommitMatching,
  readFile
} from './gitlab-write.js'
import { type HealDeps, interruptStaleRows } from './promote-heal.js'
import { defaultPromoteLock, PromotionError } from './promote-lock.js'
import type {
  HubComponent,
  HubDeployKind,
  HubEnvironmentRow,
  PlanDriver,
  PlanInput,
  PromotionStep,
  StackFacts
} from './promote-types.js'
import { hubImage, imageDigest } from './registry.js'
import {
  HUB_STATUS_TIMEOUT_MS,
  type HubEnvStatus,
  type HubStatusTarget,
  readEnvironmentStatus,
  type StatusCache
} from './status.js'

/**
 * Collects every fact the promotion planner (promote-plan.ts, pure) needs for one environment:
 * the environment and the one before it, the placement's components and their drivers, what each
 * environment runs now (the phase-1 status readers), the Hub's own deploy history, the source
 * commits on GitLab, the frontend commit the previous environment serves and the image digests.
 *
 * Semantics follow scripts/promote-production.mjs:
 *  - the source commit is the newest commit on the component's source branch whose subject ENDS
 *    with `nivaro <version>` (the script's `--grep=nivaro <v>$`), so 0.3.1 never matches 0.3.10;
 *  - the frontend commit is the short sha the previous environment's version.json answers,
 *    resolved to the full sha through the GitLab API before it is checked against the branch;
 *  - "the previous environment ran it" = the Hub's own successful deploys there UNION the
 *    version it answers now UNION the versions its own successful GitLab deploy jobs ran (the
 *    pin file at each job's commit, newest 50 jobs): staging is deployed by the release chain,
 *    not by the Hub, and moves on — an older version it ran is still promotable.
 *
 * A rollback redeploys, per component, the build the Hub recorded when it deployed that version
 * here: the commit the deploy job ran on (the stored plan's `deployedSha`, a merge commit on
 * merge-method repos) and its pipeline (`deployedPipelineId`). The API's build is the commit that
 * carried the old pin, so its rerun deploys the old Nivaro and builds the old extension together;
 * no pin is committed and the registry is not read again. Every build is checked here, so a
 * rollback that cannot redeploy one is refused before anything moves.
 *
 * Rollback offers only versions the Hub deployed here successfully with every component's
 * deployed commit recorded and every API build's pipeline recorded (ROLLBACK_NOT_RECORDED
 * otherwise); never versions from before the Hub.
 *
 * GitLab refusals (no token, unreachable) propagate as GitlabWriteError; the routes answer them.
 */

const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'
const VERSION_RE = /^\d+\.\d+\.\d+$/

export {
  forgetDeployEvidence,
  GITLAB_DEPLOY_EVIDENCE,
  gitlabDeployedVersions,
  pinVersion,
  successfulDeployCommits
} from './deploy-evidence.js'
export { interruptStaleRows } from './promote-heal.js'
export { hubPromoteLockKey, PromotionError } from './promote-lock.js'

/** Deploy job states GitLab can retry (a rollback reruns the earlier build's deploy job). */
export const RERUNNABLE_JOB = ['success', 'failed', 'canceled']

/**
 * Whether an earlier frontend build can be redeployed: its pipeline (recorded, else the newest
 * one GitLab has for the commit on the branch) has the deploy job in a state GitLab reruns.
 */
async function rollbackBuild(
  deps: GatherDeps,
  ctx: GitCtx,
  branch: string,
  sha: string,
  recorded: number | null,
  deployJob: string,
  /** Look the pipeline up by commit when none is recorded (frontend); api: only the recorded one. */
  lookUp: boolean
): Promise<{ pipelineId: number | null; problem: string | null }> {
  const short = sha.slice(0, 8)
  const jobOf = async (id: number) => {
    try {
      return { found: true, job: await deps.jobNamed(ctx, id, deployJob) }
    } catch (err) {
      // A pipeline GitLab no longer has (pruned) answers 404.
      if (err instanceof GitlabWriteError && err.status === 404) return { found: false, job: null }
      throw err
    }
  }
  // An API build is redeployed only from the pipeline the Hub recorded (none = not offered).
  if (!lookUp && !recorded) return { pipelineId: null, problem: null }
  let pipelineId = recorded
  let read = pipelineId ? await jobOf(pipelineId) : { found: false, job: null }
  if (!read.found && lookUp) {
    pipelineId = (await deps.findPipeline(ctx, branch, sha))?.id ?? null
    read = pipelineId ? await jobOf(pipelineId) : read
  }
  if (!pipelineId || !read.found)
    return {
      pipelineId: null,
      problem: `${branch} has no pipeline for ${short} — there is no build of that commit to redeploy`
    }
  const job = read.job
  if (!job)
    return {
      pipelineId,
      problem: `pipeline ${pipelineId} for ${short} has no ${deployJob} job to redeploy`
    }
  if (!RERUNNABLE_JOB.includes(job.status))
    return {
      pipelineId,
      problem: `the earlier build can't be rerun (job is ${job.status || 'unknown'})`
    }
  return { pipelineId, problem: null }
}

/** A value read from a JSON URL (the verify URL, a version.json). Never carries a token. */
export interface ServedField {
  value: string | null
  error: string | null
}

/**
 * Reads `field` from a JSON URL the way the phase-1 status reader reads an environment's public
 * routes: plain GET, no token, bounded by HUB_STATUS_TIMEOUT_MS. Never throws.
 */
export async function readServedField(
  url: string,
  field: string,
  timeoutMs = HUB_STATUS_TIMEOUT_MS
): Promise<ServedField> {
  let timer: NodeJS.Timeout | undefined
  try {
    const res = await Promise.race([
      fetchJson(url, { Accept: 'application/json' }, timeoutMs),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('deadline'), { name: 'AbortError' })),
          timeoutMs
        )
      })
    ])
    if (!res.ok) return { value: null, error: `HTTP ${res.status}` }
    const v = (res.body as Record<string, unknown> | null)?.[field]
    if (typeof v === 'string' && v.trim()) return { value: v.trim(), error: null }
    if (typeof v === 'number') return { value: String(v), error: null }
    return { value: null, error: `no ${field} in the answer` }
  } catch (err) {
    const name = (err as { name?: string } | null)?.name
    return {
      value: null,
      error: name === 'AbortError' || name === 'TimeoutError' ? 'timed out' : 'no answer'
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The full sha of a (short) commit id, or null when GitLab does not know it. Token in the
 * PRIVATE-TOKEN header only, redirects refused; errors never carry GitLab's answer.
 */
export async function resolveCommit(ctx: GitCtx, sha: string): Promise<string | null> {
  const step = 'resolveCommit'
  if (!ctx.token)
    throw new GitlabWriteError('GITLAB_NO_TOKEN', 'The deploy repository has no GitLab token', {
      step
    })
  let res: { ok: boolean; status: number; body: unknown }
  try {
    res = await fetchJson(
      gitlabApi(ctx, `/repository/commits/${encodeURIComponent(sha)}`),
      { 'PRIVATE-TOKEN': ctx.token },
      15_000,
      { redirect: 'error' }
    )
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FETCH_REDIRECT')
      throw new GitlabWriteError('FETCH_REDIRECT', `GitLab redirected ${step}; refused`, { step })
    throw new GitlabWriteError('GITLAB_UNREACHABLE', `GitLab did not answer ${step}`, { step })
  }
  if (res.status === 404) return null
  if (!res.ok)
    throw new GitlabWriteError('GITLAB_REFUSED', `GitLab refused ${step} (${res.status})`, {
      status: res.status,
      step
    })
  const id = (res.body as { id?: unknown } | null)?.id
  return typeof id === 'string' && id ? id : null
}

/** Everything gather reaches outside the database; tests replace parts of it. */
export interface GatherDeps {
  readStatus(env: HubStatusTarget): Promise<HubEnvStatus>
  imageDigest(image: string, tag: string): Promise<string | 'present' | null>
  ctxFor(driver: GitlabDriverRow): GitCtx
  latestCommitMatching: typeof latestCommitMatching
  commitExistsOn: typeof commitExistsOn
  readFile: typeof readFile
  findPipeline: typeof findPipeline
  jobNamed: typeof jobNamed
  resolveCommit: typeof resolveCommit
  readServedField(url: string, field: string): Promise<ServedField>
  /**
   * Versions an environment's own successful GitLab deploy jobs ran: the pin file at each job's
   * commit, through its API components' drivers (newest GITLAB_DEPLOY_EVIDENCE jobs). [] when
   * GitLab cannot tell — the plan then refuses PREVIOUS_NEVER_RAN as before.
   */
  gitlabDeployedVersions(env: { placement_id: number | null }): Promise<string[]>
  /** The promotion lock of this environment is held (by anyone); 'unknown' = Redis unreachable. */
  isLocked(envId: number): Promise<boolean | 'unknown'>
  /** How a stale row's temporary branches are deleted (default: through its driver). */
  heal?: Partial<HealDeps>
  /** phase 4: the agent and stack-settings reads of stack components (default: the real ones). */
  stack?: Partial<StackGatherDeps>
  /** phase 4: published x.y.z tags of an image, newest first (default: Docker Hub). */
  listImageVersions?: (image: string) => Promise<ImageVersions>
}

function appRedis(): StatusCache | null {
  return (getApp()?.redis as StatusCache | undefined) ?? null
}

export function defaultGatherDeps(): GatherDeps {
  return {
    readStatus: (env) => readEnvironmentStatus(env, { fresh: true, redis: appRedis() }),
    imageDigest,
    ctxFor: driverCtx,
    latestCommitMatching,
    commitExistsOn,
    readFile,
    findPipeline,
    jobNamed,
    resolveCommit,
    readServedField: (url, field) => readServedField(url, field),
    gitlabDeployedVersions: (env) => gitlabDeployedVersions(env).catch(() => [] as string[]),
    isLocked: (envId) => defaultPromoteLock().held(envId)
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `nivaro <version>` at the END of a commit subject (0.3.1 never matches a 0.3.10 commit). */
export function sourceSubjectRe(version: string): RegExp {
  return new RegExp(`nivaro ${escapeRe(version)}$`)
}

/**
 * What an environment runs now for one step, read as the plan reads it: the API's version from
 * the status reader (fresh), a frontend's served commit from its check address. null = cannot
 * tell. The runner asks it when a held promote finds its deploy job already succeeded (P30).
 */
export function currentVersionReader(envId: number): (s: PromotionStep) => Promise<string | null> {
  return async (s) => {
    if (s.kind === 'frontend')
      return s.verifyUrl ? (await readServedField(s.verifyUrl, s.verifyField)).value : null
    const row = (await db(ENVS).where({ id: envId }).first()) as Record<string, unknown> | undefined
    if (!row) return null
    return (await readEnvironmentStatus(statusTarget(row), { fresh: true, redis: appRedis() }))
      .version
  }
}

/**
 * The build the Hub's own runs on this environment last deployed for a step's component: the
 * newest run (by id) whose stored step for it recorded a deployedSha — written only once that
 * deploy passed, so a rollback run that redeployed the portal counts even if its API step then
 * failed. null = the Hub has no record (P32).
 */
export function lastDeployedBuildReader(
  envId: number
): (s: PromotionStep) => Promise<{ sha: string; pipelineId: number | null } | null> {
  return async (s) => {
    const c = { name: s.component, kind: s.kind, position: s.position } as HubComponent
    for (const r of await storedRuns(envId)) {
      const st = storedStep(r.steps, c)
      const sha = deployedSha(st)
      if (sha)
        return {
          sha,
          pipelineId: typeof st?.deployedPipelineId === 'number' ? st.deployedPipelineId : null
        }
    }
    return null
  }
}

function statusTarget(r: Record<string, unknown>): HubStatusTarget {
  return {
    id: Number(r.id),
    key: String(r.key),
    base_url: String(r.base_url),
    hub_token: (r.hub_token as string | null) ?? null,
    // Phase 6 (R3): a shared-placed environment is read through its deployment.
    placement_id: r.placement_id == null ? null : Number(r.placement_id)
  }
}

/** The repository a driver deploys: GitLab base (without /api/v4) and project path. */
export function driverIdentity(row: GitlabDriverRow): string {
  return repositoryIdentity(String(row.config?.api ?? ''), String(row.config?.project ?? ''))
}

const unique = (xs: Array<string | null | undefined>) => [
  ...new Set(xs.filter((x): x is string => typeof x === 'string' && !!x))
]

/** A step as the runner stored it in a deploy row's plan JSON. */
export interface StoredStep {
  kind?: string
  component?: string
  position?: number
  deployedSha?: string | null
  deployedPipelineId?: number | null
}

export interface StoredRun {
  kind: string
  version: string
  status: string
  steps: StoredStep[]
}

/** The Hub's runs of one environment, newest first, with their stored steps. */
export async function storedRuns(envId: number): Promise<StoredRun[]> {
  const rows = (await db(DEPLOYS)
    .where({ environment_id: envId })
    .orderBy('id', 'desc')
    .limit(500)
    .select('kind', 'version', 'status', 'plan')) as Array<{
    kind: string
    version: string
    status: string
    plan: string | null
  }>
  return rows.map((r) => {
    let steps: StoredStep[] = []
    try {
      const plan = JSON.parse(String(r.plan ?? '')) as { steps?: StoredStep[] }
      steps = Array.isArray(plan.steps) ? plan.steps : []
    } catch {
      /* an unreadable plan proves nothing */
    }
    return {
      kind: String(r.kind),
      version: String(r.version),
      status: String(r.status),
      steps
    }
  })
}

/** This component's stored step (same name, else same position). */
function storedStep(steps: StoredStep[], c: HubComponent): StoredStep | undefined {
  return (
    steps.find((s) => s.component === c.name && s.kind === c.kind) ??
    steps.find((s) => s.position === c.position && s.kind === c.kind)
  )
}

const deployedSha = (s: StoredStep | undefined) =>
  typeof s?.deployedSha === 'string' && s.deployedSha ? s.deployedSha : null

/**
 * The build the Hub recorded for `version` here for one component: the commit its deploy job ran
 * on and that pipeline. Successful runs first, then any run whose deploy of the component passed
 * (a deployed commit is written only once its deploy passed); one with a pipeline wins over one
 * without (a no-op step of a finished promotion records no pipeline).
 */
export function recordedBuild(
  runs: StoredRun[],
  version: string,
  c: HubComponent
): { sha: string; pipelineId: number | null } | null {
  const mine = runs.filter((r) => r.version === version)
  const ordered = [
    ...mine.filter((r) => r.status === 'success'),
    ...mine.filter((r) => r.status !== 'success')
  ]
  const steps = ordered
    .map((r) => storedStep(r.steps, c))
    .filter((st): st is StoredStep => !!deployedSha(st))
  const pick = steps.find((st) => typeof st.deployedPipelineId === 'number') ?? steps[0]
  if (!pick) return null
  return {
    sha: deployedSha(pick) as string,
    pipelineId: typeof pick.deployedPipelineId === 'number' ? pick.deployedPipelineId : null
  }
}

/** Versions the Hub deployed here successfully with every component's deployed commit recorded. */
function completeVersions(runs: StoredRun[], components: HubComponent[]): string[] {
  return runs
    .filter(
      (r) =>
        r.status === 'success' &&
        components.length > 0 &&
        components.every((c) => !!deployedSha(storedStep(r.steps, c)))
    )
    .map((r) => r.version)
}

/**
 * A Hub PROMOTION of `version` here stopped before every component deployed: some promote run of
 * that version planned a component (its own stored plan has it) that no promote run of the
 * version recorded a deploy for. /promotable then offers the version the environment already
 * answers, so the stopped promotion can be finished; the planner judges the rest. Rollback runs
 * never count, nor a component added after a run that finished, nor an environment the Hub never
 * promoted to that version.
 */
export async function unrecordedComponents(
  envId: number,
  version: string,
  components: HubComponent[]
): Promise<boolean> {
  if (!VERSION_RE.test(version) || !components.length) return false
  const runs = (await storedRuns(envId)).filter(
    (r) => r.kind === 'promote' && r.version === version
  )
  const recorded = (c: HubComponent) => runs.some((r) => !!deployedSha(storedStep(r.steps, c)))
  // Components some run of this version planned itself, matched to the placement's components.
  const planned = components.filter((c) => runs.some((r) => !!storedStep(r.steps, c)))
  return planned.some((c) => !recorded(c))
}

/**
 * Versions the previous environment ran through the Hub successfully (any record). Exported for
 * the shared upgrade's ORDER rule (phase 6, preflight M14): a `shared` success row counts too.
 */
export const successfulVersions = (runs: StoredRun[]) =>
  runs.filter((r) => r.status === 'success').map((r) => r.version)

/**
 * Where the previous environment says which frontend commit it serves: its own component of the
 * same name (else same position, else its only frontend) and that component's verify URL; else
 * this component's verify URL moved onto the previous environment's base URL.
 */
function previousFrontendUrl(
  c: HubComponent,
  target: HubEnvironmentRow,
  previous: HubEnvironmentRow,
  previousComponents: HubComponent[]
): { url: string; field: string } | null {
  const fronts = previousComponents.filter((p) => p.kind === 'frontend' && p.verify_url)
  const match =
    fronts.find((p) => p.name === c.name) ??
    fronts.find((p) => p.position === c.position) ??
    (fronts.length === 1 ? fronts[0] : undefined)
  if (match?.verify_url) return { url: match.verify_url, field: match.verify_field }
  if (!c.verify_url) return null
  try {
    const u = new URL(c.verify_url)
    if (u.origin !== new URL(target.base_url).origin) return null
    const prev = new URL(previous.base_url)
    return { url: `${prev.origin}${u.pathname}${u.search}`, field: c.verify_field }
  } catch {
    return null
  }
}

/**
 * A placement's components, each target branch resolved component → placement (the implicit
 * component deploys to the placement's own branch, as the phase-1 deploy history reads it).
 */
async function componentsForGather(placementId: number | null): Promise<HubComponent[]> {
  if (!placementId) return []
  const [list, placement] = await Promise.all([
    listComponents(placementId),
    getPlacement(placementId)
  ])
  // Phase 6: a shared placement has no components (the shared deployment deploys the app).
  if (placement?.kind === 'shared') return []
  return list.map((c) => ({ ...c, target_branch: componentTargetBranch(c, placement) }))
}

export async function gatherPlanInput(
  envId: number,
  opts: {
    kind: HubDeployKind
    version: string
    lockHeld?: boolean
    /** phase 4, Apply now (P4-30): kind 'promote' of the running version. */
    apply?: boolean
  },
  deps: GatherDeps = defaultGatherDeps()
): Promise<PlanInput> {
  const { kind, version } = opts
  const targetRaw = (await db(ENVS).where({ id: envId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!targetRaw) throw new PromotionError('NOT_FOUND', 'Not found', 404)
  const target = environmentFromRow(targetRaw) as HubEnvironmentRow
  const app = await readApp(target.app_id)
  if (!app) throw new PromotionError('NOT_FOUND', 'Not found', 404)
  // A running row nobody holds the lock of is stale: it never blocks the environment.
  const lock = opts.lockHeld ? true : await deps.isLocked(envId)
  await interruptStaleRows(envId, opts.lockHeld === true, async () => lock, deps.heal)

  const siblings = (await db(ENVS)
    .where({ app_id: target.app_id })
    .orderBy('position', 'asc')
    .orderBy('id', 'asc')) as Array<Record<string, unknown>>
  const at = siblings.findIndex((r) => Number(r.id) === envId)
  const previousRaw = at > 0 ? siblings[at - 1] : null
  const previous = previousRaw ? (environmentFromRow(previousRaw) as HubEnvironmentRow) : null

  const components = await componentsForGather(target.placement_id)
  // Phase 6: the planner refuses SHARED_PLACEMENT for an environment on a shared deployment.
  const sharedPlacement =
    target.placement_id != null && (await getPlacement(target.placement_id))?.kind === 'shared'
  const previousComponents =
    previous && kind === 'promote' ? await componentsForGather(previous.placement_id) : []

  const driverRows = new Map<number, GitlabDriverRow>()
  const dockerRows = new Map<number, DockerDriverRow>() // phase 4
  const drivers: Record<number, PlanDriver> = {}
  for (const id of unique(components.map((c) => String(c.driver_id)))) {
    const row = await getDriver(Number(id))
    if (row?.kind === 'docker') {
      dockerRows.set(row.id, row)
      drivers[row.id] = dockerPlanDriver(row)
      continue
    }
    if (row?.kind !== 'gitlab') continue
    driverRows.set(row.id, row)
    drivers[row.id] = {
      branch: row.config.branch,
      deploy_job: row.config.deploy_job,
      pin_file: row.config.pin_file,
      identity: driverIdentity(row)
    }
  }

  const [targetStatus, previousStatus] = await Promise.all([
    deps.readStatus(statusTarget(targetRaw)),
    previousRaw ? deps.readStatus(statusTarget(previousRaw)) : Promise.resolve(null)
  ])
  const targetVersion = targetStatus.version
  const previousVersion = previousStatus?.version ?? null

  const [prevRuns, targetRuns] = await Promise.all([
    previous ? storedRuns(previous.id) : Promise.resolve([] as StoredRun[]),
    storedRuns(envId)
  ])
  const prevHub = successfulVersions(prevRuns)
  // GitLab evidence (the release chain deploys staging): read only when the Hub's own records
  // and what the previous environment answers now do not already show the version.
  const prevGitlab =
    kind === 'promote' &&
    previous &&
    (!VERSION_RE.test(version) || ![...prevHub, previousVersion].includes(version))
      ? await deps.gitlabDeployedVersions(previous)
      : []
  const targetHub = completeVersions(targetRuns, components)
  // Offered for rollback: every API build's pipeline recorded too (a frontend's is looked up).
  const rollbackVersions = targetHub.filter((v) =>
    components.every((c) => c.kind !== 'api' || recordedBuild(targetRuns, v, c)?.pipelineId != null)
  )
  const thisVersion = targetRuns.filter((r) => r.version === version)
  const recordedDeploys: Record<number, string[]> = {}
  for (const c of components) {
    const shas = unique(thisVersion.map((r) => deployedSha(storedStep(r.steps, c))))
    if (shas.length) recordedDeploys[c.position] = shas
  }

  const versionOk = VERSION_RE.test(version)
  const sources: PlanInput['sources'] = {}
  const sourceOnTarget: PlanInput['sourceOnTarget'] = {}
  const frontendServed: PlanInput['frontendServed'] = {}
  const frontendOnSource: PlanInput['frontendOnSource'] = {}
  const pinOnTarget: NonNullable<PlanInput['pinOnTarget']> = {}
  const frontendOnTarget: NonNullable<PlanInput['frontendOnTarget']> = {}
  const frontendHeld: NonNullable<PlanInput['frontendHeld']> = {}
  const frontendHead: NonNullable<PlanInput['frontendHead']> = {}
  const rollbackBuilds: NonNullable<PlanInput['rollbackBuild']> = {}

  for (const c of components) {
    // phase 4: a stack never reads GitLab, even on a (mismatched) GitLab driver.
    if (c.kind === 'stack') continue
    const driver = driverRows.get(c.driver_id)
    if (!driver || !versionOk) continue
    const targetBranch = componentTargetBranch(c, null, driver.config.branch) as string
    if (kind === 'rollback') {
      // The build the Hub's deploy job ran on here with this version, and its pipeline.
      const build = recordedBuild(targetRuns, version, c)
      if (c.kind === 'frontend') {
        frontendServed[c.position] = build?.sha ?? null
        frontendOnSource[c.position] = true
      }
      if (!build) continue
      // An API build without a recorded pipeline is never looked up: ROLLBACK_NOT_RECORDED.
      if (c.kind === 'api' && build.pipelineId == null) {
        rollbackBuilds[c.position] = { sha: build.sha, pipelineId: null, problem: null }
        continue
      }
      const ctx = deps.ctxFor(driver)
      // A build is redeployed only from its own branch: a commit no longer there is never merged.
      rollbackBuilds[c.position] = (await deps.commitExistsOn(ctx, build.sha, targetBranch))
        ? {
            sha: build.sha,
            ...(await rollbackBuild(
              deps,
              ctx,
              targetBranch,
              build.sha,
              build.pipelineId,
              c.deploy_job ?? driver.config.deploy_job,
              c.kind === 'frontend'
            ))
          }
        : {
            sha: build.sha,
            pipelineId: null,
            problem: `${build.sha.slice(0, 8)} is no longer on ${targetBranch} — that build can't be redeployed`
          }
      continue
    }
    if (c.kind === 'api') {
      const ctx = deps.ctxFor(driver)
      const src = await deps.latestCommitMatching(ctx, c.source_branch, sourceSubjectRe(version))
      sources[c.position] = src
      if (src) sourceOnTarget[c.position] = await deps.commitExistsOn(ctx, src.sha, targetBranch)
      // Is the pin already there (a no-op), or would a same-version run rewrite it?
      if (
        kind === 'promote' &&
        driver.config.pin_file &&
        (sourceOnTarget[c.position] === true || targetVersion === version)
      )
        pinOnTarget[c.position] = await deps.readFile(ctx, driver.config.pin_file, targetBranch)
      continue
    }
    const where = previous ? previousFrontendUrl(c, target, previous, previousComponents) : null
    const [served, onTarget] = await Promise.all([
      where ? deps.readServedField(where.url, where.field).then((r) => r.value) : null,
      c.verify_url ? deps.readServedField(c.verify_url, c.verify_field).then((r) => r.value) : null
    ])
    frontendServed[c.position] = served
    frontendOnTarget[c.position] = onTarget
    if (!served) continue
    const ctx = deps.ctxFor(driver)
    const full = await deps.resolveCommit(ctx, served)
    frontendOnSource[c.position] = full
      ? await deps.commitExistsOn(ctx, full, c.source_branch)
      : false
    if (full) frontendHeld[c.position] = await deps.commitExistsOn(ctx, full, targetBranch)
    // Held: the run deploys the branch head; the plan names it and the run refuses if it moved.
    if (frontendHeld[c.position])
      frontendHead[c.position] =
        (await deps.latestCommitMatching(ctx, targetBranch, /^/, 1))?.sha ?? null
  }

  // A rollback redeploys recorded builds (a stack: the recorded image, P4-29): the registry is
  // not read again.
  const hasApi = components.some((c) => c.kind === 'api')
  const hasStack = components.some((c) => c.kind === 'stack') // phase 4
  const [digest, slimDigest] =
    versionOk && kind === 'promote' && !opts.apply && (hasApi || hasStack)
      ? await Promise.all([
          deps.imageDigest(hubImage(), version),
          deps.imageDigest(hubImage(), `${version}-slim`)
        ])
      : [null, null]

  const stackInput = await gatherStackInput(
    components,
    dockerRows,
    { env: target, previous, app, kind, version, apply: opts.apply === true },
    deps
  )

  const runningRow = await db(DEPLOYS)
    .where({ environment_id: envId, status: 'running' })
    .first('id')
  // Our own lock never counts; an unknown lock is a plan line, and start answers 503 then.
  const running = !!runningRow || (!opts.lockHeld && lock === true)

  return {
    ...(opts.apply ? { apply: true } : {}),
    ...(sharedPlacement ? { sharedPlacement: true } : {}),
    app,
    target,
    previous,
    components,
    kind,
    version,
    targetVersion,
    previousVersion,
    previousDeployedVersions: unique([...prevHub, previousVersion, ...prevGitlab]),
    targetDeployedVersions: unique(targetHub),
    rollbackVersions: unique(rollbackVersions),
    recordedDeploys,
    pinOnTarget,
    frontendOnTarget,
    frontendHeld,
    frontendHead,
    rollbackBuild: rollbackBuilds,
    sources,
    frontendServed,
    frontendOnSource,
    sourceOnTarget,
    digest,
    slimDigest,
    running,
    ...(lock === 'unknown' ? { lockUnknown: true } : {}),
    targetState: targetStatus.state,
    drivers,
    ...stackInput
  }
}

// ---------------------------------------------------------------------------------------------
// phase 4: stack components (Docker placements). Kept apart from the phase-2 GitLab gathering
// above: a placement with no stack component adds nothing here.

/** A docker driver as the planner sees it: no branch, job or pin file. */
function dockerPlanDriver(row: DockerDriverRow): PlanDriver {
  return {
    kind: 'docker',
    branch: '',
    deploy_job: '',
    pin_file: '',
    dns_mode: row.config?.dns_mode === 'manual' ? 'manual' : 'automatic'
  }
}

/**
 * The facts of every stack component on a Docker driver, and — for a promotion into the first
 * environment of an all-stack app (Decision 11) — the image's published releases. With no valid
 * version (the promotable listing asks with '') only the releases are read: no agent call.
 */
async function gatherStackInput(
  components: HubComponent[],
  dockerRows: Map<number, DockerDriverRow>,
  ctx: {
    env: HubEnvironmentRow
    previous: HubEnvironmentRow | null
    app: HubApp
    kind: HubDeployKind
    version: string
    apply?: boolean
  },
  deps: GatherDeps
): Promise<Pick<PlanInput, 'stacks' | 'registryVersions' | 'registryError'>> {
  const stackComponents = components.filter((c) => c.kind === 'stack')
  if (!stackComponents.length) return {}
  const out: Pick<PlanInput, 'stacks' | 'registryVersions' | 'registryError'> = {}
  if (VERSION_RE.test(ctx.version)) {
    const stackDeps: StackGatherDeps = { ...defaultStackGatherDeps(), ...(deps.stack ?? {}) }
    const stacks: Record<number, StackFacts> = {}
    for (const c of stackComponents) {
      const driver = dockerRows.get(c.driver_id)
      if (!driver) continue
      stacks[c.position] = await gatherStackFacts(c, { ...ctx, driver }, stackDeps)
    }
    out.stacks = stacks
  }
  if (
    ctx.kind === 'promote' &&
    !ctx.apply &&
    !ctx.previous &&
    components.every((c) => c.kind === 'stack')
  ) {
    const releases = await (deps.listImageVersions ?? listImageVersions)(hubImage())
    out.registryVersions = releases.versions
    if (releases.error) out.registryError = releases.error
  }
  return out
}

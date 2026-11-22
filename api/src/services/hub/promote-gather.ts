import { db } from '../../db/index.js'
import { fetchJson, type GitCtx, gitlabApi } from '../gitlab-client.js'
import { getApp } from '../io-holder.js'
import { environmentFromRow, readApp } from './apps.js'
import { listComponents } from './components.js'
import { listEnvironmentDeploys } from './deploys.js'
import { driverCtx, getDriver, getPlacement, type HubDriverRow } from './drivers.js'
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
  PlanInput
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
 *    version it answers now (staging is deployed by the release chain, not by the Hub).
 *
 * A rollback's frontend commit is the commit the Hub's deploy job actually ran on when it deployed
 * that version here (the stored plan's `deployedSha`, a merge commit on merge-method repos) and
 * its pipeline; it was deployed there, so it counts as on its branch. The build is checked here,
 * so a rollback whose frontend cannot be redeployed is refused before the API moves.
 *
 * Rollback offers only versions the Hub deployed here successfully with every component's
 * deployed commit recorded; versions from GitLab's own history (deployed before the Hub) only
 * when the placement has no frontend component (an API pin can be rewritten; a frontend build
 * the Hub never recorded cannot be found again).
 *
 * GitLab refusals (no token, unreachable) propagate as GitlabWriteError; the routes answer them.
 */

const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'
const VERSION_RE = /^\d+\.\d+\.\d+$/

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
  deployJob: string
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
  let pipelineId = recorded
  let read = pipelineId ? await jobOf(pipelineId) : { found: false, job: null }
  if (!read.found) {
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
  ctxFor(driver: HubDriverRow): GitCtx
  latestCommitMatching: typeof latestCommitMatching
  commitExistsOn: typeof commitExistsOn
  readFile: typeof readFile
  findPipeline: typeof findPipeline
  jobNamed: typeof jobNamed
  resolveCommit: typeof resolveCommit
  readServedField(url: string, field: string): Promise<ServedField>
  /** Versions the environment's own GitLab deploy history shows a successful deploy job for. */
  gitlabDeployedVersions(env: { placement_id: number | null }): Promise<string[]>
  /** The promotion lock of this environment is held (by anyone); 'unknown' = Redis unreachable. */
  isLocked(envId: number): Promise<boolean | 'unknown'>
  /** How a stale row's temporary branches are deleted (default: through its driver). */
  heal?: Partial<HealDeps>
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
    gitlabDeployedVersions: async (env) => {
      try {
        const { data } = await listEnvironmentDeploys(env, { limit: 50 })
        return data
          .filter((d) => d.deploy_job?.status === 'success' && d.version)
          .map((d) => d.version as string)
      } catch {
        return []
      }
    },
    isLocked: (envId) => defaultPromoteLock().held(envId)
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `nivaro <version>` at the END of a commit subject (0.3.1 never matches a 0.3.10 commit). */
export function sourceSubjectRe(version: string): RegExp {
  return new RegExp(`nivaro ${escapeRe(version)}$`)
}

function statusTarget(r: Record<string, unknown>): HubStatusTarget {
  return {
    id: Number(r.id),
    key: String(r.key),
    base_url: String(r.base_url),
    hub_token: (r.hub_token as string | null) ?? null
  }
}

const unique = (xs: Array<string | null | undefined>) => [
  ...new Set(xs.filter((x): x is string => typeof x === 'string' && !!x))
]

/** A step as the runner stored it in a deploy row's plan JSON. */
interface StoredStep {
  kind?: string
  component?: string
  position?: number
  deployedSha?: string | null
  deployedPipelineId?: number | null
}

interface StoredRun {
  kind: string
  version: string
  status: string
  steps: StoredStep[]
}

/** The Hub's runs of one environment, newest first, with their stored steps. */
async function storedRuns(envId: number): Promise<StoredRun[]> {
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

/** Versions the previous environment ran through the Hub successfully (any record). */
const successfulVersions = (runs: StoredRun[]) =>
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
 * A placement's components; the implicit component of a phase-1 placement deploys to the
 * placement's own target branch when it names one (as the phase-1 deploy history reads it).
 */
async function componentsForGather(placementId: number | null): Promise<HubComponent[]> {
  if (!placementId) return []
  const list = await listComponents(placementId)
  if (!list.some((c) => c.implicit)) return list
  const branch = (await getPlacement(placementId))?.target.branch ?? null
  return list.map((c) =>
    c.implicit && branch && !c.target_branch ? { ...c, target_branch: branch } : c
  )
}

export async function gatherPlanInput(
  envId: number,
  opts: { kind: HubDeployKind; version: string; lockHeld?: boolean },
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
  const previousComponents =
    previous && kind === 'promote' ? await componentsForGather(previous.placement_id) : []

  const driverRows = new Map<number, HubDriverRow>()
  const drivers: Record<number, PlanDriver> = {}
  for (const id of unique(components.map((c) => String(c.driver_id)))) {
    const row = await getDriver(Number(id))
    if (row?.kind !== 'gitlab') continue
    driverRows.set(row.id, row)
    drivers[row.id] = {
      branch: row.config.branch,
      deploy_job: row.config.deploy_job,
      pin_file: row.config.pin_file
    }
  }

  const [targetStatus, previousStatus] = await Promise.all([
    deps.readStatus(statusTarget(targetRaw)),
    previousRaw ? deps.readStatus(statusTarget(previousRaw)) : Promise.resolve(null)
  ])
  const targetVersion = targetStatus.version
  const previousVersion = previousStatus?.version ?? null

  const hasFrontend = components.some((c) => c.kind === 'frontend')
  const [prevRuns, targetRuns, targetGitlab] = await Promise.all([
    previous ? storedRuns(previous.id) : Promise.resolve([] as StoredRun[]),
    storedRuns(envId),
    kind === 'rollback' && !hasFrontend
      ? deps.gitlabDeployedVersions(target)
      : Promise.resolve([] as string[])
  ])
  const prevHub = successfulVersions(prevRuns)
  const targetHub = completeVersions(targetRuns, components)
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
  const frontendRollbackBuild: NonNullable<PlanInput['frontendRollbackBuild']> = {}

  for (const c of components) {
    const driver = driverRows.get(c.driver_id)
    if (!driver || !versionOk) continue
    const targetBranch = c.target_branch ?? driver.config.branch
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
    if (kind === 'rollback') {
      // The commit the Hub's deploy job ran on here with this version, and its pipeline.
      const run = targetRuns.find(
        (r) =>
          r.status === 'success' && r.version === version && !!deployedSha(storedStep(r.steps, c))
      )
      const step = run ? storedStep(run.steps, c) : undefined
      const sha = deployedSha(step)
      frontendServed[c.position] = sha
      frontendOnSource[c.position] = true
      if (!sha) continue
      const ctx = deps.ctxFor(driver)
      // A build is redeployed only from its own branch: a commit no longer there is never merged.
      frontendRollbackBuild[c.position] = (await deps.commitExistsOn(ctx, sha, targetBranch))
        ? await rollbackBuild(
            deps,
            ctx,
            targetBranch,
            sha,
            typeof step?.deployedPipelineId === 'number' ? step.deployedPipelineId : null,
            c.deploy_job ?? driver.config.deploy_job
          )
        : {
            pipelineId: null,
            problem: `${sha.slice(0, 8)} is no longer on ${targetBranch} — that build can't be redeployed`
          }
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

  const hasApi = components.some((c) => c.kind === 'api')
  const [digest, slimDigest] =
    hasApi && versionOk
      ? await Promise.all([
          deps.imageDigest(hubImage(), version),
          deps.imageDigest(hubImage(), `${version}-slim`)
        ])
      : [null, null]

  const runningRow = await db(DEPLOYS)
    .where({ environment_id: envId, status: 'running' })
    .first('id')
  // Our own lock never counts; an unknown lock is a plan line, and start answers 503 then.
  const running = !!runningRow || (!opts.lockHeld && lock === true)

  return {
    app,
    target,
    previous,
    components,
    kind,
    version,
    targetVersion,
    previousVersion,
    previousDeployedVersions: unique([...prevHub, previousVersion]),
    targetDeployedVersions: unique([...targetHub, ...targetGitlab]),
    recordedDeploys,
    pinOnTarget,
    frontendOnTarget,
    frontendHeld,
    frontendHead,
    frontendRollbackBuild,
    sources,
    frontendServed,
    frontendOnSource,
    sourceOnTarget,
    digest,
    slimDigest,
    running,
    ...(lock === 'unknown' ? { lockUnknown: true } : {}),
    targetState: targetStatus.state,
    drivers
  }
}

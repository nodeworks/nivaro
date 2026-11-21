import { db } from '../../db/index.js'
import { fetchJson, type GitCtx, gitlabApi } from '../gitlab-client.js'
import { getApp } from '../io-holder.js'
import { environmentFromRow, readApp } from './apps.js'
import { listComponents } from './components.js'
import { listEnvironmentDeploys } from './deploys.js'
import { driverCtx, getDriver, getPlacement, type HubDriverRow } from './drivers.js'
import { commitExistsOn, GitlabWriteError, latestCommitMatching } from './gitlab-write.js'
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
 * A rollback's frontend commit is the one the Hub deployed with that version before (its stored
 * plan); it was deployed there, so it counts as on its branch.
 *
 * GitLab refusals (no token, unreachable) propagate as GitlabWriteError; the routes answer them.
 */

const ENVS = 'nivaro_hub_environments'
const DEPLOYS = 'nivaro_hub_deploys'
const VERSION_RE = /^\d+\.\d+\.\d+$/

export { interruptStaleRows } from './promote-heal.js'
export { hubPromoteLockKey, PromotionError } from './promote-lock.js'

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

async function successfulVersions(envId: number): Promise<string[]> {
  const rows = (await db(DEPLOYS)
    .where({ environment_id: envId, status: 'success' })
    .orderBy('id', 'desc')
    .select('version')) as Array<{ version: string }>
  return rows.map((r) => String(r.version))
}

const unique = (xs: Array<string | null | undefined>) => [
  ...new Set(xs.filter((x): x is string => typeof x === 'string' && !!x))
]

/** The frontend commit the Hub deployed to `envId` together with `version`, from its stored plan. */
async function frontendDeployedWith(
  envId: number,
  version: string,
  c: HubComponent
): Promise<string | null> {
  const rows = (await db(DEPLOYS)
    .where({ environment_id: envId, status: 'success', version })
    .orderBy('id', 'desc')
    .select('plan')) as Array<{ plan: string | null }>
  for (const r of rows) {
    try {
      const plan = JSON.parse(String(r.plan ?? '')) as {
        steps?: Array<{ kind?: string; component?: string; position?: number; sourceSha?: string }>
      }
      const steps = (plan.steps ?? []).filter((s) => s.kind === 'frontend')
      const hit =
        steps.find((s) => s.component === c.name) ?? steps.find((s) => s.position === c.position)
      if (hit?.sourceSha) return hit.sourceSha
    } catch {
      /* an unreadable plan proves nothing */
    }
  }
  return null
}

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

  const [prevHub, targetHub, targetGitlab] = await Promise.all([
    previous ? successfulVersions(previous.id) : Promise.resolve([]),
    successfulVersions(envId),
    kind === 'rollback' ? deps.gitlabDeployedVersions(target) : Promise.resolve([])
  ])

  const versionOk = VERSION_RE.test(version)
  const sources: PlanInput['sources'] = {}
  const sourceOnTarget: PlanInput['sourceOnTarget'] = {}
  const frontendServed: PlanInput['frontendServed'] = {}
  const frontendOnSource: PlanInput['frontendOnSource'] = {}

  for (const c of components) {
    const driver = driverRows.get(c.driver_id)
    if (!driver || !versionOk) continue
    const targetBranch = c.target_branch ?? driver.config.branch
    if (c.kind === 'api') {
      const ctx = deps.ctxFor(driver)
      const src = await deps.latestCommitMatching(ctx, c.source_branch, sourceSubjectRe(version))
      sources[c.position] = src
      if (src) sourceOnTarget[c.position] = await deps.commitExistsOn(ctx, src.sha, targetBranch)
      continue
    }
    if (kind === 'rollback') {
      // The commit the Hub deployed here with this version; it was deployed, so it is on its branch.
      frontendServed[c.position] = await frontendDeployedWith(envId, version, c)
      frontendOnSource[c.position] = true
      continue
    }
    const where = previous ? previousFrontendUrl(c, target, previous, previousComponents) : null
    const served = where ? (await deps.readServedField(where.url, where.field)).value : null
    frontendServed[c.position] = served
    if (!served) continue
    const ctx = deps.ctxFor(driver)
    const full = await deps.resolveCommit(ctx, served)
    frontendOnSource[c.position] = full
      ? await deps.commitExistsOn(ctx, full, c.source_branch)
      : false
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

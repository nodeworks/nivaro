import { type GitlabJob, gitlabJobs, gitlabPipelines } from '../gitlab-client.js'
import { componentTargetBranch } from './components.js'
import { driverCtx, getDriver, getPlacement } from './drivers.js'

export interface HubDeploy {
  pipeline_id: number
  ref: string
  sha: string
  status: string
  started_at: string | null
  finished_at: string | null
  web_url: string
  deploy_job: { status: string; web_url: string } | null
  version: string | null
}

/** A deploy-history answer is kept this long per environment + limit (?fresh=1 skips it). */
export const HUB_DEPLOYS_TTL_S = 60
/** The limits a deploy-history read may ask for (the route clamps to this range). */
export const HUB_DEPLOYS_MAX_LIMIT = 50

export function hubDeploysKey(envId: number | string, limit: number): string {
  return `nvr:hub:deploys:${envId}:${limit}`
}

/** Every deploy-history cache key of one environment (one per limit). */
export function hubDeploysKeys(envId: number | string): string[] {
  return Array.from({ length: HUB_DEPLOYS_MAX_LIMIT }, (_, i) => hubDeploysKey(envId, i + 1))
}

export class GitlabUnreachableError extends Error {
  code = 'GITLAB_UNREACHABLE'
  constructor(message: string) {
    super(message)
    this.name = 'GitlabUnreachableError'
  }
}

/** `chore: sync for nivaro 0.3.208` / `chore: promote nivaro 0.3.208 to production` -> `0.3.208`. */
export function versionFromSubject(subject: string | null | undefined): string | null {
  const m = /(?<![\w-])nivaro\s+(\d+\.\d+\.\d+(?:-[\w.]*\w)?)(?!\.?\w)/i.exec(
    (subject ?? '').trim()
  )
  return m ? m[1] : null
}

export async function listEnvironmentDeploys(
  env: { placement_id: number | null },
  opts: { limit?: number } = {}
): Promise<{ data: HubDeploy[]; reason?: 'NO_DRIVER' }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, HUB_DEPLOYS_MAX_LIMIT))
  if (!env.placement_id) return { data: [], reason: 'NO_DRIVER' }
  const placement = await getPlacement(env.placement_id)
  const driver = placement ? await getDriver(placement.driver_id) : null
  if (!placement || !driver || driver.kind !== 'gitlab') return { data: [], reason: 'NO_DRIVER' }

  try {
    const ctx = {
      ...driverCtx(driver),
      // The placement's own driver stand-in: its branch, else the driver's (one rule, shared).
      ref: componentTargetBranch(null, placement, driver.config.branch) ?? driver.config.branch
    }
    const pipelines = (await gitlabPipelines(ctx, { perPage: limit })).slice(0, limit)
    const data = await Promise.all(
      pipelines.map(async (p): Promise<HubDeploy> => {
        let jobs: GitlabJob[] = []
        try {
          jobs = await gitlabJobs(ctx, p.id)
        } catch {
          jobs = []
        }
        const job = jobs.find((j) => j.name === driver.config.deploy_job)
        return {
          pipeline_id: p.id,
          ref: p.ref ?? '',
          sha: p.sha ?? '',
          status: p.status,
          started_at: p.created_at || null,
          finished_at: p.updated_at || null,
          web_url: p.web_url ?? '',
          deploy_job: job ? { status: job.status, web_url: job.web_url } : null,
          version: versionFromSubject(p.title)
        }
      })
    )
    return { data }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    if (
      code === 'DRIVER_MISCONFIGURED' ||
      (typeof code === 'string' && code.startsWith('HUB_SECRET'))
    ) {
      throw err
    }
    throw new GitlabUnreachableError(err instanceof Error ? err.message : String(err))
  }
}

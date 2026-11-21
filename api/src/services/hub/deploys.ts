import { type GitlabJob, gitlabJobs, gitlabPipelines } from '../gitlab-client.js'
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

export class GitlabUnreachableError extends Error {
  code = 'GITLAB_UNREACHABLE'
  constructor(message: string) {
    super(message)
    this.name = 'GitlabUnreachableError'
  }
}

/** `chore: sync for nivaro 0.3.208` -> `0.3.208`. */
export function versionFromSubject(subject: string | null | undefined): string | null {
  const m = /\bnivaro\s+(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\s*$/i.exec((subject ?? '').trim())
  return m ? m[1] : null
}

export async function listEnvironmentDeploys(
  env: { placement_id: number | null },
  opts: { limit?: number } = {}
): Promise<{ data: HubDeploy[]; reason?: 'NO_DRIVER' }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50))
  if (!env.placement_id) return { data: [], reason: 'NO_DRIVER' }
  const placement = await getPlacement(env.placement_id)
  const driver = placement ? await getDriver(placement.driver_id) : null
  if (!placement || !driver || driver.kind !== 'gitlab') return { data: [], reason: 'NO_DRIVER' }

  try {
    const ctx = {
      ...driverCtx(driver),
      ref: placement.target.branch ?? driver.config.branch
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

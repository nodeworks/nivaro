/**
 * Nivaro Hub: a promotion (or rollback) of an app the Hub CREATED re-checks its deploy
 * repository's CI settings before each step writes or deploys anything there (phase-3 merge
 * item, review "merge risks"). The repository must still run the pinned template's deploy job
 * (`ci_config_path`) with pipeline variables locked down — a project edited since creation would
 * otherwise run its own CI with the protected deploy variables. Fail closed: CI_CONFIG_REFUSED,
 * nothing written (GitLab is only read: verifyOnly).
 *
 * Only the step whose driver is the one the creation made (or whose project is the app's own
 * deploy_project) is checked; a component in another repository (a portal added later) is not
 * a template repository and is left alone. Apps that were not created by the Hub (no target_id)
 * are never checked.
 */
import { db } from '../../../db/index.js'
import type { GitCtx } from '../../gitlab-client.js'
import { GitlabWriteError } from '../gitlab-write.js'
import type { PromotionStep } from '../promote-types.js'
import { configureProject } from './gitlab-provision.js'
import { projectSettings } from './steps.js'
import { appMade } from './store.js'
import { getTargetRow, type HubTargetRow } from './targets.js'

type Created = {
  target: HubTargetRow | null
  driverId: number | null
  projects: Set<string>
}

/**
 * One environment's checker, read once per run (memoised): `(step, its git context) → void`,
 * throwing CI_CONFIG_REFUSED when the created app's deploy repository is not what the Hub set.
 */
export function ciConfigVerifier(envId: number): (s: PromotionStep, c: GitCtx) => Promise<void> {
  let memo: Promise<Created | null> | undefined
  const load = async (): Promise<Created | null> => {
    const env = (await db('nivaro_hub_environments').where({ id: envId }).first('app_id')) as
      | { app_id: number | null }
      | undefined
    if (env?.app_id == null) return null
    // Whole row: an app table without the phase-3 columns reads as "not created by the Hub".
    const app = (await db('nivaro_hub_apps').where({ id: env.app_id }).first()) as
      | { id: number; target_id?: number | null; deploy_project?: string | null }
      | undefined
    if (app?.target_id == null) return null
    const made = await appMade(Number(app.id))
    const projects = new Set<string>()
    if (made.project_id != null) projects.add(String(made.project_id))
    if (made.project_path) projects.add(made.project_path)
    if (app.deploy_project?.trim()) projects.add(app.deploy_project.trim())
    return {
      target: await getTargetRow(Number(app.target_id)),
      driverId: made.driver_id ?? null,
      projects
    }
  }
  return async (s, c) => {
    memo ??= load()
    let info: Created | null
    try {
      info = await memo
    } catch (err) {
      memo = undefined
      throw err
    }
    if (!info) return
    const ours =
      (info.driverId != null && s.driverId === info.driverId) || info.projects.has(c.project)
    if (!ours) return
    if (!info.target)
      throw new GitlabWriteError(
        'CI_CONFIG_REFUSED',
        'The app was created from a target the Hub no longer has, so its CI settings cannot be checked',
        { step: 'configureProject' }
      )
    await configureProject(c, projectSettings(info.target), { verifyOnly: true })
  }
}

import { db } from '../../../db/index.js'
import { componentTargetBranch, listComponents } from '../components.js'
import { type GitlabDriverRow, getPlacement, listDrivers, repositoryIdentity } from '../drivers.js'
import type { BranchRef } from '../promote-lock.js'

/**
 * One writer per GitLab branch (review H1): who else deploys a repository branch. A shared
 * deployment the Hub upgrades through GitLab must have a deploy branch nothing else deploys: no
 * component of a placement an environment uses (an implicit one included: the placement's or the
 * driver's branch), and no other shared deployment that is not retired. Read at save
 * (store.ts BRANCH_IN_USE) and again by every plan (the driver's default branch or a component may
 * change later). The run's branch lock (promote-lock.ts holdBranches) keeps two runs apart even
 * then. Drivers are compared by repository (repositoryIdentity), never by id: two drivers may
 * point at one project.
 */

const SHARED = 'nivaro_hub_shared_deployments'
const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'

/** The repository + branch a GitLab driver row deploys `branch` of. */
export function branchRefOf(driver: GitlabDriverRow, branch: string): BranchRef {
  return { identity: repositoryIdentity(driver.config.api, driver.config.project), branch }
}

/**
 * Plain names of what else deploys `ref` (`app/env`, `shared deployment <key>`); empty when
 * nothing does. `exceptSharedId` is the deployment being saved or planned.
 */
export async function gitlabBranchUsers(
  ref: BranchRef,
  opts: { exceptSharedId?: number | null } = {}
): Promise<string[]> {
  const drivers = (await listDrivers()).filter(
    (d): d is GitlabDriverRow =>
      d.kind === 'gitlab' && repositoryIdentity(d.config.api, d.config.project) === ref.identity
  )
  if (!drivers.length) return []
  const byId = new Map(drivers.map((d) => [d.id, d]))
  const ids = [...byId.keys()]
  const out: string[] = []

  // Placements an environment uses, on one of these drivers or with a component on one.
  const envRows = (await db(`${ENVS} as e`)
    .join(`${APPS} as a`, 'a.id', 'e.app_id')
    .whereNotNull('e.placement_id')
    .select('e.placement_id', 'e.key as env', 'a.key as app')) as Array<{
    placement_id: number
    env: string
    app: string
  }>
  const seen = new Set<number>()
  for (const row of envRows) {
    const pid = Number(row.placement_id)
    if (seen.has(pid)) continue
    seen.add(pid)
    const placement = await getPlacement(pid)
    if (placement?.kind !== 'dedicated') continue
    const comps = await listComponents(pid)
    for (const c of comps) {
      if (c.kind === 'stack' || !ids.includes(Number(c.driver_id))) continue
      const d = byId.get(Number(c.driver_id)) as GitlabDriverRow
      if (componentTargetBranch(c, placement, d.config.branch) === ref.branch) {
        const users = envRows.filter((r) => Number(r.placement_id) === pid)
        out.push(...users.map((u) => `${u.app}/${u.env}`))
        break
      }
    }
  }

  // Other shared deployments the Hub upgrades through GitLab.
  const shared = (await db(SHARED)
    .whereIn('driver_id', ids)
    .where({ mode: 'registered' })
    .whereNot({ status: 'retired' })
    .select('id', 'key', 'settings')) as Array<{ id: number; key: string; settings: unknown }>
  for (const s of shared) {
    if (opts.exceptSharedId != null && Number(s.id) === opts.exceptSharedId) continue
    let target: unknown = null
    try {
      const v = typeof s.settings === 'string' ? JSON.parse(s.settings) : s.settings
      target = (v as { gitlab?: { target_branch?: unknown } } | null)?.gitlab?.target_branch
    } catch {
      /* unreadable settings deploy nothing */
    }
    if (target === ref.branch) out.push(`shared deployment ${s.key}`)
  }
  return [...new Set(out)]
}

// Task 11c (security review): approving a GitHub deployment (the github.workflow op
// `approve_deployment`) is a production-grade act — whoever approves the GitHub environment
// "production" deploys production. The engine therefore lets the op run ONLY inside a change
// carried by a running Hub promotion, and only for the GitHub environment that promotion's
// component maps to the Hub environment being promoted (deploy_job `approve[:<name>]`, no name =
// the Hub environment key). Every other change asking for it is refused before any provider call:
// ORIGIN_INVALID without a promotion, TARGET_MISMATCH for another GitHub environment.
import { db } from '../../../../db/index.js'
import { githubActionsMode } from '../../promote-providers.js'
import type { ChangeOrigin } from '../engine/contract.js'

export const APPROVE_ACTION = 'approve_deployment'

export interface ApprovalRefusal {
  code: 'ORIGIN_INVALID' | 'TARGET_MISMATCH'
  message: string
}

/**
 * Null when the approval may run; else why not. `resourceId` = the github.workflow row the op
 * writes; `environment` = the GitHub environment the desired resource names.
 */
export async function approvalRefusal(
  origin: ChangeOrigin | null | undefined,
  resourceId: number | null,
  environment: unknown
): Promise<ApprovalRefusal | null> {
  if (origin?.kind !== 'promotion')
    return {
      code: 'ORIGIN_INVALID',
      message: 'A GitHub deployment is approved only by a Hub promotion of that environment.'
    }
  const deploy = (await db('nivaro_hub_deploys')
    .where({ id: Number(origin.deployId) })
    .first('environment_id', 'status')) as { environment_id: number; status: string } | undefined
  const env = deploy
    ? ((await db('nivaro_hub_environments')
        .where({ id: Number(deploy.environment_id) })
        .first('key', 'placement_id')) as { key: string; placement_id: number | null } | undefined)
    : undefined
  if (!deploy || String(deploy.status) !== 'running' || !env?.placement_id || resourceId == null)
    return {
      code: 'ORIGIN_INVALID',
      message: 'The promotion this approval belongs to is not running.'
    }
  const rows = (await db('nivaro_hub_components')
    .where({
      placement_id: Number(env.placement_id),
      kind: 'github_actions',
      resource_id: resourceId
    })
    .select('deploy_job')) as Array<{ deploy_job: string | null }>
  const expected = rows
    .map((r) => githubActionsMode(r.deploy_job))
    .filter((m) => m.mode === 'approve')
    .map((m) => (m.mode === 'approve' ? (m.environment ?? env.key) : ''))
  const named = typeof environment === 'string' ? environment.trim().toLowerCase() : ''
  if (!named || !expected.some((e) => e.toLowerCase() === named))
    return {
      code: 'TARGET_MISMATCH',
      message: `This promotion of ${env.key} approves ${expected[0] ?? 'no GitHub environment'} only, not ${named || 'an unnamed environment'}.`
    }
  return null
}

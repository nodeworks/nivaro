import { db } from '../db/index.js'
import type { User } from '../types.js'
import type { ExportJob } from './export-handoff.js'
import type { ExportContext, ExportFile } from './export-runs.js'

/**
 * The export kinds a background job can run, rebuilt from its serializable job
 * (services/export-handoff.ts). Each kind's builder lives with its route and reads AS the person
 * — the same builder the synchronous answer runs — so nothing here decides access: it only
 * re-reads who the person is now.
 */

export interface ExportPrincipal {
  user: User
  isAdmin: boolean
}

/**
 * The person a job runs as, read again the way every request reads them (authenticate): an
 * active account whose role still lets them sign in; `isAdmin` from the role's admin access.
 * Null when they can no longer sign in — the job then fails instead of reading as nobody.
 *
 * Only jobs started from a person's own browser session are ever handed off (exportMayHandOff):
 * an API key's scopes / restrictions, an OAuth token's narrowing, run-as-key and View-as live
 * on the request's principal, which this cannot rebuild — those run where they started.
 */
export async function principalFor(userId: string): Promise<ExportPrincipal | null> {
  if (!userId) return null
  const row = (await db('nivaro_users').where({ id: userId, status: 'active' }).first()) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  // Never carry credential columns (static token, password hash, TOTP secret, IdP subject) into
  // a background build: the row as getUser answers it.
  const { withoutCredentials } = await import('./user-credentials.js')
  const user = withoutCredentials(row) as unknown as User
  const role = user.role
    ? ((await db('nivaro_roles').where({ id: user.role }).first()) as
        | { admin_access?: unknown; app_access?: unknown }
        | undefined)
    : null
  const { roleAllowsSignIn } = await import('../auth/role-sign-in.js')
  if (!roleAllowsSignIn(role, user as { account_kind?: string | null })) return null
  return { user, isAdmin: !!role?.admin_access }
}

/** Build the file a job describes, as `who`. */
export async function buildExportFromJob(
  job: ExportJob,
  who: ExportPrincipal,
  ctx: ExportContext
): Promise<ExportFile> {
  switch (job.kind) {
    case 'items': {
      const { itemsExportFromJob } = await import('../routes/items.js')
      return itemsExportFromJob(job, who, ctx)
    }
    case 'preset': {
      const { presetExportFromJob } = await import('../routes/export-presets.js')
      return presetExportFromJob(job, who, ctx)
    }
    case 'audit': {
      const { auditExportFromJob } = await import('../routes/reports.js')
      return auditExportFromJob(job, who, ctx)
    }
    default:
      throw new Error(`Unknown export kind: ${String((job as { kind?: unknown }).kind)}`)
  }
}

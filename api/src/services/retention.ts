import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { execCustomQuerySql } from './custom-query-exec.js'

export const DEFAULT_REDACT_FIELDS = [
  'first_name', 'last_name', 'email', 'external_id', 'job_title', 'avatar'
]

function parseJson<T>(val: unknown): T {
  if (!val) return [] as unknown as T
  if (typeof val === 'string') { try { return JSON.parse(val) as T } catch { return [] as unknown as T } }
  return val as T
}

export interface RetentionPolicy {
  id: number
  name: string
  inactivity_threshold_months: number
  action: 'redact' | 'delete' | 'suspend_only'
  redact_fields: unknown
  redact_value_template: string | null
  exclusion_emails: unknown
  exclusion_roles: unknown
  is_active: boolean
  dry_run_mode: boolean
}

export async function executeRetentionPolicy(
  policy: RetentionPolicy,
  triggeredBy: string | undefined,
  dryRun: boolean
): Promise<{ affectedCount: number; affectedIds: string[]; errors: string[] }> {
  const errors: string[] = []
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - policy.inactivity_threshold_months)

  const exclusionEmails: string[] = parseJson(policy.exclusion_emails)
  const exclusionRoles: string[] = parseJson(policy.exclusion_roles)
  const redactFields: string[] = (() => {
    const f: string[] = parseJson(policy.redact_fields)
    return f.length > 0 ? f : DEFAULT_REDACT_FIELDS
  })()
  const template = policy.redact_value_template ?? 'Redacted_{{id}}'

  // Who was active in the window — ONE scan of the activity log instead of a
  // correlated NOT EXISTS probe per user, which blew tedious' 15s request
  // timeout the first time a real policy ran against the multi-million-row
  // log. The scan itself rides the long-timeout executor (120s, same escape
  // hatch as heavy report procs).
  const activeRows = await execCustomQuerySql(
    'SELECT DISTINCT [user] AS uid FROM nivaro_activity WHERE [timestamp] >= :cutoff AND [user] IS NOT NULL',
    { cutoff }
  )
  const activeIds = new Set(activeRows.map((r) => String(r.uid).toUpperCase()))

  let query = db('nivaro_users').select('id', 'email').where('is_redacted', false)
  if (exclusionEmails.length > 0) query = query.whereNotIn('email', exclusionEmails)
  if (exclusionRoles.length > 0) query = query.whereNotIn('role', exclusionRoles)

  const allUsers: Array<{ id: string; email: string }> = await query
  const candidates = allUsers.filter((u) => !activeIds.has(String(u.id).toUpperCase()))
  const affectedIds = candidates.map((r) => r.id)

  if (dryRun || policy.dry_run_mode) {
    return { affectedCount: affectedIds.length, affectedIds: affectedIds.slice(0, 50), errors }
  }

  await db.transaction(async (trx) => {
    for (const user of candidates) {
      try {
        if (policy.action === 'delete') {
          await trx('nivaro_users').where({ id: user.id }).delete()
          continue
        }

        const updates: Record<string, unknown> = {
          is_redacted: true,
          redacted_at: new Date(),
          status: 'suspended'
        }

        if (policy.action !== 'suspend_only') {
          for (const field of redactFields) {
            if (field === 'email' || field === 'external_id') {
              updates[field] = template.replace('{{id}}', user.id)
            } else {
              updates[field] = 'Redacted'
            }
          }
        }

        await trx('nivaro_users').where({ id: user.id }).update(updates)
      } catch (err) {
        errors.push(`user ${user.id}: ${String(err)}`)
      }
    }
  })

  await db('nivaro_retention_policies').where({ id: policy.id }).update({
    last_run_at: new Date(),
    last_run_affected_count: affectedIds.length
  })

  await logActivity({
    action: 'user-retention-applied',
    user: triggeredBy,
    collection: 'nivaro_users',
    item: String(policy.id)
  } as Parameters<typeof logActivity>[0])

  return { affectedCount: affectedIds.length, affectedIds: affectedIds.slice(0, 50), errors }
}

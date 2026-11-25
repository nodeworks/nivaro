import { db } from '../../../db/index.js'

/**
 * Who the Hub's ops warnings go to, and how: through notifyUser (the person's channels and
 * rules), category `system`, an `external` target that opens the Hub page. Best-effort: a notice
 * that cannot be delivered never fails the collector.
 */

export interface OpsNotice {
  subject: string
  message: string
  /** In-app path the notice opens (`/hub/drivers?driver=3`). */
  path: string
  why: string
  source: { kind: string; label?: string; id?: string | number }
}

export type OpsNotifier = (userIds: string[], notice: OpsNotice) => Promise<number>

/** Active human administrators (at most 100). */
export async function hubAdminIds(): Promise<string[]> {
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where((w) => w.where('u.status', 'active').orWhereNull('u.status'))
    .where((w) => w.where('u.is_redacted', false).orWhereNull('u.is_redacted'))
    .whereNull('u.account_kind')
    .limit(100)
    .select('u.id')) as Array<{ id: string }>
  return rows.map((r) => String(r.id))
}

/** Owners of the given apps (distinct). */
export async function ownerIdsOfApps(appIds: number[]): Promise<string[]> {
  if (!appIds.length) return []
  const rows = (await db('nivaro_hub_app_owners')
    .whereIn('app_id', appIds)
    .distinct('user_id')) as Array<{ user_id: string }>
  return rows.map((r) => String(r.user_id))
}

/** Distinct ids, case-insensitively (SQL Server returns uuids upper-case). */
export function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const k = id.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(id)
  }
  return out
}

/** The default notifier: the Hub's one notice path (services/hub/notify-events.ts
 *  deliverHubNotice: notifyUser per person, once each); answers how many were handed over. */
export const notifyOps: OpsNotifier = async (userIds, notice) => {
  const { deliverHubNotice } = await import('../notify-events.js')
  return deliverHubNotice(uniqueIds(userIds), {
    subject: notice.subject,
    message: notice.message,
    path: notice.path,
    source: notice.source,
    why: notice.why
  })
}

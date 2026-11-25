/**
 * The ONE place the fleet jobs tell people anything (drift alerts, the monthly SLO report): app
 * owners and Hub administrators, through notifyUser. At merge time this can be pointed at the
 * Hub event notifier (notifyHubEvent) without touching the jobs.
 */

export type FleetNoteKind = 'drift' | 'slo_report'

export interface FleetNote {
  kind: FleetNoteKind
  subject: string
  message: string
  url: string
}

export type FleetNotifier = (userId: string, note: FleetNote) => Promise<void>

export const fleetNotify: FleetNotifier = async (userId, note) => {
  const { getApp } = await import('../../io-holder.js')
  const app = getApp()
  if (!app) return
  const { notifyUser } = await import('../../notification-channels.js')
  const report = note.kind === 'slo_report'
  await notifyUser(app, userId, {
    subject: note.subject.slice(0, 255),
    message: note.message.slice(0, 1000),
    category: report ? 'reports' : 'system',
    ...(report ? { channels: { inapp: true, email: true } } : {}),
    target: { kind: 'external', url: note.url, ...(report ? {} : { action: 'review' as const }) },
    source: report
      ? { kind: 'hub_slo_report', label: 'Monthly uptime report' }
      : { kind: 'hub_fleet', label: 'Hub fleet' },
    why: report
      ? 'You own this app (or administer this Hub); the Hub sends its uptime report on the 1st of every month.'
      : 'You own one of these apps or administer this Hub; a fleet alert rule (Apps → Fleet → Rules and targets) said so.'
  })
}

/** Active Hub administrators (people); throws when they cannot be read (callers retry later). */
export async function hubAdminIds(): Promise<string[]> {
  const { activeAdminIds } = await import('../../infra-drift/store.js')
  return activeAdminIds()
}

/** The fleet page link in a notification. */
export async function fleetUrl(): Promise<string> {
  const { adminBaseUrl } = await import('../../../admin-base.js')
  return `${adminBaseUrl() ?? ''}/hub/fleet`
}

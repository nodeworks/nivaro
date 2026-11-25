/**
 * The ONE place the fleet jobs tell people anything (drift alerts, the monthly SLO report): app
 * owners and Hub administrators, through the Hub's one notice path (notify-events.ts).
 */

export type FleetNoteKind = 'drift' | 'slo_report'

export interface FleetNote {
  kind: FleetNoteKind
  subject: string
  message: string
  url: string
}

export type FleetNotifier = (userId: string, note: FleetNote) => Promise<void>

/** Through the Hub's one notice path (services/hub/notify-events.ts deliverHubNotice: inbox,
 *  socket, browser and phone push, once per person); the jobs stay as they are. */
export const fleetNotify: FleetNotifier = async (userId, note) => {
  const { deliverHubNotice } = await import('../notify-events.js')
  const report = note.kind === 'slo_report'
  await deliverHubNotice([userId], {
    subject: note.subject,
    message: note.message,
    path: note.url,
    category: report ? 'reports' : 'system',
    ...(report ? { email: true } : { action: 'review' as const }),
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

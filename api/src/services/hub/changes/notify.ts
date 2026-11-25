import { deliverHubNotice, hubEventRecipients } from '../notify-events.js'
import type { ChecklistEntry, ChecklistRun } from './checklist.js'

/**
 * Tells the people who may tick it that an unattended start (a scheduled promotion, a release
 * train step) waits for its pre-deploy checklist — through THE Hub delivery (deliverHubNotice:
 * notifyUser, each person once, their notification rules). Hub admins and the app's owners,
 * plus anyone an item names. Best effort, never throws.
 */
export async function notifyChecklistOpened(
  run: ChecklistRun,
  entries: ChecklistEntry[]
): Promise<number> {
  try {
    const apps = [...new Set(entries.map((e) => e.app_id))]
    const people = new Set<string>()
    for (const appId of apps) for (const id of await hubEventRecipients(appId)) people.add(id)
    for (const e of entries)
      if (e.tick_by === 'people') for (const p of e.tick_people) people.add(p)
    const first = entries[0]
    const where = first ? `${first.app_key} · ${first.env_key}` : 'production'
    const what =
      run.action === 'move'
        ? 'A move'
        : run.action === 'upgrade'
          ? 'A shared deployment upgrade'
          : run.source === 'train'
            ? 'A release-train step'
            : 'A scheduled promotion'
    const required = entries.filter((e) => e.required).length
    return await deliverHubNotice([...people], {
      subject: `Pre-deploy checklist waiting: ${where}`,
      message: `${what} to ${run.version ?? 'production'} on ${where} waits for its pre-deploy checklist (${required} required). It starts once the required items are ticked.`,
      path: `/hub/changes?checklist=${run.id}`,
      source: { kind: 'hub', label: 'checklist', id: run.id },
      why: 'You are a Hub administrator, an owner of this app, or named on one of its checklist items.'
    })
  } catch {
    return 0
  }
}

import type { NotificationTargetSpec } from './notification-target.js'

/**
 * Urgent items (realtime round 9, item 14): a person who turned on Profile → Notifications →
 * "Play a sound for urgent items" (`preferences.urgent_sound`, off by default) hears one short
 * chime when urgent work lands on them. The server only says WHICH notifications are urgent
 * (`urgent: true` on the `notification:new` payload, the recipient's own room) and whether the
 * recipient is inside their quiet hours (`quiet: true`); the browser decides the rest (the
 * setting, Live updates Off, do not disturb, focus mode, one tab plays).
 *
 * Urgent, for a row that asks THIS person to act:
 *  - a critical row (critical subjects, SLA escalation),
 *  - an SLA breach waiting on their acknowledgement (target kind `sla`),
 *  - a caller that says so (`urgent: true` — e.g. an urgent task assigned to them, or an
 *    extension's priority record),
 *  - a record whose collection names an urgent flag (`browser_config.urgent_field`, a boolean
 *    field; Data Model → Settings → Collection Browser → "Urgent flag") and has it on.
 * Never an FYI.
 */

export type UrgentLane = 'critical' | 'needs_you' | 'fyi'

/** Pure: what the row alone says. `null` = not decided by the row (ask the record). */
export function urgentFromRow(row: {
  lane: UrgentLane
  category?: string | null
  target?: NotificationTargetSpec | null
  urgent?: boolean
}): boolean | null {
  if (row.lane === 'fyi') return false
  if (row.lane === 'critical') return true
  if (row.urgent === true) return true
  if (row.category === 'sla' && row.target?.kind === 'sla') return true
  return null
}

/** `browser_config.urgent_field` — a field name, or null (JSON text or an object). */
export function parseUrgentField(browserConfig: unknown): string | null {
  let bc: unknown = browserConfig
  if (typeof bc === 'string') {
    try {
      bc = JSON.parse(bc)
    } catch {
      return null
    }
  }
  if (!bc || typeof bc !== 'object' || Array.isArray(bc)) return null
  const f = (bc as Record<string, unknown>).urgent_field
  return typeof f === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(f) ? f : null
}

/** A stored flag value that reads as "on". */
export function flagIsOn(v: unknown): boolean {
  if (v === true || v === 1) return true
  if (typeof v === 'string') return ['1', 'true', 'yes', 'y'].includes(v.trim().toLowerCase())
  return false
}

/**
 * Is this record flagged urgent by its collection's urgent field? One cached metadata read and,
 * only when the collection names a flag, one single-column read of the record. Any failure =
 * not urgent (a chime is a courtesy, never a reason to fail a notification).
 */
export async function recordFlaggedUrgent(
  collection: string | null | undefined,
  item: string | number | null | undefined
): Promise<boolean> {
  if (!collection || item == null || /^nivaro_|^directus_|^__/i.test(collection)) return false
  try {
    const { getCollection, getFields } = await import('./collections.js')
    const meta = (await getCollection(collection)) as { browser_config?: unknown } | undefined
    const field = parseUrgentField(meta?.browser_config)
    if (!field) return false
    const fields = (await getFields(collection)) as Array<{ field: string }>
    if (!fields.some((f) => f.field === field)) return false
    const { db } = await import('../db/index.js')
    const row = (await db(collection).where({ id: item }).first(field)) as
      | Record<string, unknown>
      | undefined
    return flagIsOn(row?.[field])
  } catch {
    return false
  }
}

/** The whole decision for a row being written now. */
export async function notificationIsUrgent(row: {
  lane: UrgentLane
  category?: string | null
  target?: NotificationTargetSpec | null
  urgent?: boolean
  collection?: string | null
  item?: string | number | null
}): Promise<boolean> {
  const byRow = urgentFromRow(row)
  if (byRow != null) return byRow
  const collection = row.target?.kind === 'record' ? row.target.collection : row.collection
  const item = row.target?.kind === 'record' ? row.target.id : row.item
  return recordFlaggedUrgent(collection, item)
}

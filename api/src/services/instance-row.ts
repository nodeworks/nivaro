import { db } from '../db/index.js'
import { instanceKey } from './instance-key.js'

/**
 * One feature's key in this instance's `nivaro_settings_overrides` row (huddle media servers,
 * the outside-write watcher): the row keyed by instanceKey(), and only that row — on a Hub shared
 * deployment too (the deployment's NIVARO_INSTANCE, in the app's own database). A move to a
 * shared deployment carries the app's row across explicitly (services/move-carry.ts, at the
 * Hub's maintenance call), so nothing here guesses at another environment's row.
 */

export interface InstanceRow {
  id: number
  data: Record<string, unknown>
}

const TABLE = 'nivaro_settings_overrides'

export function parseInstanceData(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return obj && typeof obj === 'object' && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The row keyed `key` (this instance's by default), or null. */
export async function readInstanceRow(key: string = instanceKey()): Promise<InstanceRow | null> {
  const row = (await db(TABLE)
    .where({ instance_key: key })
    .orderBy('id', 'asc')
    .first('id', 'data')) as { id: number; data?: unknown } | undefined
  return row ? { id: row.id, data: parseInstanceData(row.data) } : null
}

/** This instance's row and its value for `key` (undefined = none saved). */
export async function instanceValue(
  key: string
): Promise<{ row: InstanceRow | null; value: unknown }> {
  const row = await readInstanceRow()
  return { row, value: row?.data[key] }
}

/** Write `value` under `key` in this instance's own row (created when missing). */
export async function saveInstanceValue(
  row: InstanceRow | null,
  key: string,
  value: unknown
): Promise<void> {
  const data = { ...(row?.data ?? {}), [key]: value }
  if (row)
    await db(TABLE)
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  else
    await db(TABLE).insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
}

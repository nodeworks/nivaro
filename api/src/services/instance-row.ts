import { db } from '../db/index.js'
import { perAppJobs } from './deployment-mode.js'
import { instanceKey } from './instance-key.js'

/**
 * One feature's key in this instance's `nivaro_settings_overrides` row (huddle media servers,
 * the outside-write watcher). Self-hosted and Nivaro Cloud: the row keyed by instanceKey(),
 * exactly as before.
 *
 * Hub shared deployment: instanceKey() is the deployment's own, never the instance name the app
 * ran under on its own stack (a stack the Hub made sets NIVARO_INSTANCE to its stack name), so a
 * moved app keeps its saved value in another row of its own database. When the deployment's row
 * has no value for the key, the value of the ONE other row that has it is used; several rows with
 * it (two environments sharing one database) is ambiguous and none is used. A save always writes
 * the deployment's row, so after the first save there that row wins.
 */

export interface InstanceRow {
  id: number
  data: Record<string, unknown>
}

const TABLE = 'nivaro_settings_overrides'
/** Rows read on a shared deployment: one per instance that ever used the database. */
const MAX_ROWS = 50

function parse(raw: unknown): Record<string, unknown> {
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

/** Pick the value of `key` (pure): this instance's row first, else the one other row with it. */
export function pickInstanceValue(
  rows: Array<{ id: number; instance_key: string; data: Record<string, unknown> }>,
  own: string,
  key: string,
  fallback: boolean
): { row: InstanceRow | null; value: unknown; from: 'own' | 'other' | 'none' } {
  const mine = rows.find((r) => r.instance_key === own) ?? null
  const row = mine ? { id: mine.id, data: mine.data } : null
  if (mine && Object.hasOwn(mine.data, key)) return { row, value: mine.data[key], from: 'own' }
  if (!fallback) return { row, value: undefined, from: 'none' }
  const others = rows.filter((r) => r !== mine && Object.hasOwn(r.data, key))
  return others.length === 1
    ? { row, value: others[0].data[key], from: 'other' }
    : { row, value: undefined, from: 'none' }
}

/** This instance's row and the value it uses for `key` (undefined = none saved). */
export async function instanceValue(
  key: string
): Promise<{ row: InstanceRow | null; value: unknown }> {
  const shared = perAppJobs()
  const q = db(TABLE).select('id', 'instance_key', 'data')
  if (!shared) q.where({ instance_key: instanceKey() })
  const raw = (await q.limit(MAX_ROWS)) as Array<{
    id: number
    instance_key: string | null
    data?: unknown
  }>
  const rows = raw.map((r) => ({
    id: r.id,
    instance_key: String(r.instance_key ?? ''),
    data: parse(r.data)
  }))
  const { row, value } = pickInstanceValue(rows, instanceKey(), key, shared)
  return { row, value }
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

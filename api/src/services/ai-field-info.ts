import { db } from '../db/index.js'
import type { DateKind } from './ai-export-table.js'
import { hasNaiveDate, localizeRawFilter } from './ai-local-dates.js'
import { planConditionPath } from './items.js'

/**
 * What Ask AI needs to know about a field beyond its name: the label people
 * see and, for a date column, whether it holds a moment in time or a date
 * kept as written. Read from the registry and the table itself, through the
 * same path planner the filters use, so `project.created` resolves to the
 * `created` column of the collection `project` points at.
 */

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface FieldInfo {
  label: string | null
  kind: DateKind | null
}

interface TableInfo {
  labels: Map<string, string>
  kinds: Map<string, DateKind>
}

const NONE: FieldInfo = { label: null, kind: null }

/**
 * instant = the column keeps an offset, or the server stamps it (created /
 * updated) — both are UTC moments. Any other date-time column is a clock time
 * stored as it was typed (a required-by date at midnight), which must never
 * be shifted by a time zone.
 */
async function loadTableInfo(table: string): Promise<TableInfo> {
  const [columns, fields] = await Promise.all([
    db('information_schema.columns')
      .where({ table_name: table })
      .select('column_name', 'data_type')
      .catch(() => []) as Promise<Array<{ column_name: string; data_type: string }>>,
    db('nivaro_fields')
      .where({ collection: table })
      .select('field', 'label', 'special')
      .catch(() => []) as Promise<Array<{ field: string; label: string | null; special: unknown }>>
  ])
  const stamped = new Set<string>()
  const labels = new Map<string, string>()
  for (const f of fields) {
    if (typeof f.label === 'string' && f.label.trim()) labels.set(f.field, f.label.trim())
    if (/date-(created|updated)/.test(String(f.special ?? ''))) stamped.add(f.field)
  }
  const kinds = new Map<string, DateKind>()
  for (const c of columns) {
    const type = String(c.data_type).toLowerCase()
    if (type === 'date') kinds.set(c.column_name, 'date')
    else if (type === 'datetimeoffset') kinds.set(c.column_name, 'instant')
    else if (type === 'datetime2' || type === 'datetime' || type === 'smalldatetime')
      kinds.set(c.column_name, stamped.has(c.column_name) ? 'instant' : 'naive')
  }
  return { labels, kinds }
}

/** A lookup for one collection's fields by path; each table is read once per resolver. */
export function fieldInfoResolver(collection: string): (path: string[]) => Promise<FieldInfo> {
  const tables = new Map<string, Promise<TableInfo>>()
  const table = (name: string) => {
    let t = tables.get(name)
    if (!t) {
      t = loadTableInfo(name)
      tables.set(name, t)
    }
    return t
  }
  return async (path) => {
    if (path.length === 0 || path.some((s) => !SEGMENT.test(s))) return NONE
    let leafTable = collection
    let leafCol = path[0]
    if (path.length > 1) {
      const plan = await planConditionPath(collection, path).catch(() => null)
      if (!plan) return NONE
      leafTable = plan.leafTable
      leafCol = plan.leafCol
    }
    const info = await table(leafTable)
    return { label: info.labels.get(leafCol) ?? null, kind: info.kinds.get(leafCol) ?? null }
  }
}

/**
 * A model-written filter with "today" meaning the asker's own day: zone-less
 * dates on timestamp columns are read in their time zone (profile setting,
 * else the instance's business time zone). A filter with no such date is
 * returned untouched without a single lookup.
 */
export async function localizeFilterDates(
  user: { preferences?: unknown } | null,
  collection: string,
  raw: unknown
): Promise<unknown> {
  if (!hasNaiveDate(raw)) return raw
  const { userTimeZone } = await import('./user-time.js')
  const zone = await userTimeZone(user)
  const info = fieldInfoResolver(collection)
  return localizeRawFilter(raw, zone, async (path) => (await info(path)).kind === 'instant')
}

import { db } from '../db/index.js'
import { whereInList } from './db-batch.js'
import { isSystemCollection } from './system-collections.js'

/**
 * Catalog related columns counted for EVERYONE alike (army 11 a2 F3, Rob).
 *
 * A record form's catalog grid shows per-item figures looked up in another
 * collection (`options.catalog_mode.related_columns`). The browser reads them
 * as the viewer, so a figure summed over many records — "Open Orders" over
 * every open inventory request — was narrowed by the viewer's User Scope: the
 * creator saw 1,354 where the warehouse approver of the same request saw 6.
 *
 * An administrator can mark such a column `count_all: true`. Its sum is then
 * computed here, over every matching row whatever the viewer may read, and
 * ONLY the per-item number comes back — never rows, ids of other records or
 * any other field. The column (collection, fields, filter) is read from the
 * layout the caller's record resolves to, never from the request. The
 * `$parent.<field>` values come from the saved record read AS THE CALLER, or —
 * on a new form — only values the caller can read (army 11 review: a probe for
 * other zones' counts through forged parent values). See routes/catalog-related.ts.
 */

export interface CountAllColumn {
  key: string
  collection: string
  item_field: string
  value_field: string
  aggregate: 'sum' | 'count'
  match: Record<string, unknown>
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
export const COUNT_ALL_MAX_IDS = 500

function parseJson(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'object') return v
  try {
    return JSON.parse(String(v))
  } catch {
    return null
  }
}

/** The `count_all` column `key` among one assignment's overrides, if any. */
export function countAllColumnIn(overrides: unknown, key: string): CountAllColumn | null {
  const o = parseJson(overrides) as { options?: Record<string, unknown> } | null
  const opts = o?.options ?? {}
  const lists = [
    (opts.catalog_mode as { related_columns?: unknown } | undefined)?.related_columns,
    opts.related_columns
  ]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const rc = raw as Record<string, unknown> | null
      if (!rc || rc.key !== key || rc.count_all !== true) continue
      const aggregate = rc.aggregate === 'count' ? 'count' : rc.aggregate === 'sum' ? 'sum' : null
      if (!aggregate) continue
      const collection = String(rc.collection ?? '')
      const itemField = String(rc.item_field ?? '')
      const valueField = String(rc.value_field ?? '')
      if (![collection, itemField].every((s) => IDENT.test(s))) continue
      if (aggregate === 'sum' && !IDENT.test(valueField)) continue
      return {
        key,
        collection,
        item_field: itemField,
        value_field: valueField,
        aggregate,
        match:
          rc.match && typeof rc.match === 'object' && !Array.isArray(rc.match)
            ? (rc.match as Record<string, unknown>)
            : {}
      }
    }
  }
  return null
}

/** The `$parent.<field>` names a filter uses. */
export function parentTokens(match: unknown, out = new Set<string>()): Set<string> {
  if (typeof match === 'string' && match.startsWith('$parent.')) out.add(match.slice(8))
  else if (Array.isArray(match)) for (const v of match) parentTokens(v, out)
  else if (match && typeof match === 'object')
    for (const v of Object.values(match)) parentTokens(v, out)
  return out
}

/**
 * The stored filter with `$parent.<field>` filled from `parent` — the client
 * twin is CatalogPickerField `resolveRelatedMatch`: a top-level token is an
 * equality, a nested one is substituted in place; a token with no value means
 * no figure yet (null). Only scalar values are taken.
 */
export function resolveCountAllMatch(
  match: Record<string, unknown>,
  parent: Record<string, unknown>
): Record<string, unknown> | null {
  let missing = false
  const value = (token: string): unknown => {
    const v = parent[token.slice(8)]
    if (v === null || v === undefined || v === '') {
      missing = true
      return null
    }
    if (!['string', 'number', 'boolean'].includes(typeof v)) {
      missing = true
      return null
    }
    return v
  }
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('$parent.')) return value(v)
    if (Array.isArray(v)) return v.map(deep)
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
    return v
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(match)) {
    if (typeof v === 'string' && v.startsWith('$parent.')) out[k] = { _eq: value(v) }
    else if (v && typeof v === 'object') out[k] = deep(v)
    else out[k] = { _eq: v }
  }
  return missing ? null : out
}

/** The `count_all` column `key` on assignment `field` of one of `layoutIds` (the
 *  layouts the caller's record actually resolves to — never an inactive or
 *  other-role form). */
export async function findCountAllColumn(
  layoutIds: number[],
  field: string,
  key: string
): Promise<CountAllColumn | null> {
  if (layoutIds.length === 0) return null
  const rows = (await db('nivaro_layout_field_assignments')
    .whereIn('layout_id', layoutIds)
    .where('field', field)
    .whereRaw("overrides LIKE '%count_all%'")
    .select('overrides')) as Array<{ overrides: unknown }>
  for (const r of rows) {
    const col = countAllColumnIn(r.overrides, key)
    if (col) return col
  }
  return null
}

/** A stored value as a plain id (an expanded relation answers `{id}`). */
export function scalarOf(v: unknown): unknown {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as { id?: unknown }).id : v
}

/** Per item: the sum (or row count) over every row the stored filter matches. */
export async function countAllFigures(
  col: CountAllColumn,
  filter: Record<string, unknown>,
  ids: Array<string | number>,
  compile: (q: unknown, filter: Record<string, unknown>, collection: string) => Promise<void>
): Promise<Record<string, number>> {
  if (isSystemCollection(col.collection) || col.collection.startsWith('nivaro_')) return {}
  const wanted = [...new Set(ids.map(String))].slice(0, COUNT_ALL_MAX_IDS)
  if (wanted.length === 0) return {}
  const q = db(col.collection)
    .select(db.raw('?? as item', [col.item_field]))
    .groupBy(col.item_field)
  if (col.aggregate === 'sum') q.select(db.raw('SUM(??) as total', [col.value_field]))
  else q.select(db.raw('COUNT(*) as total'))
  whereInList(q, col.item_field, wanted)
  if (Object.keys(filter).length > 0) await compile(q, filter, col.collection)
  const rows = (await q) as Array<{ item: unknown; total: unknown }>
  const out: Record<string, number> = {}
  for (const r of rows) {
    if (r.item == null) continue
    const n = Number(r.total)
    out[String(r.item)] = Number.isFinite(n) ? n : 0
  }
  return out
}

import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { sqlDialect } from '../db/sql-dialect.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * A boolean column filtered with TEXT — `filter[flag][_eq]=true` arrives from a query string as
 * the string 'true'. SQL Server converts 'true' / 'false' to bit and Postgres casts the literal to
 * boolean, so both answered; MySQL / MariaDB compare the text as the number 0 and SQLite compares
 * text with an integer, so they matched nothing. On those three databases the items filter
 * compiler turns 'true' / 'false' / '1' / '0' (any case) into a real boolean before binding, for
 * `_eq` / `_neq` / `_in` / `_nin` and the bare `{flag: 'true'}` shorthand, when the column is a
 * boolean: TINYINT(1) on MySQL / MariaDB, declared boolean on SQLite, or registered with type
 * 'boolean'. SQL Server and Postgres are never touched (their answers stay exactly as they were).
 *
 * The compiler is synchronous, so the set is primed beside the virtual-field prime
 * (items.ts primeVirtualSql) and peeked here.
 */

const TTL_MS = 30_000
const cache = new Map<string, { at: number; cols: Set<string> }>()

function needed(): boolean {
  const d = sqlDialect(db)
  return d === 'mysql' || d === 'sqlite'
}

const keyOf = (collection: string) => `${currentTenantKey()}\u0000${collection}`

/** Read (at most once per 30 s) which columns of `collection` are booleans. Never throws. */
export async function primeBooleanColumns(collection: string): Promise<void> {
  if (!needed()) return
  const key = keyOf(collection)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return
  const cols = new Set<string>()
  try {
    const physical =
      sqlDialect(db) === 'sqlite'
        ? rawRows<{ name: string }>(
            await db.raw(
              `SELECT name AS name FROM pragma_table_info(?) WHERE lower(type) IN ('boolean', 'bool')`,
              [collection]
            )
          )
        : rawRows<{ name: string }>(
            await db.raw(
              `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
                  AND DATA_TYPE = 'tinyint' AND COLUMN_TYPE LIKE 'tinyint(1)%'`,
              [collection]
            )
          )
    for (const r of physical) cols.add(String(r.name).toLowerCase())
    const registered = (await db('nivaro_fields')
      .where({ collection, type: 'boolean' })
      .select('field')) as Array<{ field: string }>
    for (const r of registered) cols.add(String(r.field).toLowerCase())
  } catch {
    // A failed read leaves the values as sent (the old behaviour).
  }
  if (cache.size >= 2000) cache.clear()
  cache.set(key, { at: Date.now(), cols })
}

/** True when the primed set says `key` (bare or `collection.column`) is a boolean column. */
export function isBooleanColumn(collection: string | null, key: string): boolean {
  if (!collection || !needed()) return false
  const entry = cache.get(keyOf(collection))
  if (!entry || entry.cols.size === 0) return false
  const bare = key.startsWith(`${collection}.`) ? key.slice(collection.length + 1) : key
  return entry.cols.has(bare.toLowerCase())
}

/** 'true' / 'false' / '1' / '0' (any case, trimmed) and 1 / 0 → a boolean; anything else as is. */
export function coerceBooleanValue(v: unknown): unknown {
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : v
  if (typeof v !== 'string') return v
  const s = v.trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return v
}

/** The filter value for `op` on a boolean column: scalars for _eq/_neq, every element for _in/_nin. */
export function coerceBooleanFilter(op: string, val: unknown): unknown {
  if (op === '_eq' || op === '_neq') return coerceBooleanValue(val)
  // The bracket form already splits a list (lib/bracket-filter.ts).
  if ((op === '_in' || op === '_nin') && Array.isArray(val)) return val.map(coerceBooleanValue)
  return val
}

/**
 * Rows a raw statement read from `collection` with its boolean columns as true/false. MySQL /
 * MariaDB hand a TINYINT(1) back as a boolean only when the result column keeps that type; a
 * recursive CTE or a UNION reports it as a plain TINYINT, so 0 / 1 came back where SQL Server and
 * Postgres answer false / true. A no-op on SQL Server and Postgres. Never throws.
 */
export async function withBooleanColumns<T extends Record<string, unknown>>(
  collection: string,
  rows: T[]
): Promise<T[]> {
  if (!needed() || rows.length === 0) return rows
  await primeBooleanColumns(collection)
  const cols = cache.get(keyOf(collection))?.cols
  if (!cols || cols.size === 0) return rows
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      const v = row[k]
      if ((v === 0 || v === 1) && cols.has(k.toLowerCase()))
        (row as Record<string, unknown>)[k] = v === 1
    }
  }
  return rows
}

/** Tests: forget every primed set. */
export function clearBooleanColumnCache(): void {
  cache.clear()
}

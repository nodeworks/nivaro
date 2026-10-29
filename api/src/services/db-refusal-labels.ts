import { db } from '../db/index.js'
import {
  type DbRefusalDetail,
  describeDbRefusal,
  describeValueRefusal,
  messageWithoutSql,
  refusalDetail
} from '../lib/db-refusal.js'
import { humanCollection, fieldLabel as humanField } from './access-words.js'
import { getCollection, getFields } from './collections.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * A database refusal (duplicate key, missing link, NOT NULL, too long) told in
 * the collection's own field labels: "Another record already has this PO
 * number (4471)" instead of "A record with these values already exists
 * (UX_po_number)". The constraint, table and column names never leave the
 * server; when a field cannot be named the generic answer stands (null).
 *
 * `context: 'import'` words it for a file row ("Warehouse 'X' doesn't exist —
 * check the spelling or add it first").
 */
export interface LabelledRefusal {
  message: string
  hint: string
  fields: string[]
}

type Context = 'record' | 'import'

/** Constraint → its columns (and, for a foreign key, the table that holds them). */
const columnCache = new Map<string, { table: string | null; columns: string[] }>()
const CACHE_MAX = 500
const LOOKUP_TIMEOUT_MS = 1500

async function inTime<T>(p: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS)
  })
  try {
    return await Promise.race([p.catch(() => null), late])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function rowsOf(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

async function lookupConstraint(
  detail: DbRefusalDetail
): Promise<{ table: string | null; columns: string[] }> {
  const name = detail.constraint
  if (!name) return { table: null, columns: [] }
  const key = `${currentTenantKey()}|${detail.kind}|${detail.table ?? ''}|${name}`
  const hit = columnCache.get(key)
  if (hit) return hit
  let found: { table: string | null; columns: string[] } | null = null
  if (detail.kind === 'fk_missing') {
    const rows = rowsOf(
      await inTime(
        db.raw(
          `SELECT OBJECT_NAME(fk.parent_object_id) AS tbl,
                  COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS col
             FROM sys.foreign_keys fk
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            WHERE fk.name = ?
            ORDER BY fkc.constraint_column_id`,
          [name]
        )
      )
    )
    if (rows.length)
      found = {
        table: rows[0].tbl == null ? null : String(rows[0].tbl),
        columns: rows.map((r) => String(r.col ?? '')).filter(Boolean)
      }
  } else if (detail.kind === 'duplicate' && detail.table) {
    const rows = rowsOf(
      await inTime(
        db.raw(
          `SELECT COL_NAME(ic.object_id, ic.column_id) AS col
             FROM sys.indexes i
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            WHERE i.name = ? AND i.object_id = OBJECT_ID(?) AND ic.is_included_column = 0
            ORDER BY ic.key_ordinal`,
          [name, detail.table]
        )
      )
    )
    if (rows.length)
      found = {
        table: detail.table,
        columns: rows.map((r) => String(r.col ?? '')).filter(Boolean)
      }
  }
  if (!found) return { table: null, columns: [] } // not remembered: a timeout may pass
  if (columnCache.size >= CACHE_MAX) columnCache.clear()
  columnCache.set(key, found)
  return found
}

/** column → {field key, label} for a collection; empty when it is not one. */
async function fieldsByColumn(
  collection: string | null | undefined
): Promise<Map<string, { field: string; label: string }>> {
  const map = new Map<string, { field: string; label: string }>()
  if (!collection) return map
  const fields = (await inTime(getFields(collection))) ?? []
  for (const f of fields) {
    const own = (f as { label?: unknown }).label
    const label = typeof own === 'string' && own.trim() ? own.trim() : humanField(f.field)
    map.set(String(f.db_column || f.field).toLowerCase(), { field: f.field, label })
  }
  return map
}

async function collectionWords(table: string | undefined): Promise<string> {
  if (!table) return 'Other records'
  const col = await inTime(getCollection(table))
  const words = humanCollection(table, col?.plural || col?.display_name || null)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function shownValue(v: unknown): string | null {
  if (v == null || typeof v === 'object') return null
  const s = String(v).trim()
  return s && s.length <= 80 ? s : null
}

const joinLabels = (labels: string[]): string =>
  labels.length <= 1
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`

/**
 * The refusal in field labels, or null when the field cannot be named (the
 * caller keeps the generic sentence and the code's own hint).
 */
export async function labelDbRefusal(
  detail: DbRefusalDetail,
  opts: {
    collection?: string | null
    values?: Record<string, unknown> | null
    context?: Context
  } = {}
): Promise<LabelledRefusal | null> {
  const context: Context = opts.context ?? 'record'
  const values = opts.values ?? {}

  if (detail.kind === 'fk_in_use') {
    const others = await collectionWords(detail.table)
    const lower = others.toLowerCase()
    return {
      message: `${others} still link to this record`,
      hint: `Remove or re-link those ${lower} first, then delete this record again.`,
      fields: []
    }
  }

  let table: string | null = null
  let columns: string[] = []
  if (detail.kind === 'fk_missing' || detail.kind === 'duplicate') {
    const found = await lookupConstraint(detail)
    columns = found.columns
    table = found.table ?? (detail.kind === 'duplicate' ? (detail.table ?? null) : null)
  } else if (detail.column) {
    columns = [detail.column]
    table = detail.table ?? null
  }
  if (columns.length === 0) return null
  // The table the database named is the collection whose field it is (a
  // nested line's own collection, not the parent's); the route's collection
  // is the fallback.
  let byColumn = await fieldsByColumn(table)
  if (byColumn.size === 0 && opts.collection) byColumn = await fieldsByColumn(opts.collection)
  const named = columns.map((c) => {
    const hit = byColumn.get(c.toLowerCase())
    return { field: hit?.field ?? c, label: hit?.label ?? humanField(c) }
  })
  const fields = named.map((n) => n.field)
  const label = joinLabels(named.map((n) => n.label))
  const value = named.length === 1 ? shownValue(values[named[0].field]) : null

  switch (detail.kind) {
    case 'fk_missing':
      return context === 'import'
        ? {
            message: value
              ? `${label} '${value}' doesn't exist — check the spelling or add it first`
              : `${label} points at a record that doesn't exist — check the value or add that record first`,
            hint: `Check the ${label} value in the file, or add that record first.`,
            fields
          }
        : {
            message: `The ${label} you picked no longer exists`,
            hint: `Pick ${label} again from the list, then save.`,
            fields
          }
    case 'duplicate': {
      const dup = value ?? (named.length === 1 ? shownValue(detail.value) : null)
      return context === 'import'
        ? {
            message: `Another record already has ${label}${dup ? ` '${dup}'` : ' with this value'} — change it in the file, or import with Overwrite`,
            hint: 'Change the value in the file, or import with Overwrite for duplicates.',
            fields
          }
        : {
            message:
              named.length === 1
                ? `Another record already has this ${label}${dup ? ` (${dup})` : ''}`
                : `Another record already has the same ${label}`,
            hint: `Use a different ${label}, or open the existing record instead.`,
            fields
          }
    }
    case 'not_null':
      return context === 'import'
        ? {
            message: `${label} is empty — fill it in the file or map a column to it`,
            hint: `Fill in ${label} in the file, or map a column to it.`,
            fields
          }
        : { message: `${label} is required`, hint: `Fill in ${label}, then save again.`, fields }
    case 'too_long':
      return context === 'import'
        ? {
            message: `${label} is too long — shorten it in the file`,
            hint: `Shorten ${label} in the file.`,
            fields
          }
        : { message: `${label} is too long`, hint: `Shorten ${label}, then save again.`, fields }
    default:
      return null
  }
}

/**
 * One import row's failure as a plain sentence: a database refusal in field
 * labels with the file's own value ("Warehouse 'X' doesn't exist — check the
 * spelling or add it first"), else the refusal's reason without the statement.
 */
export async function importRowErrorText(
  err: unknown,
  collection: string,
  values: Record<string, unknown>
): Promise<string> {
  const detail = refusalDetail(err)
  if (detail) {
    const labelled = await labelDbRefusal(detail, { collection, values, context: 'import' }).catch(
      () => null
    )
    if (labelled) return labelled.message
  }
  const known = describeDbRefusal(err) ?? describeValueRefusal(err)
  if (known) return known.message
  return messageWithoutSql(err)
}

/** Tests only. */
export function _resetRefusalLabelCache(): void {
  columnCache.clear()
}

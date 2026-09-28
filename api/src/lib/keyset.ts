/**
 * Keyset pagination: "the rows after this one" instead of "skip N rows".
 *
 * A reader walking a large collection with OFFSET pays for every row it
 * skips, and rows written while it walks shift the pages under it (a row is
 * seen twice or never). A cursor names the LAST ROW of the page just read —
 * its sort values and its id — and the next page is every row that sorts
 * after it. Cost is independent of how far in the walk is, and a write
 * elsewhere in the collection moves nothing.
 *
 * The cursor is opaque and signed: it carries the collection, the sort it was
 * made for and the values, and a caller cannot craft one to read from a place
 * the sort would not have reached.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface KeysetSort {
  column: string
  desc: boolean
}

export interface KeysetRefusal extends Error {
  statusCode: number
  code: string
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
export const CURSOR_START = 'start'

function refuse(code: string, message: string): KeysetRefusal {
  return Object.assign(new Error(message), { statusCode: 400, code }) as KeysetRefusal
}

/** The sort a cursor walks: the caller's columns, then `id` so no two rows tie. */
export function keysetSorts(sort: string[] | undefined): KeysetSort[] {
  const out: KeysetSort[] = []
  for (const s of sort ?? []) {
    const desc = s.startsWith('-')
    const column = desc ? s.slice(1) : s
    if (!column) continue
    if (column.includes('.')) {
      throw refuse(
        'CURSOR_SORT_UNSUPPORTED',
        `A cursor walks the record's own fields; "${column}" sorts by a linked record`
      )
    }
    if (!IDENT.test(column)) {
      throw refuse('CURSOR_SORT_UNSUPPORTED', `"${column}" cannot be sorted with a cursor`)
    }
    if (out.some((o) => o.column.toLowerCase() === column.toLowerCase())) continue
    out.push({ column, desc })
  }
  if (!out.some((o) => o.column.toLowerCase() === 'id')) out.push({ column: 'id', desc: false })
  return out
}

const sortKey = (sorts: KeysetSort[]) =>
  sorts.map((s) => `${s.desc ? '-' : ''}${s.column.toLowerCase()}`).join(',')

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22)
}

function pack(v: unknown): unknown {
  if (v === undefined || v === null) return null
  if (v instanceof Date) return { $d: v.toISOString() }
  if (typeof v === 'bigint') return v.toString()
  if (Buffer.isBuffer(v)) return { $b: v.toString('base64') }
  return v
}

function unpack(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.$d === 'string') return new Date(o.$d)
    if (typeof o.$b === 'string') return Buffer.from(o.$b, 'base64')
    throw refuse('CURSOR_INVALID', 'The cursor is not valid')
  }
  return v
}

export function encodeCursor(
  collection: string,
  sorts: KeysetSort[],
  values: unknown[],
  secret: string
): string {
  const body = Buffer.from(
    JSON.stringify({ c: collection, s: sortKey(sorts), v: values.map(pack) })
  ).toString('base64url')
  return `${body}.${sign(body, secret)}`
}

/** The values a cursor carries, or null for the start of a walk. */
export function decodeCursor(
  cursor: string,
  collection: string,
  sorts: KeysetSort[],
  secret: string
): unknown[] | null {
  if (cursor === '' || cursor === CURSOR_START) return null
  const dot = cursor.lastIndexOf('.')
  if (dot <= 0) throw refuse('CURSOR_INVALID', 'The cursor is not valid')
  const body = cursor.slice(0, dot)
  const given = Buffer.from(cursor.slice(dot + 1))
  const expected = Buffer.from(sign(body, secret))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw refuse('CURSOR_INVALID', 'The cursor is not valid')
  }
  let parsed: { c?: unknown; s?: unknown; v?: unknown }
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw refuse('CURSOR_INVALID', 'The cursor is not valid')
  }
  if (parsed.c !== collection) {
    throw refuse('CURSOR_MISMATCH', 'The cursor was made for another collection')
  }
  if (parsed.s !== sortKey(sorts)) {
    throw refuse(
      'CURSOR_MISMATCH',
      `The cursor was made for sort "${String(parsed.s)}"; this request sorts by "${sortKey(sorts)}"`
    )
  }
  if (!Array.isArray(parsed.v) || parsed.v.length !== sorts.length) {
    throw refuse('CURSOR_INVALID', 'The cursor is not valid')
  }
  return parsed.v.map(unpack)
}

/** One comparison of the "rows after" predicate, as data a query builder applies. */
export type KeysetTerm =
  | { column: number; test: 'eq' | 'gt' | 'lt' | 'null' | 'not_null' | 'lt_or_null' | 'gt_or_null' }
  | { column: number; test: 'never' }

/**
 * Rows after (v1, …, vn) under the sort: OR over i of
 *   (col1 = v1 AND … AND col[i-1] = v[i-1] AND col[i] is after v[i]).
 *
 * `nullsFirst` = where NULL sits in ascending order (first on SQL Server and
 * MySQL, last on Postgres).
 */
export function keysetBranches(
  sorts: KeysetSort[],
  values: unknown[],
  nullsFirst = true
): KeysetTerm[][] {
  const branches: KeysetTerm[][] = []
  for (let i = 0; i < sorts.length; i++) {
    const terms: KeysetTerm[] = []
    for (let j = 0; j < i; j++) {
      terms.push({ column: j, test: values[j] === null ? 'null' : 'eq' })
    }
    const isNull = values[i] === null
    // Does NULL come before every value in this column's direction?
    const nullLeads = sorts[i].desc ? !nullsFirst : nullsFirst
    if (isNull) {
      // After a NULL: everything with a value when NULLs lead, nothing when they trail.
      terms.push(nullLeads ? { column: i, test: 'not_null' } : { column: i, test: 'never' })
    } else if (sorts[i].desc) {
      terms.push({ column: i, test: nullLeads ? 'lt' : 'lt_or_null' })
    } else {
      terms.push({ column: i, test: nullLeads ? 'gt' : 'gt_or_null' })
    }
    if (!terms.some((t) => t.test === 'never')) branches.push(terms)
  }
  return branches
}

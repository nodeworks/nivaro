/**
 * Grouped aggregates over a collection: count / sum / avg / min / max, with an
 * optional group-by.
 *
 * The rows counted are decided by the SAME gated query a list read builds —
 * filter, search, workspace, the role's row filter, user scopes — handed in
 * by readItems. This module only adds the SELECT and GROUP BY on top, so an
 * aggregate can never describe rows its caller could not list.
 */
import type { Knex } from 'knex'
import { db, isMssql } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'

export const AGGREGATE_FUNCTIONS = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'] as const
export type AggregateFunction = (typeof AGGREGATE_FUNCTIONS)[number]

export interface AggregateSpec {
  groupBy?: string[]
  countAll?: boolean
  count?: string[]
  countDistinct?: string[]
  sum?: string[]
  avg?: string[]
  min?: string[]
  max?: string[]
  /** Group columns, `countAll`, or `<function>.<field>`; `-` first = descending. */
  sort?: string[]
  limit?: number
  offset?: number
}

export interface AggregateRow {
  group: Record<string, unknown>
  countAll?: number
  count?: Record<string, number>
  countDistinct?: Record<string, number>
  sum?: Record<string, number | null>
  avg?: Record<string, number | null>
  min?: Record<string, unknown>
  max?: Record<string, unknown>
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const NUMERIC = new Set([
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'decimal',
  'numeric',
  'float',
  'real',
  'money',
  'smallmoney',
  'integer',
  'double precision',
  'double'
])
const WHOLE = new Set(['int', 'smallint', 'tinyint', 'integer'])
// Types that cannot be compared or grouped.
const OPAQUE = new Set(['text', 'ntext', 'image', 'xml', 'geography', 'geometry', 'json', 'jsonb'])
const MAX_GROUP_BY = 4
const MAX_AGGREGATES = 24
const MAX_GROUPS = 1000

function refuse(code: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { statusCode: 400, code, ...extra })
}

const typeCache = new Map<
  string,
  { at: number; types: Map<string, { name: string; type: string; long: boolean }> }
>()

async function columnTypes(collection: string) {
  const hit = typeCache.get(collection)
  if (hit && Date.now() - hit.at < 60_000) return hit.types
  const rows = rawRows<{ c: string; t: string; l: number | null }>(
    await db.raw(
      `SELECT COLUMN_NAME AS c, DATA_TYPE AS t, CHARACTER_MAXIMUM_LENGTH AS l
         FROM information_schema.columns
        WHERE table_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
      [collection]
    )
  )
  const types = new Map(
    rows.map((r) => [
      String(r.c).toLowerCase(),
      { name: String(r.c), type: String(r.t).toLowerCase(), long: Number(r.l) === -1 }
    ])
  )
  typeCache.set(collection, { at: Date.now(), types })
  return types
}

export interface AggregateGuards {
  /** The role's readable fields, null = all. */
  allowedFields: string[] | null
  /** Fields stored encrypted: their values mean nothing to the database. */
  encrypted?: string[]
}

interface Planned {
  groupBy: string[]
  ops: Array<{ fn: AggregateFunction; field: string; alias: string }>
  countAll: boolean
}

/** Validate a spec against the table and the caller's field list. */
export async function planAggregate(
  collection: string,
  spec: AggregateSpec,
  guards: AggregateGuards
): Promise<Planned> {
  const types = await columnTypes(collection)
  const blocked = new Set((guards.encrypted ?? []).map((f) => f.toLowerCase()))
  const resolve = (field: string, use: string) => {
    if (typeof field !== 'string' || !IDENT.test(field)) {
      throw refuse('AGGREGATE_FIELD_INVALID', `"${String(field)}" is not a field name`)
    }
    const col = types.get(field.toLowerCase())
    if (!col) {
      throw refuse('UNKNOWN_FIELD', `${collection} has no stored field "${field}"`, {
        fields: [field]
      })
    }
    if (
      guards.allowedFields &&
      col.name !== 'id' &&
      !guards.allowedFields.some((f) => f.toLowerCase() === col.name.toLowerCase())
    ) {
      throw Object.assign(new Error(`You do not have access to "${field}"`), {
        statusCode: 403,
        code: 'FIELD_FORBIDDEN',
        fields: [field]
      })
    }
    if (blocked.has(col.name.toLowerCase())) {
      throw refuse('AGGREGATE_FIELD_INVALID', `"${field}" is stored encrypted and cannot be ${use}`)
    }
    return col
  }

  const groupBy: string[] = []
  for (const g of spec.groupBy ?? []) {
    const col = resolve(g, 'grouped')
    if (OPAQUE.has(col.type) || col.long) {
      throw refuse('AGGREGATE_FIELD_INVALID', `"${g}" holds long text and cannot be grouped`)
    }
    if (!groupBy.includes(col.name)) groupBy.push(col.name)
  }
  if (groupBy.length > MAX_GROUP_BY) {
    throw refuse('AGGREGATE_TOO_WIDE', `Group by ${MAX_GROUP_BY} fields at most`)
  }

  const ops: Planned['ops'] = []
  for (const fn of AGGREGATE_FUNCTIONS) {
    for (const f of spec[fn] ?? []) {
      const col = resolve(f, 'aggregated')
      if ((fn === 'sum' || fn === 'avg') && !NUMERIC.has(col.type)) {
        throw refuse('AGGREGATE_FIELD_INVALID', `"${f}" is not a number, so it has no ${fn}`)
      }
      if (
        (fn === 'min' || fn === 'max' || fn === 'countDistinct') &&
        (OPAQUE.has(col.type) || col.long)
      ) {
        throw refuse('AGGREGATE_FIELD_INVALID', `"${f}" holds long text and has no ${fn}`)
      }
      if (fn === 'min' || fn === 'max') {
        if (col.type === 'bit' || col.type === 'uniqueidentifier') {
          throw refuse('AGGREGATE_FIELD_INVALID', `"${f}" has no ${fn}`)
        }
      }
      const alias = `${fn}__${col.name}`
      if (!ops.some((o) => o.alias === alias)) ops.push({ fn, field: col.name, alias })
    }
  }
  if (ops.length > MAX_AGGREGATES) {
    throw refuse('AGGREGATE_TOO_WIDE', `Ask for ${MAX_AGGREGATES} aggregates at most`)
  }
  // Nothing asked for = how many rows.
  const countAll = spec.countAll === true || ops.length === 0
  return { groupBy, ops, countAll }
}

function expression(
  collection: string,
  fn: AggregateFunction,
  field: string,
  type: string
): Knex.Raw {
  const ref = [collection, field]
  switch (fn) {
    case 'count':
      return db.raw('COUNT(??.??)', ref)
    case 'countDistinct':
      return db.raw('COUNT(DISTINCT ??.??)', ref)
    case 'sum':
      // A sum of whole numbers outgrows the column's own type long before it
      // outgrows a big integer.
      return isMssql() && WHOLE.has(type)
        ? db.raw('SUM(CAST(??.?? AS bigint))', ref)
        : db.raw('SUM(??.??)', ref)
    case 'avg':
      // The average of whole numbers is not a whole number.
      return isMssql() ? db.raw('AVG(CAST(??.?? AS float))', ref) : db.raw('AVG(??.??)', ref)
    case 'min':
      return db.raw('MIN(??.??)', ref)
    case 'max':
      return db.raw('MAX(??.??)', ref)
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

/**
 * Run the aggregate over `gated` — a query on `collection` that already
 * carries every WHERE the caller's read would (its own SELECT is replaced).
 */
export async function runAggregate(
  gated: Knex.QueryBuilder,
  collection: string,
  spec: AggregateSpec,
  guards: AggregateGuards
): Promise<{ data: AggregateRow[]; limit: number; offset: number; truncated: boolean }> {
  const plan = await planAggregate(collection, spec, guards)
  const types = await columnTypes(collection)
  const q = gated.clone().clearSelect().clearOrder()
  for (const g of plan.groupBy) {
    q.select(db.raw('??.?? as ??', [collection, g, `group__${g}`]))
    q.groupByRaw('??.??', [collection, g])
  }
  if (plan.countAll) q.select(db.raw('COUNT(*) as ??', ['countAll']))
  for (const o of plan.ops) {
    const e = expression(collection, o.fn, o.field, types.get(o.field.toLowerCase())?.type ?? '')
    q.select(db.raw(`${e.toString()} as ??`, [o.alias]))
  }

  const limit = Math.min(Math.max(Number(spec.limit) || 100, 1), MAX_GROUPS)
  const offset = Math.max(Number(spec.offset) || 0, 0)
  if (plan.groupBy.length > 0) {
    const sorts = (spec.sort ?? []).slice(0, 6)
    let ordered = 0
    for (const s of sorts) {
      const desc = s.startsWith('-')
      const key = desc ? s.slice(1) : s
      const dir = desc ? 'desc' : 'asc'
      const group = plan.groupBy.find((g) => g.toLowerCase() === key.toLowerCase())
      if (group) {
        q.orderByRaw(`??.?? ${dir}`, [collection, group])
        ordered++
        continue
      }
      if (key === 'countAll' && plan.countAll) {
        q.orderByRaw(`COUNT(*) ${dir}`)
        ordered++
        continue
      }
      const [fn, field] = key.split('.')
      const op = plan.ops.find(
        (o) => o.fn === fn && o.field.toLowerCase() === String(field).toLowerCase()
      )
      if (!op) {
        throw refuse(
          'AGGREGATE_SORT_INVALID',
          `"${key}" is not a group field or an aggregate of this request`
        )
      }
      const e = expression(
        collection,
        op.fn,
        op.field,
        types.get(op.field.toLowerCase())?.type ?? ''
      )
      q.orderByRaw(`${e.toString()} ${dir}`)
      ordered++
    }
    // Paging needs a settled order.
    if (ordered === 0) for (const g of plan.groupBy) q.orderByRaw('??.?? asc', [collection, g])
    q.limit(limit + 1).offset(offset)
  }

  const rows = (await q) as Record<string, unknown>[]
  const truncated = plan.groupBy.length > 0 && rows.length > limit
  const data = (truncated ? rows.slice(0, limit) : rows).map((r) => {
    const out: AggregateRow = { group: {} }
    for (const g of plan.groupBy) out.group[g] = r[`group__${g}`] ?? null
    if (plan.countAll) out.countAll = Number(r.countAll ?? 0)
    for (const o of plan.ops) {
      const v = r[o.alias]
      if (o.fn === 'count' || o.fn === 'countDistinct') {
        const bag = (out[o.fn] ??= {})
        bag[o.field] = Number(v ?? 0)
      } else if (o.fn === 'sum' || o.fn === 'avg') {
        const bag = (out[o.fn] ??= {})
        bag[o.field] = num(v)
      } else {
        const bag = (out[o.fn] ??= {})
        bag[o.field] = v ?? null
      }
    }
    return out
  })
  return { data, limit, offset, truncated }
}

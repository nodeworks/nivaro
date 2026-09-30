import type { Knex } from 'knex'
import { db } from '../db/index.js'
import {
  boolOfValue,
  type ColumnFilterOp,
  dayOfValue,
  numberOfValue,
  parseColumnFilterOp
} from './column-filter-ops.js'

/**
 * The materialized queue cache's `extra` JSON column. Its top level is FLAT —
 * one key per configured extra-column path ('divisions.name' is a literal
 * key) — plus reserved keys the read path strips back out:
 *
 *   __ids  related-record ids per path (drill-down)
 *   __t    typed twins per path (#801): {d: 'YYYY-MM-DD', n: number, b: 0|1},
 *          each present only when the displayed value reads as that type —
 *          computed with the SAME readers the live column filter uses
 *          (dayOfValue / numberOfValue / boolOfValue), so a date / number /
 *          boolean filter pushed down to SQL agrees with the live path row
 *          for row
 *   __via  the in-flight addendum a row's state/owners came from (#715)
 *
 * Every writer goes through encodeCachedExtra and the reader through
 * decodeCachedExtra, so the reserved keys never reach a client.
 */

export interface TypedTwin {
  d?: string
  n?: number
  b?: 0 | 1
}

export interface ViaAddendum {
  id: string
  title: string | null
}

export function typedTwins(extra: Record<string, unknown>): Record<string, TypedTwin> {
  const out: Record<string, TypedTwin> = {}
  for (const [path, v] of Object.entries(extra)) {
    if (v == null) continue
    const twin: TypedTwin = {}
    const d = dayOfValue(v)
    if (d) twin.d = d
    const n = numberOfValue(v)
    if (n != null) twin.n = n
    const b = boolOfValue(v)
    if (b != null) twin.b = b ? 1 : 0
    if (Object.keys(twin).length > 0) out[path] = twin
  }
  return out
}

export function encodeCachedExtra(
  extra: Record<string, unknown> | undefined | null,
  extraIds?: Record<string, string[]> | null,
  via?: ViaAddendum | null
): string {
  const plain = extra ?? {}
  const out: Record<string, unknown> = { ...plain }
  if (extraIds && Object.keys(extraIds).length > 0) out.__ids = extraIds
  // Always written, even empty: its presence is how the read path knows a
  // row was cached by a writer that knows typed twins (see cacheHasTypedTwins).
  out.__t = typedTwins(plain)
  if (via) out.__via = via
  return JSON.stringify(out)
}

export function decodeCachedExtra(raw: string | null): {
  extra: Record<string, unknown>
  extra_ids: Record<string, string[]>
  via_addendum: ViaAddendum | null
} {
  if (!raw) return { extra: {}, extra_ids: {}, via_addendum: null }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const { __ids, __t: _t, __via, ...rest } = parsed
    return {
      extra: rest,
      extra_ids: (__ids as Record<string, string[]>) ?? {},
      via_addendum: (__via as ViaAddendum | undefined) ?? null
    }
  } catch {
    return { extra: {}, extra_ids: {}, via_addendum: null }
  }
}

/** JSON path of one typed twin. Keys come from stored source config; quotes
 *  are stripped defensively like every other extra path. */
export function twinJsonPath(field: string, kind: 'd' | 'n' | 'b'): string {
  return `$."__t"."${field.replace(/"/g, '')}".${kind}`
}

/** True when any extra.* filter value carries a date / number / boolean
 *  operator (the ones only the typed twins can answer in SQL). */
export function hasTypedExtraFilter(filters: Record<string, unknown> | undefined): boolean {
  for (const [key, raw] of Object.entries(filters ?? {})) {
    if (!key.startsWith('extra.')) continue
    const values = Array.isArray(raw) ? raw : [raw]
    if (values.some((v) => typeof v === 'string' && parseColumnFilterOp(v))) return true
  }
  return false
}

/**
 * One typed operator as a SQL predicate over the twin. TRY_CONVERT means a
 * twin that somehow is not the expected type never matches — the live
 * matcher's "a value that cannot be read as the filter's type never
 * matches" rule. NULL comparisons are false, so rows without the twin drop out.
 */
export function applyTypedExtraPredicate(
  qb: Knex.QueryBuilder,
  field: string,
  op: ColumnFilterOp
): void {
  if (op.kind === 'date') {
    const expr = 'TRY_CONVERT(date, JSON_VALUE(qi.extra, ?), 23)'
    const path = twinJsonPath(field, 'd')
    qb.where(function () {
      this.whereRaw(`${expr} IS NOT NULL`, [path])
      if (op.from) this.whereRaw(`${expr} >= CONVERT(date, ?, 23)`, [path, op.from])
      if (op.to) this.whereRaw(`${expr} <= CONVERT(date, ?, 23)`, [path, op.to])
    })
    return
  }
  if (op.kind === 'num') {
    const expr = 'TRY_CONVERT(float, JSON_VALUE(qi.extra, ?))'
    const path = twinJsonPath(field, 'n')
    const cmp: Record<string, string> = {
      eq: '=',
      neq: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<='
    }
    if (op.op === 'between') {
      qb.whereRaw(`${expr} BETWEEN ? AND ?`, [path, op.a, op.b as number])
    } else {
      qb.whereRaw(`${expr} ${cmp[op.op]} ?`, [path, op.a])
    }
    return
  }
  qb.whereRaw('JSON_VALUE(qi.extra, ?) = ?', [twinJsonPath(field, 'b'), op.value ? '1' : '0'])
}

/**
 * Whether EVERY cached row of the queue was written with typed twins. A cache
 * built before #801 carries none, and a typed filter pushed down to it would
 * silently match nothing — those requests keep live-resolving until the one
 * rebuild that re-writes the rows.
 */
export async function cacheHasTypedTwins(queueId: string): Promise<boolean> {
  const stale = await db('nivaro_queue_items')
    .where({ queue_id: queueId })
    .where((b) => b.whereNull('extra').orWhereRaw(`JSON_QUERY(extra, '$."__t"') IS NULL`))
    .first('id')
  return !stale
}

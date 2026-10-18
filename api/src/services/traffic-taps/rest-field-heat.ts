// api/src/services/traffic-taps/rest-field-heat.ts
/**
 * Traffic Map tap `rest-fields` (#2206) — which fields callers ask for with `fields=` on REST
 * list reads, per collection and per caller, beside the GraphQL field heat (#1134). Field NAMES
 * only (never values). `*` (every column) is kept as its own row: a collection whose reads are
 * mostly `*` is the payload and index decision this lens exists for. The request's first list
 * read leaves its `fields` by reference (request-trace noteReadShape), so this costs nothing
 * extra on the request path.
 */
import { requestMeasure } from '../request-trace.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { boundedGet } from './minute-slots.js'
import { MinuteTotals } from './util.js'

export const REST_FIELDS_TAP = 'rest-fields'
const COLLECTION_CAP = 300
const FIELDS_PER_COLLECTION = 60
const CALLER_PAIRS_PER_COLLECTION = 240
const FIELDS_PER_READ = 60
const FIELD_CAP = 80
const SEP = '\u0001'
const SAFE_FIELD = /^(\*|[$A-Za-z0-9_]+(\.(\*|[$A-Za-z0-9_]+))*)$/

interface CollectionHeat {
  /** field → reads asking for it */
  fields: MinuteTotals
  /** `field\u0001caller` → reads */
  callers: MinuteTotals
  reads: MinuteTotals
}
interface State {
  collections: Map<string, CollectionHeat>
}
const state = () => tapState<State>(REST_FIELDS_TAP, () => ({ collections: new Map() }))

/** The distinct, name-safe fields of a `fields=` list (`['*']` when the caller named none). */
export function fieldNames(fields: readonly unknown[] | undefined): string[] {
  const out = new Set<string>()
  for (const f of fields ?? []) {
    if (typeof f !== 'string') continue
    const name = f.trim()
    if (!name || name.length > FIELD_CAP || !SAFE_FIELD.test(name)) continue
    out.add(name)
    if (out.size >= FIELDS_PER_READ) break
  }
  return out.size ? [...out] : ['*']
}

/** Count one REST read of `collection` that asked for `fields`. */
export function recordFieldHeat(
  collection: string,
  caller: string,
  fields: readonly unknown[] | undefined,
  sec: number
): void {
  const c = boundedGet(
    state().collections,
    collection.slice(0, 120),
    COLLECTION_CAP,
    (): CollectionHeat => ({
      fields: new MinuteTotals(FIELDS_PER_COLLECTION),
      callers: new MinuteTotals(CALLER_PAIRS_PER_COLLECTION),
      reads: new MinuteTotals(1)
    })
  )
  if (!c) return
  c.reads.add('n', sec)
  for (const f of fieldNames(fields)) {
    c.fields.add(f, sec)
    c.callers.add(`${f}${SEP}${caller}`, sec)
  }
}

export interface RestFieldsDetail {
  window_s: number
  reads: number
  /** Reads that asked for every column (`fields=*` or no `fields`). */
  star_reads: number
  fields: Array<{ field: string; n: number; callers: Array<{ key: string; n: number }> }>
}

export function restFieldsDetail(
  entityKey: string,
  windowS: number,
  sec: number
): RestFieldsDetail | undefined {
  if (!entityKey.startsWith('items/') && !entityKey.startsWith('system/')) return undefined
  const c = state().collections.get(entityKey.slice(entityKey.indexOf('/') + 1))
  if (!c) return undefined
  const reads = c.reads.sum('n', windowS, sec)
  if (reads <= 0) return undefined
  const pairs = c.callers.entries(windowS, sec)
  const fields = c.fields
    .entries(windowS, sec)
    .slice(0, 25)
    .map(([field, n]) => {
      const prefix = `${field}${SEP}`
      const callers: Array<{ key: string; n: number }> = []
      for (const [k, v] of pairs) {
        if (!k.startsWith(prefix)) continue
        callers.push({ key: k.slice(prefix.length), n: v })
        if (callers.length >= 3) break
      }
      return { field, n, callers }
    })
  return { window_s: windowS, reads, star_reads: c.fields.sum('*', windowS, sec), fields }
}

export const restFieldHeatTap: TrafficTap = {
  id: REST_FIELDS_TAP,
  onRequest(c) {
    if (c.lane !== 'items' && c.lane !== 'system') return
    const shape = requestMeasure(c.ev.req)?.shape
    if (!shape) return
    recordFieldHeat(shape.collection, c.caller, shape.fields, c.sec)
  },
  entityDetail(key, windowS, sec) {
    return restFieldsDetail(key, windowS, sec)
  },
  sweep(sec) {
    const map = state().collections
    for (const [k, c] of map) {
      c.fields.sweep(sec)
      c.callers.sweep(sec)
      c.reads.sweep(sec)
      if (c.reads.size === 0) map.delete(k)
    }
  }
}

registerTrafficTap(restFieldHeatTap)

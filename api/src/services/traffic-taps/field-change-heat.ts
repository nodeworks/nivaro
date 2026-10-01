// api/src/services/traffic-taps/field-change-heat.ts
/**
 * Traffic Map tap `field-heat` (#1136) — which fields change most per collection and which
 * callers change them, from the `changed_fields` every write already carries. Capped per
 * collection (fields and field × caller pairs), memory only.
 */
import { MinuteCounter } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const FIELD_HEAT_TAP = 'field-heat'
const ENTITY_CAP = 400
const FIELDS_PER_ENTITY = 40
const PAIRS_PER_ENTITY = 160
const FIELDS_PER_WRITE = 40
const SEP = '\u0001'

interface EntityHeat {
  fields: MinuteCounter
  pairs: MinuteCounter
  writes: MinuteCounter
}
interface State {
  entities: Map<string, EntityHeat>
}
const state = () => tapState<State>(FIELD_HEAT_TAP, () => ({ entities: new Map() }))

export function recordFieldChanges(
  entityKey: string,
  caller: string,
  fields: readonly string[],
  sec: number
): void {
  const map = state().entities
  let e = map.get(entityKey)
  if (!e) {
    if (map.size >= ENTITY_CAP) return
    e = {
      fields: new MinuteCounter(FIELDS_PER_ENTITY),
      pairs: new MinuteCounter(PAIRS_PER_ENTITY),
      writes: new MinuteCounter(1)
    }
    map.set(entityKey, e)
  }
  e.writes.bump('n', sec)
  let k = 0
  for (const raw of fields) {
    if (k++ >= FIELDS_PER_WRITE) break
    const f = String(raw).slice(0, 80)
    if (!f) continue
    e.fields.bump(f, sec)
    e.pairs.bump(`${f}${SEP}${caller}`, sec)
  }
}

export interface FieldHeatDetail {
  window_s: number
  writes: number
  fields: Array<{
    field: string
    n: number
    share: number
    callers: Array<{ key: string; n: number }>
  }>
}

export function fieldHeatDetail(
  entityKey: string,
  windowS: number,
  sec: number
): FieldHeatDetail | undefined {
  const e = state().entities.get(entityKey)
  if (!e) return undefined
  const writes = e.writes.sum('n', windowS, sec)
  const top = e.fields.top(windowS, sec, 15)
  if (writes <= 0 || top.length === 0) return undefined
  const pairs = e.pairs.top(windowS, sec, PAIRS_PER_ENTITY)
  return {
    window_s: windowS,
    writes,
    fields: top.map(([field, n]) => {
      const prefix = `${field}${SEP}`
      const callers: Array<{ key: string; n: number }> = []
      for (const [k, c] of pairs) {
        if (k.startsWith(prefix)) callers.push({ key: k.slice(prefix.length), n: c })
        if (callers.length >= 3) break
      }
      return { field, n, share: Math.round((1000 * n) / writes) / 1000, callers }
    })
  }
}

export const fieldChangeHeatTap: TrafficTap = {
  id: FIELD_HEAT_TAP,
  onWrite(c) {
    const fields = c.ev.changedFields
    if (!fields?.length) return
    recordFieldChanges(c.entityKey, c.caller, fields, c.sec)
  },
  entityDetail(key, windowS, sec) {
    return fieldHeatDetail(key, windowS, sec)
  },
  sweep(sec) {
    const map = state().entities
    for (const [k, e] of map) {
      e.fields.sweep(sec)
      e.pairs.sweep(sec)
      e.writes.sweep(sec)
      if (e.writes.size === 0) map.delete(k)
    }
  }
}

registerTrafficTap(fieldChangeHeatTap)

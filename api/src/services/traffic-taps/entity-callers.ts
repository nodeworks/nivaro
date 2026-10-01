// api/src/services/traffic-taps/entity-callers.ts
/**
 * #1095 / #1102 — per entity × caller counts. Each entity keeps a per-second ring per caller
 * (req, read, create, update, delete, error — the map's own slot order) plus a small latency
 * reservoir, at most CALLERS_PER_ENTITY callers (then `__other__`, after evicting an idle one).
 *
 * frame:   { [entityKey]: { [caller]: [req, read, create, update, delete, error, p95] } } —
 *          only the cells counted in that second, so the client can SET its ring exactly.
 * entity:  { [caller]: [req, read, create, update, delete, error, p95] } over the window.
 * detail:  { callers: [{ key, sums, p50, p95, series }] } for the inspector's caller focus.
 */
import { OTHER_KEY, SecondRing, TOP_KEYS_CAP } from '../traffic-ring.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'

export const ENTITY_CALLERS_TAP = 'entity-callers'
export const CALLERS_PER_ENTITY = TOP_KEYS_CAP
const SLOTS = 6
const S = { req: 0, read: 1, create: 2, update: 3, delete: 4, error: 5 } as const
const LAT = 60
const DETAIL_POINTS = 40

interface Cell {
  ring: SecondRing
  lat: Float32Array
  latN: number
  latI: number
}
interface State {
  byEntity: Map<string, Map<string, Cell>>
  /** entityKey → callers counted since the last frame. */
  touched: Map<string, Set<string>>
}
const state = (): State =>
  tapState<State>(ENTITY_CALLERS_TAP, () => ({ byEntity: new Map(), touched: new Map() }))

function pct(c: Cell, p: number): number {
  if (!c.latN) return 0
  const a = Array.from(c.lat.subarray(0, c.latN)).sort((x, y) => x - y)
  return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))])
}

function cellOf(entityKey: string, caller: string, sec: number): { cell: Cell; key: string } {
  const st = state()
  let row = st.byEntity.get(entityKey)
  if (!row) {
    row = new Map()
    st.byEntity.set(entityKey, row)
  }
  let key = caller
  let cell = row.get(key)
  if (!cell) {
    if (row.size >= CALLERS_PER_ENTITY) {
      for (const [k, c] of row) {
        if (k !== OTHER_KEY && c.ring.idle(sec)) {
          row.delete(k)
          break
        }
      }
    }
    if (row.size >= CALLERS_PER_ENTITY) {
      key = OTHER_KEY
      cell = row.get(key)
    }
    if (!cell) {
      cell = { ring: new SecondRing(SLOTS, sec), lat: new Float32Array(LAT), latN: 0, latI: 0 }
      row.set(key, cell)
    }
  }
  let t = st.touched.get(entityKey)
  if (!t) {
    t = new Set()
    st.touched.set(entityKey, t)
  }
  t.add(key)
  return { cell, key }
}

function sample(c: Cell, ms: number): void {
  if (!Number.isFinite(ms)) return
  c.lat[c.latI] = ms
  c.latI = (c.latI + 1) % LAT
  if (c.latN < LAT) c.latN++
}

export function entityCallerCounts(
  entityKey: string,
  windowS: number,
  sec: number
): Record<string, number[]> | undefined {
  const row = state().byEntity.get(entityKey)
  if (!row) return undefined
  let out: Record<string, number[]> | undefined
  for (const [caller, c] of row) {
    const s = c.ring.sum(windowS, sec)
    if (s.every((v) => v === 0)) continue
    if (!out) out = {}
    out[caller] = [...s, pct(c, 0.95)]
  }
  return out
}

registerTrafficTap({
  id: ENTITY_CALLERS_TAP,
  onRequest(c) {
    const { cell } = cellOf(c.entityKey, c.caller, c.sec)
    cell.ring.bump(c.sec, S.req)
    if (c.isError) cell.ring.bump(c.sec, S.error)
    else if (c.kind === 'read') cell.ring.bump(c.sec, S.read)
    sample(cell, c.ev.latencyMs)
  },
  onWrite(c) {
    const { cell } = cellOf(c.entityKey, c.caller, c.sec)
    const slot =
      c.ev.action === 'create' ? S.create : c.ev.action === 'delete' ? S.delete : S.update
    // Same slots as the entity ring: a write adds its action, never a request.
    cell.ring.bump(c.sec, slot)
  },
  frame(sec) {
    const st = state()
    if (st.touched.size === 0) return undefined
    let out: Record<string, Record<string, number[]>> | undefined
    for (const [entityKey, callers] of st.touched) {
      const row = st.byEntity.get(entityKey)
      if (!row) continue
      for (const caller of callers) {
        const cell = row.get(caller)
        if (!cell || cell.ring.touchedSec < sec) continue
        const s = cell.ring.second(sec)
        if (s.every((v) => v === 0)) continue
        if (!out) out = {}
        const e = out[entityKey] ?? {}
        e[caller] = [...s, pct(cell, 0.95)]
        out[entityKey] = e
      }
    }
    st.touched.clear()
    return out
  },
  entitySnapshot(entityKey, windowS, sec) {
    return entityCallerCounts(entityKey, windowS, sec)
  },
  entityDetail(entityKey, windowS, sec) {
    const row = state().byEntity.get(entityKey)
    if (!row) return undefined
    const callers = [...row]
      .map(([key, c]) => ({
        key,
        sums: c.ring.sum(windowS, sec),
        p50: pct(c, 0.5),
        p95: pct(c, 0.95),
        series: c.ring.series(windowS, sec, DETAIL_POINTS, S.req)
      }))
      .filter((r) => r.sums.some((v) => v > 0))
      .sort((a, b) => b.sums[S.req] - a.sums[S.req])
    return callers.length ? { callers } : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, row] of st.byEntity) {
      for (const [caller, c] of row) if (c.ring.idle(sec)) row.delete(caller)
      if (row.size === 0) st.byEntity.delete(k)
    }
    st.touched.clear()
  }
})

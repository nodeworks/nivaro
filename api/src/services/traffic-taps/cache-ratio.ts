// api/src/services/traffic-taps/cache-ratio.ts
/**
 * #1111 — cache hit ratio on custom-query and widget nodes. The query / widget render routes
 * mark a cached answer (`markCacheHit`); this counts hits vs misses per entity over a per-second
 * ring, and keeps the latency of each side so "saved ~N ms" is the median uncached time minus
 * the median cached time. Successful requests only (an error is neither).
 *
 * frame:  { [entityKey]: [hits60, misses60] } for the entities that answered in that second.
 * entity: { hits, misses, ratio, hit_ms, miss_ms, saved_ms } over the window (ms = medians).
 */
import { SecondRing } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const CACHE_RATIO_TAP = 'cache-ratio'
export const CACHED_LANES = new Set(['queries', 'widgets'])
const LAT = 60

interface Cell {
  ring: SecondRing // 0 hit, 1 miss
  hitMs: Float32Array
  hitN: number
  hitI: number
  missMs: Float32Array
  missN: number
  missI: number
}
interface State {
  byEntity: Map<string, Cell>
  touched: Set<string>
}
const state = (): State =>
  tapState<State>(CACHE_RATIO_TAP, () => ({ byEntity: new Map(), touched: new Set() }))

function median(a: Float32Array, n: number): number {
  if (!n) return 0
  const s = Array.from(a.subarray(0, n)).sort((x, y) => x - y)
  return Math.round(s[Math.floor(s.length / 2)])
}

export function cacheFigures(
  c: Cell,
  windowS: number,
  sec: number
): {
  hits: number
  misses: number
  ratio: number
  hit_ms: number
  miss_ms: number
  saved_ms: number
} {
  const [hits, misses] = c.ring.sum(windowS, sec)
  const hitMs = median(c.hitMs, c.hitN)
  const missMs = median(c.missMs, c.missN)
  return {
    hits,
    misses,
    ratio: hits + misses ? hits / (hits + misses) : 0,
    hit_ms: hitMs,
    miss_ms: missMs,
    // only meaningful once both sides have been seen
    saved_ms: c.hitN && c.missN ? Math.max(0, missMs - hitMs) : 0
  }
}

const tap: TrafficTap = {
  id: CACHE_RATIO_TAP,
  onRequest(c) {
    if (!CACHED_LANES.has(c.lane) || c.isError) return
    const st = state()
    let cell = st.byEntity.get(c.entityKey)
    if (!cell) {
      cell = {
        ring: new SecondRing(2, c.sec),
        hitMs: new Float32Array(LAT),
        hitN: 0,
        hitI: 0,
        missMs: new Float32Array(LAT),
        missN: 0,
        missI: 0
      }
      st.byEntity.set(c.entityKey, cell)
    }
    const ms = c.ev.latencyMs
    if (c.ev.cacheHit) {
      cell.ring.bump(c.sec, 0)
      cell.hitMs[cell.hitI] = ms
      cell.hitI = (cell.hitI + 1) % LAT
      if (cell.hitN < LAT) cell.hitN++
    } else {
      cell.ring.bump(c.sec, 1)
      cell.missMs[cell.missI] = ms
      cell.missI = (cell.missI + 1) % LAT
      if (cell.missN < LAT) cell.missN++
    }
    st.touched.add(c.entityKey)
  },
  frame(sec) {
    const st = state()
    if (st.touched.size === 0) return undefined
    const out: Record<string, number[]> = {}
    for (const k of st.touched) {
      const cell = st.byEntity.get(k)
      if (cell) out[k] = cell.ring.sum(60, sec)
    }
    st.touched.clear()
    return out
  },
  entitySnapshot(entityKey, windowS, sec) {
    const cell = state().byEntity.get(entityKey)
    if (!cell) return undefined
    const f = cacheFigures(cell, windowS, sec)
    return f.hits + f.misses ? f : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, c] of st.byEntity) if (c.ring.idle(sec)) st.byEntity.delete(k)
    st.touched.clear()
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)

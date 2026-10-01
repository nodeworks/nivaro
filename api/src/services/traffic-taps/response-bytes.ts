// api/src/services/traffic-taps/response-bytes.ts
/**
 * #1110 — response body size per entity: a reservoir of the newest SAMPLES sizes (string and
 * Buffer payloads; streams carry no size and are left out) → p50 / p95 / max, to find fat
 * responses (an avatar riding a `select *`, a 1 MB list read).
 *
 * frame:  { [entityKey]: [p50, p95] } for the entities that answered in that second.
 * entity: { p50, p95, max, n } over the reservoir (n = sizes held).
 */
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const RESPONSE_BYTES_TAP = 'response-bytes'
const SAMPLES = 120

interface Reservoir {
  v: Float64Array
  n: number
  i: number
  max: number
  lastSec: number
}
interface State {
  byEntity: Map<string, Reservoir>
  touched: Set<string>
}
const state = (): State =>
  tapState<State>(RESPONSE_BYTES_TAP, () => ({ byEntity: new Map(), touched: new Set() }))

export function sizeStats(r: Reservoir): { p50: number; p95: number; max: number; n: number } {
  if (!r.n) return { p50: 0, p95: 0, max: 0, n: 0 }
  const a = Array.from(r.v.subarray(0, r.n)).sort((x, y) => x - y)
  const q = (p: number) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))])
  return { p50: q(0.5), p95: q(0.95), max: Math.round(r.max), n: r.n }
}

const tap: TrafficTap = {
  id: RESPONSE_BYTES_TAP,
  onRequest(c) {
    const bytes = c.ev.responseBytes
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return
    const st = state()
    let r = st.byEntity.get(c.entityKey)
    if (!r) {
      r = { v: new Float64Array(SAMPLES), n: 0, i: 0, max: 0, lastSec: c.sec }
      st.byEntity.set(c.entityKey, r)
    }
    r.v[r.i] = bytes
    r.i = (r.i + 1) % SAMPLES
    if (r.n < SAMPLES) r.n++
    // max over what the reservoir still holds
    r.max = 0
    for (let k = 0; k < r.n; k++) if (r.v[k] > r.max) r.max = r.v[k]
    r.lastSec = c.sec
    st.touched.add(c.entityKey)
  },
  frame() {
    const st = state()
    if (st.touched.size === 0) return undefined
    const out: Record<string, number[]> = {}
    for (const k of st.touched) {
      const r = st.byEntity.get(k)
      if (!r) continue
      const s = sizeStats(r)
      out[k] = [s.p50, s.p95]
    }
    st.touched.clear()
    return out
  },
  entitySnapshot(entityKey) {
    const r = state().byEntity.get(entityKey)
    return r?.n ? sizeStats(r) : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, r] of st.byEntity) if (sec - r.lastSec >= 900) st.byEntity.delete(k)
    st.touched.clear()
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)

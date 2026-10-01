// api/src/services/traffic-taps/auth-mix.ts
/**
 * #1137 — how requests authenticated, per lane and per entity: session / token / api_key /
 * masquerade / key_sim / none, so a lane suddenly driven by tokens (an integration, a script)
 * stands out against its usual browser-session traffic.
 *
 * frame:    { lanes: { [lane]: number[6] } } — rolling 60 s per lane, for lanes touched in that
 *           second (slot order = AUTH_METHODS).
 * snapshot: { lanes: { [lane]: number[6] }, total: number[6] } over the window.
 * entity:   number[6] over the window.
 */
import { SecondRing } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const AUTH_MIX_TAP = 'auth-mix'
export const AUTH_METHODS = [
  'session',
  'token',
  'api_key',
  'masquerade',
  'key_sim',
  'none'
] as const

export function authSlot(method: string | null | undefined): number {
  const i = AUTH_METHODS.indexOf((method ?? 'none') as (typeof AUTH_METHODS)[number])
  return i < 0 ? AUTH_METHODS.length - 1 : i
}

interface State {
  lanes: Map<string, SecondRing>
  entities: Map<string, SecondRing>
  touched: Set<string>
}
const state = (): State =>
  tapState<State>(AUTH_MIX_TAP, () => ({
    lanes: new Map(),
    entities: new Map(),
    touched: new Set()
  }))

function ringOf(m: Map<string, SecondRing>, key: string, sec: number): SecondRing {
  let r = m.get(key)
  if (!r) {
    r = new SecondRing(AUTH_METHODS.length, sec)
    m.set(key, r)
  }
  return r
}

const tap: TrafficTap = {
  id: AUTH_MIX_TAP,
  onRequest(c) {
    const st = state()
    const slot = authSlot(c.ev.authMethod)
    ringOf(st.lanes, c.lane, c.sec).bump(c.sec, slot)
    ringOf(st.entities, c.entityKey, c.sec).bump(c.sec, slot)
    st.touched.add(c.lane)
  },
  frame(sec) {
    const st = state()
    if (st.touched.size === 0) return undefined
    const lanes: Record<string, number[]> = {}
    for (const lane of st.touched) {
      const r = st.lanes.get(lane)
      if (r) lanes[lane] = r.sum(60, sec)
    }
    st.touched.clear()
    return { lanes }
  },
  snapshot(windowS, sec) {
    const st = state()
    const lanes: Record<string, number[]> = {}
    const total = new Array<number>(AUTH_METHODS.length).fill(0)
    for (const [lane, r] of st.lanes) {
      const s = r.sum(windowS, sec)
      if (s.every((v) => v === 0)) continue
      lanes[lane] = s
      for (let i = 0; i < s.length; i++) total[i] += s[i]
    }
    return Object.keys(lanes).length ? { lanes, total } : undefined
  },
  entitySnapshot(entityKey, windowS, sec) {
    const r = state().entities.get(entityKey)
    if (!r) return undefined
    const s = r.sum(windowS, sec)
    return s.some((v) => v > 0) ? s : undefined
  },
  sweep(sec) {
    const st = state()
    for (const m of [st.lanes, st.entities]) for (const [k, r] of m) if (r.idle(sec)) m.delete(k)
    st.touched.clear()
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)

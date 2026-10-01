// api/src/services/traffic-taps/auth-rejections.ts
/**
 * #1099 — rejected requests (401 / 403 / 429) per caller, with the reason code the response
 * carried (API_KEY_SCOPE_MISSING, API_KEY_RATE_LIMITED, TOKEN_INVALID …; a body without one reads
 * UNAUTHORIZED / FORBIDDEN / RATE_LIMITED). Bounded: CALLER_CAP callers (idle ones evicted, then
 * `__other__`), each with ≤ 20 status+code keys.
 *
 * frame:   { [caller]: n } rejections in that second (absent when none).
 * snapshot: { callers: [{ key, n, codes: [{ status, code, n }], series }] } busiest first.
 * entity:  { n, codes } rejections that landed on the entity.
 */
import { MinuteCounter, OTHER_KEY, SecondRing } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const AUTH_REJECTIONS_TAP = 'auth-rejections'
export const REJECT_STATUSES = new Set([401, 403, 429])
const CALLER_CAP = 50
const SERIES_POINTS = 30

export function fallbackCode(status: number): string {
  return status === 429 ? 'RATE_LIMITED' : status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED'
}

interface CallerRow {
  ring: SecondRing
  codes: MinuteCounter
}
interface State {
  callers: Map<string, CallerRow>
  entities: Map<string, MinuteCounter>
  second: Map<string, number>
  secondAt: number
}
const state = (): State =>
  tapState<State>(AUTH_REJECTIONS_TAP, () => ({
    callers: new Map(),
    entities: new Map(),
    second: new Map(),
    secondAt: 0
  }))

function rowOf(st: State, caller: string, sec: number): CallerRow {
  let key = caller
  let row = st.callers.get(key)
  if (row) return row
  if (st.callers.size >= CALLER_CAP) {
    for (const [k, r] of st.callers) {
      if (k !== OTHER_KEY && r.ring.idle(sec)) {
        st.callers.delete(k)
        break
      }
    }
  }
  if (st.callers.size >= CALLER_CAP) {
    key = OTHER_KEY
    row = st.callers.get(key)
    if (row) return row
  }
  row = { ring: new SecondRing(1, sec), codes: new MinuteCounter() }
  st.callers.set(key, row)
  return row
}

/** `401|TOKEN_INVALID` → { status, code }. */
function splitKey(k: string): { status: number; code: string } {
  const i = k.indexOf('|')
  return { status: Number(k.slice(0, i)) || 0, code: k.slice(i + 1) }
}

const tap: TrafficTap = {
  id: AUTH_REJECTIONS_TAP,
  onRequest(c) {
    const status = c.ev.status
    if (!REJECT_STATUSES.has(status)) return
    const st = state()
    const key = `${status}|${c.code ?? fallbackCode(status)}`
    const row = rowOf(st, c.caller, c.sec)
    row.ring.bump(c.sec)
    row.codes.bump(key, c.sec)
    let ent = st.entities.get(c.entityKey)
    if (!ent) {
      ent = new MinuteCounter()
      st.entities.set(c.entityKey, ent)
    }
    ent.bump(key, c.sec)
    if (st.secondAt !== c.sec) {
      st.second.clear()
      st.secondAt = c.sec
    }
    st.second.set(c.caller, (st.second.get(c.caller) ?? 0) + 1)
    if (c.event) c.event.tags = [...(c.event.tags ?? []), 'rejected']
  },
  frame(sec) {
    const st = state()
    if (st.secondAt !== sec || st.second.size === 0) return undefined
    const out = Object.fromEntries(st.second)
    st.second.clear()
    return out
  },
  snapshot(windowS, sec) {
    const st = state()
    const callers = [...st.callers]
      .map(([key, r]) => ({
        key,
        n: r.ring.sum(windowS, sec)[0],
        codes: r.codes.top(windowS, sec, 8).map(([k, n]) => ({ ...splitKey(k), n })),
        series: r.ring.series(windowS, sec, SERIES_POINTS)
      }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 20)
    return callers.length ? { callers } : undefined
  },
  entitySnapshot(entityKey, windowS, sec) {
    const ent = state().entities.get(entityKey)
    if (!ent) return undefined
    const codes = ent.top(windowS, sec, 8).map(([k, n]) => ({ ...splitKey(k), n }))
    const n = codes.reduce((a, r) => a + r.n, 0)
    return n ? { n, codes } : undefined
  },
  sweep(sec) {
    const st = state()
    for (const [k, r] of st.callers) if (r.ring.idle(sec)) st.callers.delete(k)
    for (const [k, m] of st.entities) {
      m.sweep(sec)
      if (m.size === 0) st.entities.delete(k)
    }
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)

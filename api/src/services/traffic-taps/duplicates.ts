// api/src/services/traffic-taps/duplicates.ts
/**
 * #1117 — duplicate request detector: an identical GET (method + path + query string) from the
 * same caller started within DUP_WINDOW_MS of the previous one. Only a short hash of the request
 * is held, never the query values; what leaves this module is the route template, the caller
 * and the gap between the two.
 *
 * frame:  { [entityKey]: n } duplicates found in that second.
 * entity: { n, routes: [{ route, n }], pairs: [{ at, route, caller, gap_ms }] } (window).
 */
import { createHash } from 'node:crypto'
import { MinuteCounter, OTHER_KEY } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { queryOf, reqOf } from './req-facts.js'

export const DUPLICATES_TAP = 'duplicates'
export const DUP_WINDOW_MS = 500
const PER_CALLER = 64
const CALLER_CAP = 200
const PAIRS = 8

export interface DupPair {
  at: string
  route: string
  caller: string
  gap_ms: number
}
interface EntityDups {
  routes: MinuteCounter
  pairs: DupPair[]
}
interface State {
  /** caller → request hash → start time (ms) of the newest request with that hash. */
  seen: Map<string, Map<string, number>>
  entities: Map<string, EntityDups>
  second: Map<string, number>
  secondAt: number
}
const state = (): State =>
  tapState<State>(DUPLICATES_TAP, () => ({
    seen: new Map(),
    entities: new Map(),
    second: new Map(),
    secondAt: 0
  }))

/** Order-insensitive query: `?b=2&a=1` and `?a=1&b=2` are the same request. */
export function requestHash(method: string, path: string, query: string): string {
  const q = query ? query.split('&').filter(Boolean).sort().join('&') : ''
  return createHash('sha1').update(`${method} ${path}?${q}`).digest('base64').slice(0, 16)
}

function prune(m: Map<string, number>, now: number): void {
  for (const [h, t] of m) if (now - t > DUP_WINDOW_MS) m.delete(h)
}

const tap: TrafficTap = {
  id: DUPLICATES_TAP,
  onRequest(c) {
    if (c.ev.method !== 'GET' || c.kind !== 'read' || c.caller === OTHER_KEY) return
    const st = state()
    const start = c.ev.at - Math.max(0, c.ev.latencyMs)
    const hash = requestHash('GET', c.ev.path, queryOf(reqOf(c.ev)))
    let m = st.seen.get(c.caller)
    if (!m) {
      if (st.seen.size >= CALLER_CAP) {
        for (const [k, v] of st.seen) {
          prune(v, start)
          if (v.size === 0) st.seen.delete(k)
        }
        if (st.seen.size >= CALLER_CAP) return
      }
      m = new Map()
      st.seen.set(c.caller, m)
    }
    const prev = m.get(hash)
    m.set(hash, Math.max(prev ?? 0, start))
    if (m.size > PER_CALLER) prune(m, start)
    if (m.size > PER_CALLER) m.delete(m.keys().next().value as string)
    if (prev === undefined) return
    const gap = Math.abs(start - prev)
    if (gap > DUP_WINDOW_MS) return
    let ent = st.entities.get(c.entityKey)
    if (!ent) {
      ent = { routes: new MinuteCounter(), pairs: [] }
      st.entities.set(c.entityKey, ent)
    }
    ent.routes.bump(c.route, c.sec)
    ent.pairs.unshift({
      at: new Date(c.ev.at).toISOString(),
      route: c.route,
      caller: c.caller,
      gap_ms: Math.round(gap)
    })
    if (ent.pairs.length > PAIRS) ent.pairs.pop()
    if (st.secondAt !== c.sec) {
      st.second.clear()
      st.secondAt = c.sec
    }
    st.second.set(c.entityKey, (st.second.get(c.entityKey) ?? 0) + 1)
    if (c.event) c.event.tags = [...(c.event.tags ?? []), 'duplicate']
  },
  frame(sec) {
    const st = state()
    if (st.secondAt !== sec || st.second.size === 0) return undefined
    const out = Object.fromEntries(st.second)
    st.second.clear()
    return out
  },
  entitySnapshot(entityKey, windowS, sec) {
    const ent = state().entities.get(entityKey)
    if (!ent) return undefined
    const routes = ent.routes.top(windowS, sec, 5).map(([route, n]) => ({ route, n }))
    const n = routes.reduce((a, r) => a + r.n, 0)
    if (!n) return undefined
    const since = (sec - windowS) * 1000
    return { n, routes, pairs: ent.pairs.filter((p) => Date.parse(p.at) >= since) }
  },
  sweep(sec) {
    const st = state()
    for (const [k, v] of st.seen) {
      prune(v, sec * 1000)
      if (v.size === 0) st.seen.delete(k)
    }
    for (const [k, e] of st.entities) {
      e.routes.sweep(sec)
      if (e.routes.size === 0) st.entities.delete(k)
    }
  }
}
tap.entityDetail = (key, windowS, sec) => tap.entitySnapshot?.(key, windowS, sec)
registerTrafficTap(tap)

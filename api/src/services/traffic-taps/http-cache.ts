/**
 * #2196 — HTTP caching per route (report only; no header is changed). For every successful GET
 * (200 / 304) it counts, per route template: responses, 304 Not Modified (a browser cache hit
 * the server revalidated), conditional requests (If-None-Match / If-Modified-Since), and which
 * cache headers the response carried (Cache-Control, no-store, a positive max-age, ETag,
 * Last-Modified). The route lists them and flags busy routes that send none.
 *
 * Bounded: ROUTE_CAP routes (then new routes are not counted until the hourly sweep frees idle
 * ones), each a per-minute counter over the 15-minute ring. No frame figures.
 */

import { MinuteCounter } from '../traffic-ring.js'
import { CACHE_SLOTS, type CacheRouteRow, cacheHeaderFacts } from '../traffic-security.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { headerOf, reqOf } from './req-facts.js'

export const HTTP_CACHE_TAP = 'http-cache'
const ROUTE_CAP = 300
const SEEN_CAP = 5000
const REPEAT_S = 60

interface State {
  routes: Map<string, MinuteCounter>
  /** `caller|url` → the second it was last fetched (least recently fetched dropped first). */
  seen: Map<string, number>
}
const state = (): State =>
  tapState<State>(HTTP_CACHE_TAP, () => ({ routes: new Map(), seen: new Map() }))

function replyHeader(reply: unknown, name: string): string | null {
  const r = reply as { getHeader?: (n: string) => unknown } | null | undefined
  let v: unknown
  try {
    v = r?.getHeader?.(name)
  } catch {
    return null
  }
  if (Array.isArray(v)) v = v[0]
  return v == null ? null : String(v)
}

/** Count one GET (exported for tests). */
export function noteCacheFacts(f: {
  route: string
  /** `caller|url` (with the query) — the same caller fetching the same URL again is a repeat. */
  fetchKey: string
  sec: number
  status: number
  conditional: boolean
  cacheControl: string | null
  etag: string | null
  lastModified: string | null
}): void {
  const st = state()
  let m = st.routes.get(f.route)
  if (!m) {
    if (st.routes.size >= ROUTE_CAP) return
    m = new MinuteCounter(CACHE_SLOTS.length)
    st.routes.set(f.route, m)
  }
  m.bump('n', f.sec)
  const prev = st.seen.get(f.fetchKey)
  if (prev != null) {
    st.seen.delete(f.fetchKey)
    if (f.sec - prev <= REPEAT_S) m.bump('repeat', f.sec)
  } else if (st.seen.size >= SEEN_CAP) {
    const oldest = st.seen.keys().next().value
    if (oldest !== undefined) st.seen.delete(oldest)
  }
  st.seen.set(f.fetchKey, f.sec)
  if (f.status === 304) m.bump('not_modified', f.sec)
  if (f.conditional) m.bump('conditional', f.sec)
  const h = cacheHeaderFacts(f)
  if (h.cache_control) m.bump('cache_control', f.sec)
  if (h.no_store) m.bump('no_store', f.sec)
  if (h.max_age) m.bump('max_age', f.sec)
  if (h.etag) m.bump('etag', f.sec)
  if (h.last_modified) m.bump('last_modified', f.sec)
}

/** Every counted route over the window. */
export function cacheRows(windowS: number, sec: number): CacheRouteRow[] {
  const out: CacheRouteRow[] = []
  for (const [route, m] of state().routes) {
    const row = { route } as CacheRouteRow
    for (const s of CACHE_SLOTS) row[s] = m.sum(s, windowS, sec)
    if (row.n > 0) out.push(row)
  }
  return out
}

const tap: TrafficTap = {
  id: HTTP_CACHE_TAP,
  onRequest(c) {
    if (c.ev.method !== 'GET' || (c.ev.status !== 200 && c.ev.status !== 304)) return
    const r = reqOf(c.ev)
    noteCacheFacts({
      route: c.route,
      fetchKey: `${c.caller}|${(r?.raw?.url ?? r?.url ?? c.ev.path).slice(0, 300)}`,
      sec: c.sec,
      status: c.ev.status,
      conditional: headerOf(r, 'if-none-match') != null || headerOf(r, 'if-modified-since') != null,
      cacheControl: replyHeader(c.ev.reply, 'cache-control'),
      etag: replyHeader(c.ev.reply, 'etag'),
      lastModified: replyHeader(c.ev.reply, 'last-modified')
    })
  },
  sweep(sec) {
    const st = state()
    for (const [k, s] of st.seen) if (sec - s > REPEAT_S) st.seen.delete(k)
    for (const [k, m] of st.routes) {
      m.sweep(sec)
      if (m.size === 0) st.routes.delete(k)
    }
  }
}
registerTrafficTap(tap)

// api/src/services/traffic-taps/screens.ts
/**
 * Traffic Map: originating screen (#1113) and fan-out (#1116).
 *
 * Admin and efp-new send `x-nivaro-page` (the route PATTERN of the screen the request came from,
 * never ids), `x-nivaro-app` (which front end) and `x-nivaro-load` (one id per route navigation /
 * page load). The headers are untrusted: every value is normalised again here and capped, so a
 * caller cannot mint unbounded keys or smuggle an id through.
 *
 * Screens: calls per screen, per caller × screen and per entity × screen (minute counters, capped).
 * Loads: requests are grouped by load id; a load that has been quiet for LOAD_IDLE_S is finished
 * and kept (newest per screen). A screen whose load fired more than FANOUT_LIMIT calls is flagged.
 */

import {
  normalizeApp,
  normalizeLoadId,
  normalizeScreenPath,
  screenKey
} from '../traffic-client-facts.js'
import { LoadCallBuffer } from '../traffic-inspect/nav-load-buffer.js'
import { currentTrafficSec } from '../traffic-map.js'
import { MinuteCounter, registerTrafficTap, type TapRequestCtx, tapState } from '../traffic-taps.js'

export const TAP_ID = 'screens'
/** Distinct screens kept at once (then `__other__`). */
export const SCREEN_CAP = 60
/** A load that fires more calls than this is flagged. */
export const FANOUT_LIMIT = Math.max(5, Number(process.env.TRAFFIC_FANOUT_LIMIT) || 60)
/** A load with no call for this long is finished. */
export const LOAD_IDLE_S = 15
const OPEN_LOADS_CAP = 1000
const FINISHED_PER_SCREEN = 12
const ROUTES_PER_LOAD = 30

// The header normalisers live in a leaf module (the aggregator reads them for event client facts
// without loading this tap); re-exported here for the taps that already import them from screens.
export { normalizeApp, normalizeLoadId, normalizeScreenPath, screenKey }

interface OpenLoad {
  screen: string
  caller: string
  n: number
  firstSec: number
  lastSec: number
  routes: Map<string, number>
}
export interface FinishedLoad {
  n: number
  /** Epoch second the load started. */
  at: number
  /** Seconds between its first and last call. */
  span_s: number
  caller: string
  routes: Array<{ route: string; n: number }>
}
interface ScreenLoads {
  /** Newest first. */
  done: FinishedLoad[]
}
interface State {
  calls: MinuteCounter
  loads: MinuteCounter
  byCaller: MinuteCounter
  byEntity: MinuteCounter
  open: Map<string, OpenLoad>
  finished: Map<string, ScreenLoads>
  lastSweep: number
  /** #1205: the calls of each recent load (rid, route, start, ms, status), for the waterfall. */
  callLog: LoadCallBuffer
}

function state(): State {
  return tapState<State>(TAP_ID, () => ({
    calls: new MinuteCounter(SCREEN_CAP),
    loads: new MinuteCounter(SCREEN_CAP),
    byCaller: new MinuteCounter(400),
    byEntity: new MinuteCounter(400),
    open: new Map(),
    finished: new Map(),
    lastSweep: 0,
    callLog: new LoadCallBuffer()
  }))
}

function header(req: unknown, name: string): unknown {
  const h = (req as { headers?: Record<string, unknown> } | undefined)?.headers
  return h ? h[name] : undefined
}

function topRoutes(m: Map<string, number>, n = 8): Array<{ route: string; n: number }> {
  return [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([route, k]) => ({ route, n: k }))
}

function finish(s: State, id: string, l: OpenLoad): void {
  s.open.delete(id)
  let list = s.finished.get(l.screen)
  if (!list) {
    if (s.finished.size >= SCREEN_CAP * 2) {
      // Forget the screen whose newest finished load is oldest.
      let oldest: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [k, v] of s.finished) {
        const at = v.done[0]?.at ?? 0
        if (at < oldestAt) {
          oldestAt = at
          oldest = k
        }
      }
      if (oldest) s.finished.delete(oldest)
    }
    list = { done: [] }
    s.finished.set(l.screen, list)
  }
  list.done.unshift({
    n: l.n,
    at: l.firstSec,
    span_s: Math.max(0, l.lastSec - l.firstSec),
    caller: l.caller,
    routes: topRoutes(l.routes)
  })
  if (list.done.length > FINISHED_PER_SCREEN) list.done.length = FINISHED_PER_SCREEN
}

/** Finish loads quiet for LOAD_IDLE_S (at most once a second). */
export function finishIdleLoads(sec: number, force = false): void {
  const s = state()
  if (!force && sec === s.lastSweep) return
  s.lastSweep = sec
  for (const [id, l] of s.open) if (sec - l.lastSec >= LOAD_IDLE_S) finish(s, id, l)
}

export function onScreenRequest(c: TapRequestCtx): void {
  const screen = screenKey(header(c.ev.req, 'x-nivaro-app'), header(c.ev.req, 'x-nivaro-page'))
  if (!screen) return
  const s = state()
  s.calls.bump(screen, c.sec)
  s.byCaller.bump(`${c.caller}|${screen}`, c.sec)
  s.byEntity.bump(`${c.entityKey}|${screen}`, c.sec)
  finishIdleLoads(c.sec)
  const loadId = normalizeLoadId(header(c.ev.req, 'x-nivaro-load'))
  if (!loadId) return
  const rid = (c.ev.req as { requestId?: unknown } | undefined)?.requestId
  s.callLog.note(
    loadId,
    { screen, caller: c.caller, user: c.ev.userId ?? null },
    {
      rid: typeof rid === 'string' && rid ? rid.slice(0, 64) : (c.event?.rid ?? null),
      route: c.route,
      start: c.ev.at - Math.max(0, c.ev.latencyMs),
      ms: c.ev.latencyMs,
      status: c.ev.status
    }
  )
  const key = `${loadId}|${c.caller}`
  let l = s.open.get(key)
  if (l && l.screen !== screen) {
    // Same id, another screen (a header the client did not rotate): treat as a new load.
    finish(s, key, l)
    l = undefined
  }
  if (!l) {
    if (s.open.size >= OPEN_LOADS_CAP) {
      // Finish the stalest open load to make room.
      let stale: string | null = null
      let staleSec = Number.POSITIVE_INFINITY
      for (const [k, v] of s.open) {
        if (v.lastSec < staleSec) {
          staleSec = v.lastSec
          stale = k
        }
      }
      const sl = stale ? s.open.get(stale) : undefined
      if (stale && sl) finish(s, stale, sl)
    }
    l = { screen, caller: c.caller, n: 0, firstSec: c.sec, lastSec: c.sec, routes: new Map() }
    s.open.set(key, l)
    s.loads.bump(screen, c.sec)
  }
  l.n++
  l.lastSec = Math.max(l.lastSec, c.sec)
  if (l.routes.has(c.route) || l.routes.size < ROUTES_PER_LOAD)
    l.routes.set(c.route, (l.routes.get(c.route) ?? 0) + 1)
}

export interface ScreenRow {
  screen: string
  app: string | null
  path: string
  calls: number
  loads: number
  /** Calls per finished load in the window (0 = none finished). */
  avg: number
  /** The largest load seen in the window (finished or still open). */
  max: number
  over_limit: boolean
  worst: (FinishedLoad & { open?: boolean }) | null
  callers: Array<{ key: string; n: number }>
}
export interface ScreensReport {
  limit: number
  window_s: number
  screens: ScreenRow[]
  /** Screens whose worst load in the window passed the limit, worst first. */
  offenders: Array<{ screen: string; max: number; avg: number }>
  open_loads: number
}

function splitScreen(screen: string): { app: string | null; path: string } {
  const i = screen.indexOf(' ')
  return i > 0
    ? { app: screen.slice(0, i), path: screen.slice(i + 1) }
    : { app: null, path: screen }
}

/** Calls, loads and fan-out per screen over the window. */
export function screensReport(windowS: number, sec = currentTrafficSec()): ScreensReport {
  finishIdleLoads(sec, true)
  const s = state()
  const since = sec - windowS
  const callerRows = s.byCaller.top(windowS, sec, 400)
  const rows: ScreenRow[] = []
  for (const [screen, calls] of s.calls.top(windowS, sec, SCREEN_CAP)) {
    const done = (s.finished.get(screen)?.done ?? []).filter((d) => d.at >= since)
    let worst: ScreenRow['worst'] = done.reduce<FinishedLoad | null>(
      (w, d) => (!w || d.n > w.n ? d : w),
      null
    )
    for (const l of s.open.values()) {
      if (l.screen !== screen || l.firstSec < since) continue
      if (!worst || l.n > worst.n)
        worst = {
          n: l.n,
          at: l.firstSec,
          span_s: Math.max(0, l.lastSec - l.firstSec),
          caller: l.caller,
          routes: topRoutes(l.routes),
          open: true
        }
    }
    const avg = done.length ? done.reduce((a, d) => a + d.n, 0) / done.length : 0
    const max = worst?.n ?? 0
    rows.push({
      screen,
      ...splitScreen(screen),
      calls,
      loads: s.loads.sum(screen, windowS, sec),
      avg: Math.round(avg * 10) / 10,
      max,
      over_limit: max > FANOUT_LIMIT,
      worst,
      callers: callerRows
        .filter(([k]) => k.endsWith(`|${screen}`))
        .slice(0, 5)
        .map(([k, n]) => ({ key: k.slice(0, k.length - screen.length - 1), n }))
    })
  }
  return {
    limit: FANOUT_LIMIT,
    window_s: windowS,
    screens: rows,
    offenders: rows
      .filter((r) => r.over_limit)
      .sort((a, b) => b.max - a.max)
      .slice(0, 10)
      .map((r) => ({ screen: r.screen, max: r.max, avg: r.avg })),
    open_loads: s.open.size
  }
}

/** Screens a caller called from (`caller` = a caller key) or that hit an entity. */
export function screensFor(
  kind: 'caller' | 'entity',
  key: string,
  windowS: number,
  sec = currentTrafficSec()
): Array<{ screen: string; n: number }> {
  const s = state()
  const counter = kind === 'caller' ? s.byCaller : s.byEntity
  const prefix = `${key}|`
  return counter
    .top(windowS, sec, 400)
    .filter(([k]) => k.startsWith(prefix))
    .slice(0, 10)
    .map(([k, n]) => ({ screen: k.slice(prefix.length), n }))
}

/** #1205: the kept calls of one page load (null when this process no longer holds it). */
export function loadCalls(loadId: string) {
  return state().callLog.get(loadId)
}
/** #1205: the load a request belonged to, while it is kept. */
export function loadOfRequest(rid: string) {
  return state().callLog.loadOfRequest(rid)
}
/** #1205: kept loads (newest first), optionally only those matching `filter`. */
export function recentLoads(filter?: Parameters<LoadCallBuffer['list']>[0], n = 30) {
  return state().callLog.list(filter, n)
}

registerTrafficTap({
  id: TAP_ID,
  onRequest: onScreenRequest,
  entitySnapshot: (entityKey, windowS, sec) => {
    const rows = screensFor('entity', entityKey, windowS, sec)
    return rows.length ? rows : undefined
  },
  sweep: (sec) => {
    const s = state()
    finishIdleLoads(sec, true)
    s.calls.sweep(sec)
    s.loads.sweep(sec)
    s.byCaller.sweep(sec)
    s.byEntity.sweep(sec)
    for (const [k, v] of s.finished) {
      v.done = v.done.filter((d) => sec - d.at < 900)
      if (!v.done.length) s.finished.delete(k)
    }
  }
})

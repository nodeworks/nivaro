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
const SCREEN_MAX_LEN = 140
const SEGMENTS_MAX = 10

const SAFE_SEG = /^[A-Za-z0-9_.:-]{1,60}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One path segment: anything that could be an id (a digit, a uuid, an email, a token) is `:id`. */
function patternSegment(raw: string): string | null {
  let s = raw
  try {
    s = decodeURIComponent(raw)
  } catch {
    /* keep raw */
  }
  if (!s) return null
  if (s.startsWith(':')) return /^:[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(s) ? s : ':id'
  if (/\d/.test(s) || UUID.test(s) || s.includes('@') || s.length > 40) return ':id'
  return SAFE_SEG.test(s) ? s.toLowerCase() : ':id'
}

/** A screen pattern from the untrusted header: `/collections/workflows/:id`, or null. */
export function normalizeScreenPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let p = value.trim()
  if (!p || p.length > 400) return null
  const cut = p.search(/[?#]/)
  if (cut >= 0) p = p.slice(0, cut)
  if (!p.startsWith('/')) return null
  const segs: string[] = []
  for (const raw of p.split('/')) {
    if (!raw) continue
    const s = patternSegment(raw)
    if (s) segs.push(s)
    if (segs.length >= SEGMENTS_MAX) break
  }
  // Collapse repeated ids (`/:id/:id`) and cap the length.
  const out = `/${segs.filter((s, i) => !(s === ':id' && segs[i - 1] === ':id')).join('/')}`
  return out.slice(0, SCREEN_MAX_LEN)
}

/** `admin`, `efp-new`… or null when absent / not a plain slug. */
export function normalizeApp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9-]{0,23}$/.test(v) ? v : null
}

/** The screen key: `<app> <pattern>` (the app is optional). */
export function screenKey(app: unknown, page: unknown): string | null {
  const p = normalizeScreenPath(page)
  if (!p) return null
  const a = normalizeApp(app)
  return a ? `${a} ${p}` : p
}

/** A load id the client minted (random, short); anything else is ignored. */
export function normalizeLoadId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return /^[A-Za-z0-9_-]{6,40}$/.test(v) ? v : null
}

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
}

function state(): State {
  return tapState<State>(TAP_ID, () => ({
    calls: new MinuteCounter(SCREEN_CAP),
    loads: new MinuteCounter(SCREEN_CAP),
    byCaller: new MinuteCounter(400),
    byEntity: new MinuteCounter(400),
    open: new Map(),
    finished: new Map(),
    lastSweep: 0
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

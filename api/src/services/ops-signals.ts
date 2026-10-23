// api/src/services/ops-signals.ts
/**
 * Per-node signals for the `event_loop` and `route_spike` ops monitors (staging demo
 * post-mortem 2026-10-23, 4.3). During the demo every web process stalled for minutes (event-loop
 * lag 1.3–4.4 s) under a refetch storm (one route at ~40 req/s, 63% of all traffic) and nothing
 * fired. Neither signal can be judged where the monitor cron runs: the cron runs on ONE process
 * (the worker on a split deployment), the stall and the storm happen on the web processes. So
 * every API process keeps two small in-memory series and publishes a summary to Redis every 30 s
 * (`nvr:ops-signals:<instance id>`, 120 s TTL — the instance roster's pattern); the monitors read
 * every live process's summary.
 *
 * - lag: the highest event-loop lag per minute (runtime-monitor.ts's 500 ms drift sampler, the
 *   same figure /ops-runtime/runtime shows), the last LAG_MINUTES minutes.
 * - routes: requests per route template per minute (Fastify's route url, so ids never become
 *   keys) for RECENT_MINUTES + BASELINE_MINUTES minutes, at most ROUTE_CAP routes, plus the total.
 *
 * Off in cloud mode: one process serves many tenants there and neither series is kept per tenant
 * (module-level state would mix them, gotchas) — the monitors answer `unknown` instead.
 */
import { hostname } from 'node:os'
import type { Redis } from 'ioredis'
import { instanceKey } from './instance-key.js'
import { INSTANCE_ID } from './instance-roster.js'

export const LAG_MINUTES = 10
/** Index 0 is the current (partial) minute; 1… are complete minutes. */
export const RECENT_MINUTES = 7
export const BASELINE_MINUTES = 60
const ROUTE_MINUTES = RECENT_MINUTES + BASELINE_MINUTES
const ROUTE_CAP = 600
const PUBLISH_TOP = 40
const PUBLISH_MS = 30_000
const KEY_PREFIX = 'nvr:ops-signals:'
const TTL_S = 120
/** A summary older than this is a process that stopped publishing. */
const STALE_MS = 150_000

export const minuteOf = (ms: number): number => Math.floor(ms / 60_000)

/** A per-minute ring: `m` = the minute a slot holds, `v` = its value. */
interface MinuteRing {
  m: Float64Array
  v: Float64Array
}
function ring(n: number): MinuteRing {
  return { m: new Float64Array(n).fill(-1), v: new Float64Array(n) }
}
function slotOf(r: MinuteRing, minute: number): number {
  const n = r.m.length
  const i = ((minute % n) + n) % n
  if (r.m[i] !== minute) {
    r.m[i] = minute
    r.v[i] = 0
  }
  return i
}
function valueAt(r: MinuteRing, minute: number): number {
  const n = r.m.length
  const i = ((minute % n) + n) % n
  return r.m[i] === minute ? r.v[i] : 0
}
function hasMinute(r: MinuteRing, minute: number): boolean {
  const n = r.m.length
  return r.m[((minute % n) + n) % n] === minute
}

export interface RouteSignal {
  /** Requests per minute, index 0 = the current (partial) minute, then complete minutes. */
  recent: number[]
  /** Requests over the BASELINE_MINUTES minutes before the recent ones. */
  baseline: number
}

export interface NodeSignals {
  v: 1
  id: string
  /** `<instance> · <host>` — the delivery SLO's node label. */
  node: string
  role: string | null
  at: number
  minute: number
  /** Whole minutes this process has been counting. */
  history_minutes: number
  /** Highest event-loop lag (ms) per minute, index 0 = current minute; -1 = no sample. */
  lag: number[]
  total: RouteSignal
  routes: Array<RouteSignal & { route: string }>
}

/** One process's series. A class so tests can run several "nodes" side by side. */
export class SignalBook {
  readonly startedMinute: number
  private lag = ring(LAG_MINUTES)
  private total = ring(ROUTE_MINUTES)
  private routes = new Map<string, MinuteRing>()

  constructor(now: number = Date.now()) {
    this.startedMinute = minuteOf(now)
  }

  noteLag(ms: number, at: number = Date.now()): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const i = slotOf(this.lag, minuteOf(at))
    if (ms > this.lag.v[i]) this.lag.v[i] = ms
  }

  noteRequest(route: string, at: number = Date.now()): void {
    const minute = minuteOf(at)
    this.total.v[slotOf(this.total, minute)]++
    let r = this.routes.get(route)
    if (!r) {
      if (this.routes.size >= ROUTE_CAP && !this.evictIdle(minute)) return
      r = ring(ROUTE_MINUTES)
      this.routes.set(route, r)
    }
    r.v[slotOf(r, minute)]++
  }

  /** Drop one route with nothing in the window; false when every route is still live. */
  private evictIdle(minute: number): boolean {
    for (const [k, r] of this.routes) {
      let live = false
      for (let i = 0; i < ROUTE_MINUTES && !live; i++) live = r.m[i] > minute - ROUTE_MINUTES
      if (!live) {
        this.routes.delete(k)
        return true
      }
    }
    return false
  }

  private signalOf(r: MinuteRing, minute: number): RouteSignal {
    const recent = Array.from({ length: RECENT_MINUTES }, (_, k) => valueAt(r, minute - k))
    let baseline = 0
    for (let k = RECENT_MINUTES; k < ROUTE_MINUTES; k++) baseline += valueAt(r, minute - k)
    return { recent, baseline }
  }

  summary(now: number = Date.now()): NodeSignals {
    const minute = minuteOf(now)
    const lag = Array.from({ length: LAG_MINUTES }, (_, k) =>
      hasMinute(this.lag, minute - k) ? Math.round(valueAt(this.lag, minute - k)) : -1
    )
    const routes = [...this.routes]
      .map(([route, r]) => ({ route, ...this.signalOf(r, minute) }))
      .filter((r) => r.recent.some((n) => n > 0))
      .sort((a, b) => sumComplete(b.recent) - sumComplete(a.recent))
      .slice(0, PUBLISH_TOP)
    return {
      v: 1,
      id: INSTANCE_ID,
      node: `${instanceKey()} · ${hostname().slice(0, 40)}`,
      role: process.env.NIVARO_ROLE?.trim() || null,
      at: now,
      minute,
      history_minutes: Math.max(0, minute - this.startedMinute),
      lag,
      total: this.signalOf(this.total, minute),
      routes
    }
  }
}

function sumComplete(recent: number[]): number {
  let s = 0
  for (let k = 1; k < recent.length; k++) s += recent[k]
  return s
}

// ─── This process ──────────────────────────────────────────────────────────────

const cloud = (): boolean => !!process.env.CLOUD_META_DB_URL
let book: SignalBook | null = null
let timer: ReturnType<typeof setInterval> | null = null
let redisRef: Redis | null = null

/** The runtime monitor's sampler hands every lag sample here (no-op until started). */
export function noteLagSample(ms: number, at: number = Date.now()): void {
  book?.noteLag(ms, at)
}

/** `GET /api/items/:collection` — Fastify's route url; a request no route matched keeps its template. */
export function routeKeyOf(
  ev: { method: string; path: string; req?: unknown },
  fallback: (method: string, path: string) => string
): string {
  const url = (ev.req as { routeOptions?: { url?: unknown } } | undefined)?.routeOptions?.url
  const method = String(ev.method || 'GET').toUpperCase()
  if (typeof url === 'string' && url) return `${method} ${url}`.slice(0, 200)
  return fallback(method, ev.path).slice(0, 200)
}

async function publish(): Promise<void> {
  if (!redisRef || !book) return
  try {
    await redisRef.set(`${KEY_PREFIX}${INSTANCE_ID}`, JSON.stringify(book.summary()), 'EX', TTL_S)
  } catch {
    /* the next beat retries */
  }
}

/** Boot: count this process's requests and lag, publish every 30 s. Never in cloud mode. */
export async function startOpsSignals(redis: Redis | null): Promise<void> {
  if (cloud() || book) return
  book = new SignalBook()
  redisRef = redis
  const [{ onRequestNoted }, { routeTemplate }] = await Promise.all([
    import('./traffic-map.js'),
    import('./traffic-entities.js')
  ])
  onRequestNoted((ev) => {
    book?.noteRequest(
      routeKeyOf(ev, (m, p) => routeTemplate(m, p)),
      ev.at
    )
  })
  if (!timer && redis) {
    timer = setInterval(() => void publish(), PUBLISH_MS)
    timer.unref()
    setTimeout(() => void publish(), 5_000).unref()
  }
}

/** Every live process's latest summary (empty without Redis). */
export async function readNodeSignals(
  redis: Redis | null,
  now: number = Date.now()
): Promise<NodeSignals[]> {
  if (!redis) return []
  try {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100)
      cursor = next
      keys.push(...batch)
    } while (cursor !== '0' && keys.length < 200)
    if (keys.length === 0) return []
    const vals = await redis.mget(keys)
    const out: NodeSignals[] = []
    for (const v of vals) {
      if (!v) continue
      try {
        const s = JSON.parse(v) as NodeSignals
        if (s?.v === 1 && Array.isArray(s.lag) && now - Number(s.at) <= STALE_MS) out.push(s)
      } catch {
        /* a torn value is skipped */
      }
    }
    return out.sort((a, b) => a.node.localeCompare(b.node))
  } catch {
    return []
  }
}

// ─── Verdicts (pure) ───────────────────────────────────────────────────────────

export interface SignalVerdict {
  status: 'ok' | 'failing' | 'unknown'
  detail: string
  metric?: number
}

const clampInt = (v: unknown, d: number, lo: number, hi: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, n)) : d
}
const posNum = (v: unknown, d: number, lo = 0): number => {
  const n = Number(v)
  return v !== null && v !== '' && Number.isFinite(n) && n >= lo ? n : d
}

export interface EventLoopConfig {
  /** A minute breaches when its highest lag sample is above this (ms). */
  threshold_ms: number
  /** Breaching minutes inside one window that make the node fail. */
  breach_minutes: number
  /** Window length in minutes. */
  window_minutes: number
}

export const EVENT_LOOP_DEFAULTS: EventLoopConfig = {
  threshold_ms: 1000,
  breach_minutes: 3,
  window_minutes: 5
}

export function normalizeEventLoopConfig(cfg: Record<string, unknown>): EventLoopConfig {
  const window_minutes = clampInt(cfg.window_minutes, EVENT_LOOP_DEFAULTS.window_minutes, 1, 8)
  return {
    threshold_ms: posNum(cfg.threshold_ms, EVENT_LOOP_DEFAULTS.threshold_ms, 50),
    breach_minutes: clampInt(
      cfg.breach_minutes,
      Math.min(EVENT_LOOP_DEFAULTS.breach_minutes, window_minutes),
      1,
      window_minutes
    ),
    window_minutes
  }
}

/**
 * Event-loop stall: a node fails when `breach_minutes` of any `window_minutes` consecutive
 * complete minutes peaked above `threshold_ms`. Every complete minute the summary holds is
 * searched (sliding), so a stall between two 5-minute monitor runs is still caught.
 */
export function judgeEventLoop(nodes: NodeSignals[], raw: Record<string, unknown>): SignalVerdict {
  const cfg = normalizeEventLoopConfig(raw)
  if (nodes.length === 0)
    return {
      status: 'unknown',
      detail:
        'No API process has published signals yet (needs Redis; each process publishes 30 s after boot)'
    }
  const rows = nodes.map((n) => {
    const complete = n.lag.slice(1)
    let best = 0
    for (let start = 0; start + cfg.window_minutes <= complete.length; start++) {
      let breaches = 0
      for (let k = start; k < start + cfg.window_minutes; k++)
        if (complete[k] > cfg.threshold_ms) breaches++
      if (breaches > best) best = breaches
    }
    const worst = Math.max(0, ...complete)
    return { node: n.node, role: n.role, best, worst, failing: best >= cfg.breach_minutes }
  })
  const worstAll = Math.max(0, ...rows.map((r) => r.worst))
  const label = (r: (typeof rows)[number]) => `${r.node}${r.role ? ` (${r.role})` : ''}`
  const failing = rows.filter((r) => r.failing)
  if (failing.length) {
    return {
      status: 'failing',
      metric: worstAll,
      detail: [
        `Event loop stalled on ${failing.length} of ${rows.length} API process${
          rows.length === 1 ? '' : 'es'
        }: lag above ${cfg.threshold_ms} ms in ${cfg.breach_minutes}+ of ${cfg.window_minutes} minutes.`,
        ...rows.map(
          (r) =>
            `  ${label(r)}: ${r.best} of ${cfg.window_minutes} minutes over, worst ${r.worst} ms${
              r.failing ? ' ← stalled' : ''
            }`
        ),
        'Requests on a stalled process wait for the loop: look for a hot route (route-rate monitor, Traffic Map) or a synchronous step (Health → Telemetry → Slowest requests).'
      ].join('\n')
    }
  }
  return {
    status: 'ok',
    metric: worstAll,
    detail: `Event loop healthy on ${rows.length} process${rows.length === 1 ? '' : 'es'} (worst minute ${worstAll} ms, limit ${cfg.threshold_ms} ms)`
  }
}

export interface RouteSpikeConfig {
  /** The route's rate must reach this multiple of its trailing-hour rate. */
  factor: number
  /** …and at least this many requests per second across all processes. */
  min_rps: number
  /** Consecutive complete minutes the jump must hold. */
  sustain_minutes: number
  /**
   * The route's share of ALL requests must have grown this many times (0 = off). A morning
   * sign-in wave raises every route together and keeps shares; a refetch storm makes one route
   * swallow the traffic.
   */
  share_factor: number
  /** A process joins the comparison after this many minutes of history (fresh replicas have no hour). */
  min_history_minutes: number
  /** Optional absolute ceiling: any route above this many req/s fails, whatever its history. */
  ceiling_rps: number | null
}

/**
 * Sized for ~250 people online (≈120 req/s in total): a single route only counts at 20 req/s or
 * more — a sixth of all traffic — and only when it is five times its own trailing hour AND has
 * doubled its share of all requests, for two minutes in a row.
 */
export const ROUTE_SPIKE_DEFAULTS: RouteSpikeConfig = {
  factor: 5,
  min_rps: 20,
  sustain_minutes: 2,
  share_factor: 2,
  min_history_minutes: 15,
  ceiling_rps: null
}

export function normalizeRouteSpikeConfig(cfg: Record<string, unknown>): RouteSpikeConfig {
  const d = ROUTE_SPIKE_DEFAULTS
  const ceiling = Number(cfg.ceiling_rps)
  return {
    factor: posNum(cfg.factor, d.factor, 1),
    min_rps: posNum(cfg.min_rps, d.min_rps, 0.1),
    sustain_minutes: clampInt(cfg.sustain_minutes, d.sustain_minutes, 1, RECENT_MINUTES - 1),
    share_factor: posNum(cfg.share_factor, d.share_factor, 0),
    min_history_minutes: clampInt(
      cfg.min_history_minutes,
      d.min_history_minutes,
      RECENT_MINUTES,
      ROUTE_MINUTES
    ),
    ceiling_rps:
      cfg.ceiling_rps != null && cfg.ceiling_rps !== '' && Number.isFinite(ceiling) && ceiling > 0
        ? ceiling
        : null
  }
}

/** Minutes of baseline a node can show (its history minus the recent window, ≤ the hour). */
function baselineMinutes(n: NodeSignals): number {
  return Math.min(BASELINE_MINUTES, Math.max(0, n.history_minutes - (RECENT_MINUTES - 1)))
}

interface RouteFigures {
  route: string
  /** req/s per complete minute, index 0 = the newest complete minute. */
  rps: number[]
  baselineRps: number
  shareNow: number[]
  shareBefore: number
}

function figuresFor(nodes: NodeSignals[]): RouteFigures[] {
  const complete = RECENT_MINUTES - 1
  const totalNow = new Array<number>(complete).fill(0)
  let totalBase = 0
  const routes = new Map<string, { now: number[]; base: number }>()
  for (const n of nodes) {
    const bm = baselineMinutes(n)
    for (let k = 0; k < complete; k++) totalNow[k] += n.total.recent[k + 1] ?? 0
    if (bm > 0) totalBase += n.total.baseline / (bm * 60)
    for (const r of n.routes) {
      const acc = routes.get(r.route) ?? { now: new Array<number>(complete).fill(0), base: 0 }
      for (let k = 0; k < complete; k++) acc.now[k] += r.recent[k + 1] ?? 0
      if (bm > 0) acc.base += r.baseline / (bm * 60)
      routes.set(r.route, acc)
    }
  }
  return [...routes].map(([route, a]) => {
    const rps = a.now.map((c) => c / 60)
    return {
      route,
      rps,
      baselineRps: a.base,
      shareNow: a.now.map((c, k) => (totalNow[k] > 0 ? c / totalNow[k] : 0)),
      shareBefore: totalBase > 0 ? a.base / totalBase : 0
    }
  })
}

/** The newest run of `len` consecutive complete minutes where `ok(k)` holds, or null. */
function sustainedRun(len: number, total: number, ok: (k: number) => boolean): number | null {
  for (let start = 0; start + len <= total; start++) {
    let all = true
    for (let k = start; k < start + len && all; k++) all = ok(k)
    if (all) return start
  }
  return null
}

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * Route-rate jump: a route over `factor` × its trailing-hour rate and over `min_rps` (summed
 * across processes) for `sustain_minutes` complete minutes, its share of all requests grown by
 * `share_factor` — or over `ceiling_rps` at all. Processes younger than `min_history_minutes`
 * stay out of the jump comparison (no hour to compare against) but count toward the ceiling.
 */
export function judgeRouteSpike(nodes: NodeSignals[], raw: Record<string, unknown>): SignalVerdict {
  const cfg = normalizeRouteSpikeConfig(raw)
  if (nodes.length === 0)
    return {
      status: 'unknown',
      detail:
        'No API process has published signals yet (needs Redis; each process publishes 30 s after boot)'
    }
  const complete = RECENT_MINUTES - 1
  const eligible = nodes.filter((n) => n.history_minutes >= cfg.min_history_minutes)
  const hits: Array<{ route: string; rps: number; line: string }> = []

  for (const f of figuresFor(eligible)) {
    const at = sustainedRun(cfg.sustain_minutes, complete, (k) => {
      const rps = f.rps[k]
      if (rps < cfg.min_rps || rps < cfg.factor * f.baselineRps) return false
      return cfg.share_factor <= 0 || f.shareNow[k] >= cfg.share_factor * f.shareBefore
    })
    if (at == null) continue
    const peak = Math.max(...f.rps.slice(at, at + cfg.sustain_minutes))
    hits.push({
      route: f.route,
      rps: peak,
      line: `${f.route}: ${r1(peak)} req/s (trailing hour ${r1(f.baselineRps)} req/s, ${
        f.baselineRps > 0 ? `${r1(peak / f.baselineRps)}×` : 'new'
      }; ${Math.round(f.shareNow[at] * 100)}% of all requests, was ${Math.round(f.shareBefore * 100)}%)`
    })
  }
  if (cfg.ceiling_rps != null) {
    for (const f of figuresFor(nodes)) {
      if (hits.some((h) => h.route === f.route)) continue
      const at = sustainedRun(
        cfg.sustain_minutes,
        complete,
        (k) => f.rps[k] >= (cfg.ceiling_rps as number)
      )
      if (at == null) continue
      const peak = Math.max(...f.rps.slice(at, at + cfg.sustain_minutes))
      hits.push({
        route: f.route,
        rps: peak,
        line: `${f.route}: ${r1(peak)} req/s, over the ${cfg.ceiling_rps} req/s ceiling`
      })
    }
  }

  const all = figuresFor(nodes)
  const busiest = all.reduce<RouteFigures | null>(
    (b, f) => (b == null || f.rps[0] > b.rps[0] ? f : b),
    null
  )
  const young = nodes.length - eligible.length
  const youngNote =
    young > 0
      ? ` ${young} process${young === 1 ? '' : 'es'} younger than ${cfg.min_history_minutes} minutes left out of the comparison.`
      : ''
  if (hits.length) {
    hits.sort((a, b) => b.rps - a.rps)
    return {
      status: 'failing',
      metric: r1(hits[0].rps),
      detail: [
        `Request rate jumped on ${hits.length} route${hits.length === 1 ? '' : 's'} (all API processes together):`,
        ...hits.slice(0, 8).map((h) => `  ${h.line}`),
        `Rule: over ${cfg.factor}× the trailing hour and ${cfg.min_rps} req/s for ${cfg.sustain_minutes} minute${
          cfg.sustain_minutes === 1 ? '' : 's'
        }${cfg.share_factor > 0 ? `, share of all requests ×${cfg.share_factor}` : ''}.${youngNote}`
      ].join('\n')
    }
  }
  if (eligible.length === 0 && cfg.ceiling_rps == null)
    return {
      status: 'unknown',
      detail: `Collecting history: every API process is younger than ${cfg.min_history_minutes} minutes`
    }
  return {
    status: 'ok',
    metric: busiest ? r1(busiest.rps[0]) : 0,
    detail: `No route jumped${
      busiest ? ` (busiest ${busiest.route} at ${r1(busiest.rps[0])} req/s)` : ''
    }.${youngNote}`
  }
}

// ─── Monitor entry points ─────────────────────────────────────────────────────

const CLOUD_DETAIL =
  'Not available in cloud mode: process signals are shared by every tenant on a process and are not kept per tenant'

async function appRedis(): Promise<Redis | null> {
  try {
    const { getApp } = await import('./io-holder.js')
    return (getApp()?.redis as Redis | undefined) ?? null
  } catch {
    return null
  }
}

export async function evalEventLoop(cfg: Record<string, unknown>): Promise<SignalVerdict> {
  if (cloud()) return { status: 'unknown', detail: CLOUD_DETAIL }
  return judgeEventLoop(await readNodeSignals(await appRedis()), cfg)
}

export async function evalRouteSpike(cfg: Record<string, unknown>): Promise<SignalVerdict> {
  if (cloud()) return { status: 'unknown', detail: CLOUD_DETAIL }
  return judgeRouteSpike(await readNodeSignals(await appRedis()), cfg)
}

/** Tests only. */
export function _resetOpsSignalsForTests(): void {
  book = null
  if (timer) clearInterval(timer)
  timer = null
  redisRef = null
}

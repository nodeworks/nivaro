// api/src/services/traffic-baselines.ts
/**
 * Traffic Map baselines (#2145): "normal for this hour on this weekday" for every node and edge.
 *
 * ROLL-UPS. One roll-up per clock hour (UTC epoch hour `h`): per key the hour's requests, errors,
 * p50 and p95. Keys:
 *   n:<lane>/<entity>              an entity node (the map's own classification)
 *   c:<caller>                     a caller node
 *   e:<caller>><lane>/<entity>     a caller → entity edge (the busiest EDGE_CAP)
 *   d:ext:<apiId>                  a partner node (from the outbound call log)
 *   t                              every classified request
 *   p                              people: [distinct users in the hour, mean distinct per 15 min]
 * An hour is rolled up from nivaro_api_logs (deployed instances only, like every log reader) once
 * it is complete, and kept in Redis for ROLLUP_TTL_DAYS (hash `nvr:tm:roll:<store>:<h>`, one
 * field per key, `_` marks the hour as known). The request log only keeps 14 days, so weeks three
 * and four exist only because the hourly cron rolled them up while they were still there. Without
 * Redis the roll-ups live in a bounded per-store memory cache.
 *
 * BANDS. The band for a key at hour h is learned from the same weekday and hour over the last
 * WEEKS weeks plus the hour either side (up to 12 sample hours): the median, and a spread of
 * 1.4826 × MAD (never below a per-metric floor); lo/hi = median ∓ 2 spreads. Requests are a rate
 * per minute (an hour with no traffic for a key counts as 0); error rate and p95 only count hours
 * with enough requests to mean something.
 *
 * `scoreAgainstBaseline()` is pure and shared by everything judged against a band (health score,
 * what changed, deploy check, executive summary). Its client twin lives in
 * admin/src/pages/traffic-map/features/baselines/score.ts — change both.
 */
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { instanceScope } from './api-log-instances.js'
import { getApp } from './io-holder.js'
import { callerKeyFor, classifyRequest, entityKey } from './traffic-entities.js'
import { matchExtensionRoute } from './traffic-map.js'
import { currentStoreId, DEFAULT_STORE, tapState } from './traffic-taps.js'

export const HOUR_S = 3600
export const WEEK_H = 168
export const WEEKS = 4
/** Neighbouring hours sampled on each side of the slot. */
export const NEIGHBOUR_H = 1
export const RAW_RETENTION_DAYS = 14
export const ROLLUP_TTL_DAYS = 29
/** Rows read for one hour at most (the roll-up says when it was cut). */
export const ROLLUP_ROW_CAP = 150_000
export const EDGE_CAP = 300
export const CALLER_CAP = 200
export const NODE_CAP = 600
const LAT_CAP = 4000
/** Error rate / p95 samples need at least this many requests in the hour. */
export const MIN_ERR_REQ = 10
export const MIN_LAT_REQ = 5
/** A band needs this many known sample hours. */
export const MIN_SAMPLES = 3
const BASELINE_TAP = 'baselines'

/** [requests, errors, p50 ms, p95 ms] */
export type Cell = [number, number, number, number]
export type HourCells = Map<string, Cell>

export interface LogRowLite {
  method: string
  path: string
  status: number
  latency_ms: number
  auth?: string | null
  api_key_id?: number | null
  user?: string | null
  graphql_operation?: string | null
  graphql_kind?: string | null
  created_at?: Date | string
}

export function epochHour(ms: number): number {
  return Math.floor(ms / 1000 / HOUR_S)
}

function pct(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))])
}

interface Acc {
  n: number
  e: number
  lat: number[]
}
function bump(m: Map<string, Acc>, key: string, isErr: boolean, ms: number): void {
  let a = m.get(key)
  if (!a) {
    a = { n: 0, e: 0, lat: [] }
    m.set(key, a)
  }
  a.n++
  if (isErr) a.e++
  if (Number.isFinite(ms)) {
    if (a.lat.length < LAT_CAP) a.lat.push(ms)
    else a.lat[a.n % LAT_CAP] = ms
  }
}
function toCell(a: Acc): Cell {
  const s = a.lat.sort((x, y) => x - y)
  return [a.n, a.e, pct(s, 0.5), pct(s, 0.95)]
}

/**
 * Fold request-log rows into one hour's cells (pure). Classification is the live map's, so the
 * keys are the node ids the page draws. Edges keep the busiest EDGE_CAP, callers CALLER_CAP,
 * nodes NODE_CAP.
 */
export function rollupRows(
  rows: LogRowLite[],
  matchExt: (method: string, path: string) => string | null = matchExtensionRoute
): HourCells {
  const nodes = new Map<string, Acc>()
  const callers = new Map<string, Acc>()
  const edges = new Map<string, Acc>()
  const total = new Map<string, Acc>()
  const users = new Set<string>()
  const quarters = new Map<number, Set<string>>()
  for (const r of rows) {
    let c = classifyRequest({
      method: r.method,
      path: r.path,
      graphqlOperation: r.graphql_operation,
      graphqlKind: r.graphql_kind
    })
    if (c?.lane === 'other') {
      const ext = matchExt(r.method, r.path)
      if (ext)
        c = classifyRequest({
          method: r.method,
          path: r.path,
          graphqlOperation: r.graphql_operation,
          graphqlKind: r.graphql_kind,
          extensionId: ext
        })
    }
    if (!c) continue
    const isErr = Number(r.status) >= 400
    const ms = Number(r.latency_ms)
    const key = entityKey(c.lane, c.entity)
    const caller = callerKeyFor({
      authMethod: r.auth ?? null,
      apiKeyId: r.api_key_id ?? null,
      userId: r.user ?? null
    })
    bump(nodes, key, isErr, ms)
    bump(callers, caller, isErr, ms)
    bump(edges, `${caller}>${key}`, isErr, ms)
    bump(total, 't', isErr, ms)
    if (r.user) {
      const u = String(r.user).toUpperCase()
      users.add(u)
      if (r.created_at != null) {
        const q = Math.floor(new Date(r.created_at).getTime() / 900_000)
        let s = quarters.get(q)
        if (!s) {
          s = new Set()
          quarters.set(q, s)
        }
        s.add(u)
      }
    }
  }
  const out: HourCells = new Map()
  const top = (m: Map<string, Acc>, cap: number) =>
    [...m].sort((a, b) => b[1].n - a[1].n).slice(0, cap)
  for (const [k, a] of top(nodes, NODE_CAP)) out.set(`n:${k}`, toCell(a))
  for (const [k, a] of top(callers, CALLER_CAP)) out.set(`c:${k}`, toCell(a))
  for (const [k, a] of top(edges, EDGE_CAP)) out.set(`e:${k}`, toCell(a))
  const t = total.get('t')
  if (t) out.set('t', toCell(t))
  if (users.size) {
    const qs = [...quarters.values()].map((s) => s.size)
    const meanQ = qs.length ? qs.reduce((a, b) => a + b, 0) / qs.length : users.size
    out.set('p', [users.size, Math.round(meanQ * 10) / 10, 0, 0])
  }
  return out
}

// ── storage ─────────────────────────────────────────────────────────────────

interface RedisLike {
  pipeline(): {
    hgetall(k: string): unknown
    hmget(k: string, ...f: string[]): unknown
    hset(k: string, v: Record<string, string>): unknown
    expireat(k: string, t: number): unknown
    exec(): Promise<Array<[Error | null, unknown]> | null>
  }
}
let redisOverride: RedisLike | null | undefined
/** Tests: a fake Redis (null = none). */
export function setBaselineRedisForTest(r: RedisLike | null | undefined): void {
  redisOverride = r
}
function redis(): RedisLike | null {
  if (redisOverride !== undefined) return redisOverride
  const r = (getApp() as { redis?: RedisLike } | null)?.redis
  return r && typeof r.pipeline === 'function' ? r : null
}

export function rollupKey(store: string, h: number): string {
  return `nvr:tm:roll:${store}:${h}`
}
export function encodeCell(c: Cell): string {
  return c.map((v) => Math.round(v * 10) / 10).join(',')
}
export function decodeCell(s: unknown): Cell | null {
  if (typeof s !== 'string' || !s) return null
  const p = s.split(',').map(Number)
  if (p.length < 4 || p.some((v) => !Number.isFinite(v))) return null
  return [p[0], p[1], p[2], p[3]]
}

interface StoreState {
  /** Recently used hours (LRU by insertion order). */
  mem: Map<number, HourCells>
  inflight: Map<number, Promise<HourCells | null>>
  baseline: { h: number; at: number; data: Baselines } | null
  baselinePromise: Promise<Baselines> | null
}
const st = (): StoreState =>
  tapState<StoreState>(BASELINE_TAP, () => ({
    mem: new Map(),
    inflight: new Map(),
    baseline: null,
    baselinePromise: null
  }))

function memCap(): number {
  return redis() ? 72 : 400
}
function remember(h: number, cells: HourCells): void {
  const s = st()
  s.mem.delete(h)
  s.mem.set(h, cells)
  while (s.mem.size > memCap()) {
    const first = s.mem.keys().next().value
    if (first === undefined) break
    s.mem.delete(first)
  }
}

/** Store id for Redis keys (self-hosted: `default`). */
function storeId(): string {
  return currentStoreId() || DEFAULT_STORE
}

async function writeRedis(h: number, cells: HourCells, meta: string): Promise<void> {
  const r = redis()
  if (!r) return
  const key = rollupKey(storeId(), h)
  const fields: Record<string, string> = { _: meta }
  for (const [k, c] of cells) fields[k] = encodeCell(c)
  try {
    const p = r.pipeline()
    p.hset(key, fields)
    p.expireat(key, h * HOUR_S + ROLLUP_TTL_DAYS * 86_400)
    await p.exec()
  } catch {
    /* Redis down: the memory copy still answers this process */
  }
}

/** Whole hours from Redis (null entries = not rolled up there). */
async function readRedisHours(hs: number[]): Promise<Map<number, HourCells | null>> {
  const out = new Map<number, HourCells | null>()
  const r = redis()
  if (!r || !hs.length) return out
  try {
    const p = r.pipeline()
    for (const h of hs) p.hgetall(rollupKey(storeId(), h))
    const res = (await p.exec()) ?? []
    hs.forEach((h, i) => {
      const obj = res[i]?.[1] as Record<string, string> | null | undefined
      if (!obj || obj._ === undefined) {
        out.set(h, null)
        return
      }
      const cells: HourCells = new Map()
      for (const [k, v] of Object.entries(obj)) {
        if (k === '_') continue
        const c = decodeCell(v)
        if (c) cells.set(k, c)
      }
      out.set(h, cells)
    })
  } catch {
    /* unreadable: treated as not rolled up */
  }
  return out
}

/** Is hour h complete and still inside the request log's retention? */
export function computable(h: number, nowMs = Date.now()): boolean {
  const cur = epochHour(nowMs)
  const oldest = epochHour(nowMs - RAW_RETENTION_DAYS * 86_400_000) + 1
  return h < cur && h >= oldest
}

async function logColumns(): Promise<string[]> {
  // Asked every time: hasColumn caches per tenant, and in cloud one tenant's schema must never
  // decide another's.
  const gqlCols = await hasColumn('nivaro_api_logs', 'graphql_operation').catch(() => false)
  const base = [
    'method',
    'path',
    'status',
    'latency_ms',
    'auth',
    'api_key_id',
    'user',
    'created_at'
  ]
  return gqlCols ? [...base, 'graphql_operation', 'graphql_kind'] : base
}

/** Request-log rows in [fromMs, toMs) for deployed instances, at most `cap`. */
export async function readLogRows(
  fromMs: number,
  toMs: number,
  cap = ROLLUP_ROW_CAP
): Promise<LogRowLite[]> {
  const sc = await instanceScope({})
  const q = db('nivaro_api_logs')
    .where('created_at', '>=', new Date(fromMs))
    .where('created_at', '<', new Date(toMs))
    .limit(cap)
    .select(await logColumns())
  return (await sc.apply(q)) as LogRowLite[]
}

/** How many request-log rows [fromMs, toMs) holds for deployed instances (no cap). */
export async function countLogRows(fromMs: number, toMs: number): Promise<number> {
  const sc = await instanceScope({})
  const q = db('nivaro_api_logs')
    .where('created_at', '>=', new Date(fromMs))
    .where('created_at', '<', new Date(toMs))
    .count('* as n')
  const row = ((await sc.apply(q)) as Array<{ n?: number | string }>)[0]
  return Number(row?.n ?? 0)
}

/** Partner cells (`d:ext:<id>`) for [fromMs, toMs) from the outbound call log; [] when absent. */
export async function readPartnerCells(fromMs: number, toMs: number): Promise<HourCells> {
  const out: HourCells = new Map()
  try {
    const rows = (await db('nivaro_outbound_log')
      .where('created_at', '>=', new Date(fromMs))
      .where('created_at', '<', new Date(toMs))
      .groupBy('api_id')
      .select('api_id')
      .count('* as n')
      .select(db.raw('SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS e'))
      .avg('duration_ms as avg_ms')) as Array<{
      api_id: number
      n: number | string
      e: number | string
      avg_ms: number | string | null
    }>
    for (const r of rows) {
      if (r.api_id == null) continue
      out.set(`d:ext:${r.api_id}`, [
        Number(r.n) || 0,
        Number(r.e) || 0,
        Math.round(Number(r.avg_ms) || 0),
        0
      ])
    }
  } catch {
    /* no outbound log on this database */
  }
  return out
}

/** Roll up one complete hour from the logs (single-flight per store and hour). */
export async function computeHour(h: number): Promise<HourCells | null> {
  if (!computable(h)) return null
  const s = st()
  const running = s.inflight.get(h)
  if (running) return running
  const p = (async () => {
    const from = h * HOUR_S * 1000
    const to = from + HOUR_S * 1000
    const rows = await readLogRows(from, to)
    const cells = rollupRows(rows)
    for (const [k, c] of await readPartnerCells(from, to)) cells.set(k, c)
    remember(h, cells)
    await writeRedis(h, cells, `${rows.length},${rows.length >= ROLLUP_ROW_CAP ? 1 : 0}`)
    return cells
  })()
    .catch(() => null)
    .finally(() => s.inflight.delete(h))
  s.inflight.set(h, p)
  return p
}

export interface LoadBudget {
  /** Hours that may be rolled up from the logs during this call. */
  maxCompute: number
  /** Epoch ms after which no new hour is started. */
  deadline?: number
}

/**
 * Cells for each hour: memory, then Redis, then (within the budget, newest first) a roll-up from
 * the logs. A missing hour (older than the log, or over budget) maps to null.
 */
export async function loadHours(
  hs: number[],
  budget: LoadBudget = { maxCompute: 6 }
): Promise<Map<number, HourCells | null>> {
  const s = st()
  const out = new Map<number, HourCells | null>()
  const miss: number[] = []
  for (const h of hs) {
    const m = s.mem.get(h)
    if (m) out.set(h, m)
    else miss.push(h)
  }
  const fromRedis = await readRedisHours(miss)
  const still: number[] = []
  for (const h of miss) {
    const c = fromRedis.get(h)
    if (c) {
      remember(h, c)
      out.set(h, c)
    } else still.push(h)
  }
  let left = budget.maxCompute
  for (const h of still.sort((a, b) => b - a)) {
    if (left <= 0 || !computable(h) || (budget.deadline && Date.now() > budget.deadline)) {
      out.set(h, null)
      continue
    }
    left--
    out.set(h, await computeHour(h))
  }
  return out
}

// ── bands ───────────────────────────────────────────────────────────────────

/** [median, lo, hi, spread, samples] */
export type BandWire = [number, number, number, number, number]
export interface Band {
  median: number
  lo: number
  hi: number
  spread: number
  n: number
}
export type Metric = 'rpm' | 'err_pct' | 'p95'
export const FLOORS: Record<Metric, (median: number) => number> = {
  rpm: (m) => Math.max(0.5, 0.1 * m),
  err_pct: (m) => Math.max(0.5, 0.15 * m),
  p95: (m) => Math.max(25, 0.1 * m)
}

function median(sorted: number[]): number {
  const n = sorted.length
  if (!n) return 0
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** A band from sample values (null with fewer than MIN_SAMPLES). */
export function bandFrom(samples: number[], metric: Metric): BandWire | null {
  const v = samples.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length < MIN_SAMPLES) return null
  const med = median(v)
  const mad = median(v.map((x) => Math.abs(x - med)).sort((a, b) => a - b))
  const spread = Math.max(1.4826 * mad, FLOORS[metric](med))
  return [r2(med), r2(Math.max(0, med - 2 * spread)), r2(med + 2 * spread), r2(spread), v.length]
}

export function bandOf(w: BandWire | null | undefined): Band | null {
  if (!w) return null
  return { median: w[0], lo: w[1], hi: w[2], spread: w[3], n: w[4] }
}

export interface KeyBands {
  rpm?: BandWire
  err_pct?: BandWire
  p95?: BandWire
}

/** The sample hours for slot `h`: same weekday and hour over WEEKS weeks, ± NEIGHBOUR_H. */
export function sampleHours(h: number, weeks = WEEKS, spread = NEIGHBOUR_H): number[] {
  const out: number[] = []
  for (let w = 1; w <= weeks; w++)
    for (let d = -spread; d <= spread; d++) out.push(h - w * WEEK_H + d)
  return out
}

/** Bands for every key seen in the known sample hours (pure). `known` = hours rolled up. */
export function bandsFromHours(known: HourCells[]): Map<string, KeyBands> {
  const keys = new Set<string>()
  for (const cells of known) for (const k of cells.keys()) keys.add(k)
  const out = new Map<string, KeyBands>()
  for (const k of keys) {
    if (k === 'p') continue
    const rpm: number[] = []
    const err: number[] = []
    const p95: number[] = []
    for (const cells of known) {
      const c = cells.get(k)
      rpm.push(c ? c[0] / 60 : 0)
      if (c && c[0] >= MIN_ERR_REQ) err.push((100 * c[1]) / c[0])
      if (c && c[0] >= MIN_LAT_REQ && c[3] > 0) p95.push(c[3])
    }
    const b: KeyBands = {}
    const a = bandFrom(rpm, 'rpm')
    if (a) b.rpm = a
    const e = bandFrom(err, 'err_pct')
    if (e) b.err_pct = e
    const l = bandFrom(p95, 'p95')
    if (l) b.p95 = l
    if (b.rpm || b.err_pct || b.p95) out.set(k, b)
  }
  return out
}

export interface Baselines {
  /** The epoch hour the bands are for. */
  h: number
  at: string
  weeks: number
  hours_wanted: number
  hours_known: number
  /** Fewer than two weeks of samples: bands are thin or missing. */
  learning: boolean
  nodes: Record<string, KeyBands>
  callers: Record<string, KeyBands>
  edges: Record<string, KeyBands>
  downs: Record<string, KeyBands>
  total: KeyBands
  /** People active per 15 minutes. */
  people: BandWire | null
}

export function assembleBaselines(h: number, known: HourCells[], wanted: number): Baselines {
  const bands = bandsFromHours(known)
  const pick = (prefix: string) => {
    const o: Record<string, KeyBands> = {}
    for (const [k, b] of bands) if (k.startsWith(prefix)) o[k.slice(prefix.length)] = b
    return o
  }
  const people = bandFrom(
    known.map((c) => c.get('p')?.[1] ?? 0),
    'rpm'
  )
  return {
    h,
    at: new Date().toISOString(),
    weeks: WEEKS,
    hours_wanted: wanted,
    hours_known: known.length,
    learning: known.length < 6,
    nodes: pick('n:'),
    callers: pick('c:'),
    edges: pick('e:'),
    downs: pick('d:'),
    total: bands.get('t') ?? {},
    people
  }
}

/** Bands for the hour containing `atMs` — cached per store, refreshed hourly (sooner while
 *  hours are still being learned). */
export async function baselinesAt(atMs = Date.now(), budget?: LoadBudget): Promise<Baselines> {
  const h = epochHour(atMs)
  const s = st()
  const cached = s.baseline
  const fresh =
    cached &&
    cached.h === h &&
    (cached.data.hours_known >= cached.data.hours_wanted || Date.now() - cached.at < 10 * 60_000)
  if (fresh && cached) return cached.data
  if (s.baselinePromise) return s.baselinePromise
  const hs = sampleHours(h)
  const p = loadHours(hs, budget)
    .then((map) => {
      const known = hs.map((x) => map.get(x)).filter((c): c is HourCells => !!c)
      const data = assembleBaselines(h, known, hs.length)
      s.baseline = { h, at: Date.now(), data }
      return data
    })
    .finally(() => {
      s.baselinePromise = null
    })
  s.baselinePromise = p
  return p
}

// ── scoring (client twin: admin/.../features/baselines/score.ts) ────────────

export type Level = 'unknown' | 'normal' | 'elevated' | 'high' | 'low'
export interface Score {
  level: Level
  /** Spreads above (+) or below (−) the median; null without a band. */
  z: number | null
  /** value / median (null when the median is 0 or there is no band). */
  ratio: number | null
}

/**
 * How far `value` is from its own normal. elevated = 2+ spreads above the median, high = 4+;
 * `low` (2+ below) only when `lowMatters` (a traffic drop matters, a latency drop does not).
 */
export function scoreAgainstBaseline(
  value: number,
  band: BandWire | Band | null | undefined,
  lowMatters = false
): Score {
  const b = Array.isArray(band) ? bandOf(band) : (band ?? null)
  if (!b || !Number.isFinite(value)) return { level: 'unknown', z: null, ratio: null }
  const z = (value - b.median) / Math.max(1e-9, b.spread)
  const ratio = b.median > 0 ? value / b.median : null
  const level: Level =
    z >= 4 ? 'high' : z >= 2 ? 'elevated' : lowMatters && z <= -2 ? 'low' : 'normal'
  return { level, z: Math.round(z * 10) / 10, ratio: ratio == null ? null : r2(ratio) }
}

/** Error rate judged only with enough requests (a single failed call is not a trend). */
export function scoreErrors(
  req: number,
  errors: number,
  band: BandWire | Band | null | undefined
): Score {
  if (req < MIN_ERR_REQ && errors < 3)
    return { level: band ? 'normal' : 'unknown', z: null, ratio: null }
  return scoreAgainstBaseline(req > 0 ? (100 * errors) / req : 0, band)
}

const RANK: Record<Level, number> = { unknown: 0, normal: 1, low: 2, elevated: 3, high: 4 }
export function worstLevel(levels: Level[]): Level {
  return levels.reduce<Level>((w, l) => (RANK[l] > RANK[w] ? l : w), 'unknown')
}

// ── heatmap (#2137) ─────────────────────────────────────────────────────────

export type HeatMetric = 'req' | 'errors' | 'p95'
export interface Heatmap {
  key: string
  metric: HeatMetric
  tz: string
  /** 7 rows Monday-first × 24 hours; null = no known hour in that cell. */
  cells: Array<Array<number | null>>
  max: number
  hours_known: number
  hours_wanted: number
  from: string
  to: string
}

const DOW: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
export function validTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}
/** Monday-first weekday (0–6) and hour (0–23) of epoch hour h in `tz`. */
export function slotOf(h: number, tz: string): { dow: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(new Date(h * HOUR_S * 1000))
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'
  const hr = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  return { dow: DOW[wd] ?? 0, hour: hr }
}

/** Fold per-hour cells for one key into a weekday × hour grid (pure). */
export function heatmapFrom(
  key: string,
  hours: Array<{ h: number; cells: HourCells | null }>,
  metric: HeatMetric,
  tz: string
): Heatmap {
  const vals: number[][][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []))
  let known = 0
  for (const { h, cells } of hours) {
    if (!cells) continue
    known++
    const c = cells.get(key)
    const { dow, hour } = slotOf(h, tz)
    if (metric === 'req') vals[dow][hour].push(c?.[0] ?? 0)
    else if (metric === 'errors') vals[dow][hour].push(c?.[1] ?? 0)
    else if (c && c[0] >= MIN_LAT_REQ && c[3] > 0) vals[dow][hour].push(c[3])
  }
  let max = 0
  const cells = vals.map((row) =>
    row.map((v) => {
      if (!v.length) return null
      const x =
        metric === 'p95'
          ? median(v.slice().sort((a, b) => a - b))
          : v.reduce((a, b) => a + b, 0) / v.length
      const out = Math.round(x * 10) / 10
      if (out > max) max = out
      return out
    })
  )
  const hs = hours.map((x) => x.h)
  return {
    key,
    metric,
    tz,
    cells,
    max,
    hours_known: known,
    hours_wanted: hours.length,
    from: new Date(Math.min(...hs) * HOUR_S * 1000).toISOString(),
    to: new Date((Math.max(...hs) + 1) * HOUR_S * 1000).toISOString()
  }
}

/** One key's cell across hours via HMGET (cheap over 672 hours), memory first. */
async function keyAcrossHours(
  key: string,
  hs: number[],
  budget: LoadBudget
): Promise<Array<{ h: number; cells: HourCells | null }>> {
  const s = st()
  const out = new Map<number, HourCells | null>()
  const miss: number[] = []
  for (const h of hs) {
    const m = s.mem.get(h)
    if (m) out.set(h, m)
    else miss.push(h)
  }
  const r = redis()
  const still: number[] = []
  if (r && miss.length) {
    try {
      const p = r.pipeline()
      for (const h of miss) p.hmget(rollupKey(storeId(), h), '_', key)
      const res = (await p.exec()) ?? []
      miss.forEach((h, i) => {
        const v = res[i]?.[1] as Array<string | null> | null | undefined
        if (!v || v[0] == null) {
          still.push(h)
          return
        }
        const cells: HourCells = new Map()
        const c = decodeCell(v[1])
        if (c) cells.set(key, c)
        out.set(h, cells)
      })
    } catch {
      still.push(...miss.filter((h) => !out.has(h)))
    }
  } else still.push(...miss)
  const computed = await loadHours(still, budget)
  for (const h of still) out.set(h, computed.get(h) ?? null)
  return hs.map((h) => ({ h, cells: out.get(h) ?? null }))
}

/** #2137 — hour × weekday heatmap for one roll-up key over the last WEEKS weeks. */
export async function heatmapFor(
  key: string,
  metric: HeatMetric,
  tz: string,
  nowMs = Date.now()
): Promise<Heatmap> {
  const cur = epochHour(nowMs)
  const hs: number[] = []
  for (let h = cur - WEEKS * WEEK_H; h < cur; h++) hs.push(h)
  const series = await keyAcrossHours(key, hs, { maxCompute: 24, deadline: Date.now() + 8000 })
  return heatmapFrom(key, series, metric, tz)
}

/** Roll-up key for a map node id: entity `items/x`, caller `u…`/`k…`, down `ext:9`, `total`. */
export function rollupKeyFor(kind: string, id: string): string | null {
  if (kind === 'entity' && /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(id)) return `n:${id}`
  if (kind === 'caller' && /^(k\d{1,12}|u[0-9A-F-]{36}|anon|cron)$/.test(id)) return `c:${id}`
  if (kind === 'down' && /^ext:\d{1,12}$/.test(id)) return `d:${id}`
  if (kind === 'total') return 't'
  return null
}

// ── background roll-up (cron) ───────────────────────────────────────────────

/**
 * Roll up every complete hour inside the log's retention that no roll-up holds yet, newest
 * first, within `maxHours` and `budgetMs`. Returns what it did.
 */
export async function rollupBackfill(
  maxHours = 48,
  budgetMs = 90_000,
  nowMs = Date.now()
): Promise<{ computed: number; missing: number }> {
  const cur = epochHour(nowMs)
  const hs: number[] = []
  for (let h = cur - 1; computable(h, nowMs); h--) hs.push(h)
  const known = await readRedisHours(hs)
  const s = st()
  const missing = hs.filter((h) => !known.get(h) && !(redis() === null && s.mem.has(h)))
  const deadline = Date.now() + budgetMs
  let computed = 0
  for (const h of missing) {
    if (computed >= maxHours || Date.now() > deadline) break
    if (await computeHour(h)) computed++
  }
  return { computed, missing: missing.length - computed }
}

/** Tests: forget every cached roll-up and baseline in the current store. */
export function resetBaselinesForTest(): void {
  const s = st()
  s.mem.clear()
  s.inflight.clear()
  s.baseline = null
  s.baselinePromise = null
}

/** Tests: put an hour's cells straight into the memory cache. */
export function rememberHourForTest(h: number, cells: HourCells): void {
  remember(h, cells)
}

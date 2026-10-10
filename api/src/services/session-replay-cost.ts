/**
 * Recording cost (#1368): what session replay stores, by route and build,
 * the instance's daily byte cap, and per-route sampling.
 *
 * - Every chunk a recorder uploads names the route pattern it was recorded on
 *   and the frontend build (`route`, `build` in the events body). Accepted
 *   chunks add their STORED bytes to nivaro_session_replay_usage (day × route
 *   × build) and every upload outcome counts in nivaro_session_replay_daily —
 *   the counters #1412's readiness check reads.
 * - Counting is in memory and flushed every FLUSH_MS (and on shutdown of the
 *   flush timer's process, best-effort): two UPDATEs per chunk on a busy
 *   instance would cost more than the figures are worth. Each replica flushes
 *   its own deltas as `col = col + n`, so replicas add up.
 * - The daily cap (nivaro_settings.replay_daily_cap_mb) counts stored bytes
 *   per UTC day across the instance. Once reached, /start and the events
 *   route answer 409 {reason:'daily_cap'} (the recorders treat 409 as the
 *   end) and /enabled tells new pages not to start. Replicas see each other's
 *   bytes within CACHE_MS, so the cap can overshoot by that much — it is a
 *   cost guard, not a quota.
 * - Sampling (nivaro_settings.replay_sampling) is decided in the browser:
 *   `{ default: 1, routes: { '/content/orders/:id': 0.25, '/reports/*': 0 } }`
 *   — an exact route pattern, or a prefix ending in `/*` (the longest wins).
 */
import { db } from '../db/index.js'

export const FLUSH_MS = 15_000
const CACHE_MS = 30_000
export const ROUTE_MAX = 140
export const BUILD_MAX = 64
const ROUTES_MAX = 100

export type ChunkOutcome =
  | 'accepted'
  | 'duplicate'
  | 'closed'
  | 'size_cap'
  | 'too_large'
  | 'daily_cap'

export interface ChunkMeta {
  route: string
  build: string
  /** Upload attempts the recorder saw fail since its last success (client-reported). */
  retries: number
}

export const utcDay = (d: Date = new Date()): string => d.toISOString().slice(0, 10)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The route a chunk names, as a pattern: the recorders already send
 * pagePattern() output, but an id-shaped segment (digits, a uuid, an email,
 * anything long) becomes `:id` here too, so an older or hand-rolled client
 * cannot put record ids into the cost table. '' when there is none.
 */
export function sanitizeReplayRoute(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const path = raw.split(/[?#]/)[0].trim()
  if (!path.startsWith('/')) return ''
  const segs: string[] = []
  for (const s of path.split('/')) {
    if (!s) continue
    const id =
      s !== ':id' &&
      (/\d/.test(s) || UUID.test(s) || s.includes('@') || s.length > 40 || !/^[\w.:*-]+$/.test(s))
    const seg = id ? ':id' : s.toLowerCase()
    if (seg === ':id' && segs[segs.length - 1] === ':id') continue
    segs.push(seg)
    if (segs.length >= 10) break
  }
  return `/${segs.join('/')}`.slice(0, ROUTE_MAX)
}

export function sanitizeReplayBuild(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return ''
  const s = String(raw).trim().slice(0, BUILD_MAX)
  return /^[\w.@+:/-]+$/.test(s) ? s : ''
}

/** Route, build and client-reported failures off an events body. */
export function chunkMeta(body: unknown): ChunkMeta {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const r = Number(b.retries)
  return {
    route: sanitizeReplayRoute(b.route),
    build: sanitizeReplayBuild(b.build),
    retries: Number.isFinite(r) && r > 0 ? Math.min(Math.trunc(r), 1000) : 0
  }
}

// ── Sampling ─────────────────────────────────────────────────────────────────

export interface ReplaySampling {
  /** Share of sessions recorded on a route with no rule of its own (0–1). */
  default: number
  /** Route pattern (or `/prefix/*`) → share recorded (0–1). */
  routes: Record<string, number>
}

export const DEFAULT_REPLAY_SAMPLING: ReplaySampling = { default: 1, routes: {} }

const rate = (v: unknown): number | null => {
  const n = Number(v)
  return v !== null && v !== '' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** A route key as stored: a pattern, or a prefix ending in `/*`. */
function samplingKey(k: string): string {
  const t = k.trim()
  if (t === '/*' || t === '*') return '/*'
  if (t.endsWith('/*')) {
    const base = sanitizeReplayRoute(t.slice(0, -2))
    return base ? `${base === '/' ? '' : base}/*` : ''
  }
  return sanitizeReplayRoute(t)
}

export function parseReplaySampling(raw: unknown): ReplaySampling {
  const v = parseJson(raw)
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>
  const routes: Record<string, number> = {}
  if (o.routes && typeof o.routes === 'object' && !Array.isArray(o.routes)) {
    for (const [k, r] of Object.entries(o.routes as Record<string, unknown>)) {
      const key = samplingKey(k)
      const n = rate(r)
      if (key && n != null && Object.keys(routes).length < ROUTES_MAX) routes[key] = n
    }
  }
  return { default: rate(o.default) ?? 1, routes }
}

export function validateReplaySampling(raw: unknown): { value: string | null } | { error: string } {
  if (raw == null || raw === '') return { value: null }
  const v = parseJson(raw)
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { error: 'replay_sampling must be an object' }
  }
  const o = v as Record<string, unknown>
  if ('default' in o && rate(o.default) == null) {
    return { error: 'replay_sampling.default must be a number from 0 to 1' }
  }
  if ('routes' in o) {
    if (!o.routes || typeof o.routes !== 'object' || Array.isArray(o.routes)) {
      return { error: 'replay_sampling.routes must map a route pattern to a number from 0 to 1' }
    }
    const entries = Object.entries(o.routes as Record<string, unknown>)
    if (entries.length > ROUTES_MAX) {
      return { error: `replay_sampling.routes takes at most ${ROUTES_MAX} routes` }
    }
    for (const [k, r] of entries) {
      if (!samplingKey(k)) return { error: `replay_sampling: "${k}" is not a route pattern` }
      if (rate(r) == null) return { error: `replay_sampling: "${k}" needs a number from 0 to 1` }
    }
  }
  return { value: JSON.stringify(parseReplaySampling(o)) }
}

/** The share recorded on `route`: exact pattern, else the longest `/prefix/*`, else the default. */
export function samplingRateFor(s: ReplaySampling, route: string): number {
  if (route in s.routes) return s.routes[route]
  let best = -1
  let out = s.default
  for (const [k, r] of Object.entries(s.routes)) {
    if (!k.endsWith('/*')) continue
    const base = k.slice(0, -2)
    if ((route === base || route.startsWith(`${base}/`)) && base.length > best) {
      best = base.length
      out = r
    }
  }
  return out
}

export function validateDailyCapMb(raw: unknown): { value: number | null } | { error: string } {
  if (raw == null || raw === '') return { value: null }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) {
    return {
      error: 'replay_daily_cap_mb must be a whole number of megabytes (0 or blank = no cap)'
    }
  }
  return { value: n === 0 ? null : n }
}

// ── Counting ─────────────────────────────────────────────────────────────────

interface DayDelta {
  accepted: number
  duplicates: number
  rejected_closed: number
  rejected_size_cap: number
  rejected_too_large: number
  rejected_daily_cap: number
  client_failures: number
  bytes: number
  cap_hit_at: Date | null
}

const OUTCOME_COLUMN: Record<ChunkOutcome, keyof DayDelta> = {
  accepted: 'accepted',
  duplicate: 'duplicates',
  closed: 'rejected_closed',
  size_cap: 'rejected_size_cap',
  too_large: 'rejected_too_large',
  daily_cap: 'rejected_daily_cap'
}

const emptyDelta = (): DayDelta => ({
  accepted: 0,
  duplicates: 0,
  rejected_closed: 0,
  rejected_size_cap: 0,
  rejected_too_large: 0,
  rejected_daily_cap: 0,
  client_failures: 0,
  bytes: 0,
  cap_hit_at: null
})

let pendingDaily = new Map<string, DayDelta>()
let pendingUsage = new Map<
  string,
  { day: string; route: string; build: string; bytes: number; chunks: number }
>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function dayDelta(day: string): DayDelta {
  let d = pendingDaily.get(day)
  if (!d) {
    d = emptyDelta()
    pendingDaily.set(day, d)
  }
  return d
}

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushReplayUsage().catch(() => {})
  }, FLUSH_MS)
  flushTimer.unref?.()
}

/**
 * Count one upload's outcome. `bytes` are the stored bytes of an accepted
 * chunk. Client-reported retries count on every outcome — the request that
 * carries them reached the server.
 */
export function noteChunk(
  outcome: ChunkOutcome,
  meta: ChunkMeta,
  bytes = 0,
  now: Date = new Date()
): void {
  const day = utcDay(now)
  const d = dayDelta(day)
  ;(d[OUTCOME_COLUMN[outcome]] as number)++
  d.client_failures += meta.retries
  if (outcome === 'accepted' && bytes > 0) {
    d.bytes += bytes
    const key = `${day}\u0000${meta.route}\u0000${meta.build}`
    const u = pendingUsage.get(key) ?? {
      day,
      route: meta.route,
      build: meta.build,
      bytes: 0,
      chunks: 0
    }
    u.bytes += bytes
    u.chunks++
    pendingUsage.set(key, u)
  }
  scheduleFlush()
}

/** `col = col + n` for each non-zero delta; insert the row when it does not exist yet. */
async function bump(
  table: string,
  key: Record<string, string>,
  incs: Record<string, number>,
  capHitAt?: Date | null
): Promise<void> {
  const set: Record<string, unknown> = {}
  for (const [c, n] of Object.entries(incs)) if (n) set[c] = db.raw(`${c} + ?`, [n])
  if (capHitAt) set.cap_hit_at = db.raw('COALESCE(cap_hit_at, ?)', [capHitAt])
  if (Object.keys(set).length === 0) return
  const updated = await db(table).where(key).update(set)
  if (Number(updated)) return
  try {
    await db(table).insert({ ...key, ...incs, ...(capHitAt ? { cap_hit_at: capHitAt } : {}) })
  } catch (err) {
    // Another replica inserted the day first: add to its row instead.
    const n = (err as { number?: unknown; code?: unknown })?.number
    if (n !== 2627 && n !== 2601 && (err as { code?: unknown })?.code !== '23505') throw err
    await db(table).where(key).update(set)
  }
}

/** Write the counted deltas. A failed write puts them back for the next flush. */
export async function flushReplayUsage(): Promise<void> {
  const daily = pendingDaily
  const usage = pendingUsage
  pendingDaily = new Map()
  pendingUsage = new Map()
  try {
    for (const [day, d] of daily) {
      const { cap_hit_at, ...incs } = d
      await bump('nivaro_session_replay_daily', { day }, incs, cap_hit_at)
    }
    for (const u of usage.values()) {
      await bump(
        'nivaro_session_replay_usage',
        { day: u.day, route: u.route, build: u.build },
        { bytes: u.bytes, chunks: u.chunks }
      )
    }
    // What this replica just wrote is now in the table the cap reads.
    if (dayCache) dayCache.at = 0
  } catch {
    for (const [day, d] of daily) {
      const into = dayDelta(day)
      for (const k of Object.keys(d) as Array<keyof DayDelta>) {
        if (k === 'cap_hit_at') into.cap_hit_at = into.cap_hit_at ?? d.cap_hit_at
        else (into[k] as number) += d[k] as number
      }
    }
    for (const [k, u] of usage) {
      const into = pendingUsage.get(k)
      if (into) {
        into.bytes += u.bytes
        into.chunks += u.chunks
      } else pendingUsage.set(k, u)
    }
  }
}

// ── The daily cap ────────────────────────────────────────────────────────────

let capCache: { at: number; capBytes: number | null } | null = null
let dayCache: { day: string; at: number; bytes: number; capHit: boolean } | null = null

/** Tests (and a settings save) start from a clean slate. */
export function resetReplayCostState(): void {
  capCache = null
  dayCache = null
  pendingDaily = new Map()
  pendingUsage = new Map()
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
}

export function bustReplayCapCache(): void {
  capCache = null
}

async function capBytes(now: number): Promise<number | null> {
  if (capCache && now - capCache.at < CACHE_MS) return capCache.capBytes
  let cap: number | null = null
  try {
    const row = (await db('nivaro_settings').where({ id: 1 }).first('replay_daily_cap_mb')) as
      | { replay_daily_cap_mb?: unknown }
      | undefined
    const mb = Number(row?.replay_daily_cap_mb)
    cap = Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1_048_576) : null
  } catch {
    cap = null
  }
  capCache = { at: now, capBytes: cap }
  return cap
}

async function storedToday(day: string, now: number): Promise<{ bytes: number; capHit: boolean }> {
  if (!dayCache || dayCache.day !== day || now - dayCache.at >= CACHE_MS) {
    let bytes = 0
    let capHit = false
    try {
      const row = (await db('nivaro_session_replay_daily')
        .where({ day })
        .first('bytes', 'cap_hit_at')) as { bytes?: unknown; cap_hit_at?: unknown } | undefined
      bytes = Number(row?.bytes) || 0
      capHit = !!row?.cap_hit_at
    } catch {
      /* pre-migration — nothing stored counts */
    }
    dayCache = { day, at: now, bytes, capHit }
  }
  return {
    bytes: dayCache.bytes + (pendingDaily.get(day)?.bytes ?? 0),
    capHit: dayCache.capHit
  }
}

export interface DailyCapStatus {
  cap_bytes: number | null
  used_bytes: number
  reached: boolean
}

/**
 * Has today's stored recording reached the cap? The first time it has, the
 * day's row gets cap_hit_at (what #1412's readiness check reports).
 */
export async function dailyCapStatus(now: Date = new Date()): Promise<DailyCapStatus> {
  const t = now.getTime()
  const cap = await capBytes(t)
  if (!cap) return { cap_bytes: null, used_bytes: 0, reached: false }
  const day = utcDay(now)
  const today = await storedToday(day, t)
  const reached = today.bytes >= cap
  if (reached && !today.capHit) {
    const d = dayDelta(day)
    if (!d.cap_hit_at) {
      d.cap_hit_at = now
      scheduleFlush()
    }
  }
  return { cap_bytes: cap, used_bytes: today.bytes, reached }
}

/** The settings row's sampling rules, for /enabled. */
export async function readReplaySampling(): Promise<ReplaySampling> {
  try {
    const row = (await db('nivaro_settings').where({ id: 1 }).first('replay_sampling')) as
      | { replay_sampling?: unknown }
      | undefined
    return parseReplaySampling(row?.replay_sampling)
  } catch {
    return DEFAULT_REPLAY_SAMPLING
  }
}

// ── DB Health ────────────────────────────────────────────────────────────────

export interface ReplayCostSummary {
  days: number
  since: string
  by_route: Array<{ route: string; bytes: number; chunks: number; sampling: number }>
  by_build: Array<{ build: string; bytes: number; chunks: number }>
  by_day: Array<{
    day: string
    bytes: number
    accepted: number
    rejected: number
    cap_hit_at: string | null
  }>
  cap: DailyCapStatus
  sampling: ReplaySampling
  /** Stored today (UTC). */
  today_bytes: number
  /** Stored bytes per day, averaged over the window — the recordings' share of the runway. */
  bytes_per_day: number
}

const dayStr = (v: unknown): string =>
  v instanceof Date ? utcDay(v) : String(v ?? '').slice(0, 10)

export async function replayCostSummary(
  days = 7,
  now: Date = new Date()
): Promise<ReplayCostSummary> {
  await flushReplayUsage().catch(() => {})
  const since = utcDay(new Date(now.getTime() - (days - 1) * 86_400_000))
  const [routes, builds, daily, cap, sampling] = await Promise.all([
    db('nivaro_session_replay_usage')
      .where('day', '>=', since)
      .groupBy('route')
      .select('route')
      .sum({ bytes: 'bytes' })
      .sum({ chunks: 'chunks' })
      .orderByRaw('SUM(bytes) DESC')
      .limit(25) as unknown as Promise<Array<Record<string, unknown>>>,
    db('nivaro_session_replay_usage')
      .where('day', '>=', since)
      .groupBy('build')
      .select('build')
      .sum({ bytes: 'bytes' })
      .sum({ chunks: 'chunks' })
      .orderByRaw('SUM(bytes) DESC')
      .limit(15) as unknown as Promise<Array<Record<string, unknown>>>,
    db('nivaro_session_replay_daily')
      .where('day', '>=', since)
      .orderBy('day', 'asc')
      .select('*') as unknown as Promise<Array<Record<string, unknown>>>,
    dailyCapStatus(now),
    readReplaySampling()
  ])
  const byDay = daily.map((d) => ({
    day: dayStr(d.day),
    bytes: Number(d.bytes) || 0,
    accepted: Number(d.accepted) || 0,
    rejected:
      (Number(d.rejected_closed) || 0) +
      (Number(d.rejected_size_cap) || 0) +
      (Number(d.rejected_too_large) || 0) +
      (Number(d.rejected_daily_cap) || 0),
    cap_hit_at: d.cap_hit_at ? new Date(d.cap_hit_at as string).toISOString() : null
  }))
  const total = byDay.reduce((a, d) => a + d.bytes, 0)
  return {
    days,
    since,
    by_route: routes.map((r) => ({
      route: String(r.route ?? ''),
      bytes: Number(r.bytes) || 0,
      chunks: Number(r.chunks) || 0,
      sampling: samplingRateFor(sampling, String(r.route ?? ''))
    })),
    by_build: builds.map((b) => ({
      build: String(b.build ?? ''),
      bytes: Number(b.bytes) || 0,
      chunks: Number(b.chunks) || 0
    })),
    by_day: byDay,
    cap,
    sampling,
    today_bytes: byDay.find((d) => d.day === utcDay(now))?.bytes ?? 0,
    bytes_per_day: Math.round(total / days)
  }
}

// ── Storage runway ───────────────────────────────────────────────────────────

export interface ReplayStorageFigures {
  recordings: number
  /** Stored chunk bytes in the database. */
  hot_bytes: number
  /** Recent growth: stored bytes per day over the last 7 days of usage. */
  bytes_per_day: number
}

/** The recordings' share of the storage runway (DB Health, the nightly snapshot). */
export async function replayStorageFigures(now: Date = new Date()): Promise<ReplayStorageFigures> {
  const since = utcDay(new Date(now.getTime() - 6 * 86_400_000))
  const [rec, usage] = await Promise.all([
    db('nivaro_session_recordings')
      .count({ n: '*' })
      .sum({ bytes: 'byte_size' })
      .first() as Promise<{ n?: unknown; bytes?: unknown } | undefined>,
    db('nivaro_session_replay_usage')
      .where('day', '>=', since)
      .sum({ bytes: 'bytes' })
      .first()
      .catch(() => undefined) as Promise<{ bytes?: unknown } | undefined>
  ])
  return {
    recordings: Number(rec?.n) || 0,
    hot_bytes: Number(rec?.bytes) || 0,
    bytes_per_day: Math.round((Number(usage?.bytes) || 0) / 7)
  }
}

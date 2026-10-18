// api/src/services/traffic-minutes.ts
/**
 * Traffic Map — longer high-resolution history (#2228): an OPTIONAL per-minute store of the map's
 * figures (per node and per edge: requests, errors, p50 / p95, response bytes) in
 * `nivaro_traffic_minutes` (migration 448), so weeks of minute-level detail are there for the
 * time-lapse, search and comparisons. Off by default (`nivaro_settings.traffic_history`
 * `{enabled, retention_days, edges}`); retention defaults to 30 days.
 *
 * How it is collected, so it stays cheap and exact across replicas:
 *  - every process: a tap adds each finished request / partner call to the current minute's
 *    per-key aggregate (counts, bytes, max and a 12-bucket latency histogram) — O(1), only while
 *    the store is on, at most MAX_KEYS keys a minute (the rest fold into `__overflow__` keys);
 *  - every 10 s each process pushes its closed minutes to Redis (`nvr:tm:min:<minute>`, 30 min
 *    TTL);
 *  - the scheduler leader (cron `traffic-minutes-write`, every minute) takes each closed minute's
 *    list atomically, merges the histograms (so p95 is the cluster's, not an average of nodes) and
 *    writes one batch. A late push for a minute already written becomes a second row for the same
 *    (bucket, key); reads sum them.
 *  - cron `traffic-minutes-prune` (hourly) deletes rows past the retention, 5,000 at a time
 *    (at most 1M a run: per-user edge rows can reach millions a day, so nightly fell behind).
 * Without Redis a process writes its own closed minutes directly. Cloud mode: off (one shared
 * writer cannot know each tenant's database) — the tap records nothing there.
 *
 * Keys: `e:<lane>/<entity>` (entity), `c:<caller>` (caller), `d:<down id>` (partner, channel…),
 * edges `c:<caller>>e:<lane>/<entity>` and `e:<lane>/<entity>>d:<down id>`.
 */
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { logActivity } from './activity.js'
import { getApp } from './io-holder.js'
import { runLongSql } from './run-long.js'
import {
  histFromText,
  histPercentile,
  histToText,
  LAT_BUCKETS,
  latBucket,
  type TimelapseGroup
} from './traffic-history-analysis.js'
import { registerTrafficTap, tapState } from './traffic-taps.js'

export const TAP_ID = 'minute-store'
export const TABLE = 'nivaro_traffic_minutes'
const MAX_KEYS = 3000
/** The minute-store range read's own statement timeout (a 7-day time-lapse). */
const STEPS_TIMEOUT_MS = 60_000
const PUSH_MS = 10_000
const REDIS_TTL_S = 1800
const redisKey = (minute: number) => `nvr:tm:min:${minute}`

// ── settings ─────────────────────────────────────────────────────────────────
export interface MinuteStoreSettings {
  enabled: boolean
  /** Days of minute rows to keep (1–90). */
  retention_days: number
  /** Also keep edges (caller → node, node → partner); off keeps nodes only. */
  edges: boolean
}
export const MINUTE_DEFAULTS: MinuteStoreSettings = {
  enabled: false,
  retention_days: 30,
  edges: true
}

/** Strict: a bad value throws a sentence naming it. Missing keys keep `base`. */
export function validateMinuteSettings(
  raw: unknown,
  base: MinuteStoreSettings = MINUTE_DEFAULTS
): MinuteStoreSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const days = o.retention_days === undefined ? base.retention_days : Number(o.retention_days)
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new Error('retention_days must be a whole number of days from 1 to 90')
  return {
    enabled: o.enabled === undefined ? base.enabled : o.enabled === true,
    retention_days: days,
    edges: o.edges === undefined ? base.edges : o.edges !== false
  }
}

/** Lenient parse of the stored JSON (malformed = defaults). */
export function parseMinuteSettings(raw: unknown): MinuteStoreSettings {
  try {
    const v = typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : raw
    return validateMinuteSettings(v ?? {})
  } catch {
    return { ...MINUTE_DEFAULTS }
  }
}

function inCloud(): boolean {
  return !!process.env.CLOUD_META_DB_URL
}

let settingsCache: { at: number; value: MinuteStoreSettings } | null = null
/** The live switch the tap reads (refreshed every minute; never awaited per request). */
let recording = false
let recordEdges = true

export async function readMinuteSettings(fresh = false): Promise<MinuteStoreSettings> {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < 60_000) return settingsCache.value
  let value = { ...MINUTE_DEFAULTS }
  try {
    if (await hasColumn('nivaro_settings', 'traffic_history')) {
      const row = (await db('nivaro_settings').where('id', 1).first('traffic_history')) as
        | { traffic_history?: string | null }
        | undefined
      value = parseMinuteSettings(row?.traffic_history)
    }
  } catch {
    /* keep the defaults */
  }
  settingsCache = { at: Date.now(), value }
  recording = value.enabled && !inCloud()
  recordEdges = value.edges
  return value
}

export class MinuteSettingsUnavailableError extends Error {}

/** Save the settings (activity row with what changed). Throws on a bad value. */
export async function saveMinuteSettings(
  patch: unknown,
  who: { userId?: string | null; req?: unknown }
): Promise<MinuteStoreSettings> {
  if (!(await hasColumn('nivaro_settings', 'traffic_history')))
    throw new MinuteSettingsUnavailableError(
      'This database has not run migration 448 yet, so minute history cannot be switched on'
    )
  const before = await readMinuteSettings(true)
  const next = validateMinuteSettings(patch, before)
  await db('nivaro_settings')
    .where('id', 1)
    .update({ traffic_history: JSON.stringify(next) })
  settingsCache = { at: Date.now(), value: next }
  recording = next.enabled && !inCloud()
  recordEdges = next.edges
  const changed: string[] = []
  if (before.enabled !== next.enabled) changed.push(next.enabled ? 'switched on' : 'switched off')
  if (before.retention_days !== next.retention_days)
    changed.push(`keep ${next.retention_days} days (was ${before.retention_days})`)
  if (before.edges !== next.edges) changed.push(next.edges ? 'edges kept' : 'nodes only')
  if (changed.length)
    await logActivity({
      action: 'traffic-map-history-settings',
      user: who.userId ?? undefined,
      comment: `Traffic Map minute history: ${changed.join(', ')}`,
      req: who.req as never
    }).catch(() => undefined)
  return next
}

// ── per-minute aggregation (pure) ────────────────────────────────────────────
export interface Agg {
  n: number
  e: number
  bytes: number
  max: number
  hist: number[]
}
const newAgg = (): Agg => ({ n: 0, e: 0, bytes: 0, max: 0, hist: new Array(LAT_BUCKETS).fill(0) })

export class MinuteAggregator {
  minute = -1
  keys = new Map<string, Agg>()
  closed: Array<{ minute: number; keys: Map<string, Agg> }> = []

  /** Close the current minute when `minute` moved past it. */
  rotate(minute: number): void {
    if (minute === this.minute) return
    if (minute < this.minute) return
    if (this.keys.size) this.closed.push({ minute: this.minute, keys: this.keys })
    // A process that cannot push (Redis down) keeps at most the last 10 minutes.
    if (this.closed.length > 10) this.closed.splice(0, this.closed.length - 10)
    this.keys = new Map()
    this.minute = minute
  }

  add(minute: number, key: string, ms: number, err: boolean, bytes: number): void {
    this.rotate(minute)
    let a = this.keys.get(key)
    if (!a) {
      if (this.keys.size >= MAX_KEYS) {
        key = overflowKey(key)
        a = this.keys.get(key)
      }
      if (!a) {
        a = newAgg()
        this.keys.set(key, a)
      }
    }
    a.n++
    if (err) a.e++
    if (Number.isFinite(bytes) && bytes > 0) a.bytes += bytes
    const v = Number.isFinite(ms) && ms > 0 ? ms : 0
    if (v > a.max) a.max = v
    a.hist[latBucket(v)]++
  }

  /** Take the closed minutes (oldest first). */
  drain(): Array<{ minute: number; keys: Map<string, Agg> }> {
    const out = this.closed
    this.closed = []
    return out
  }
}

export function overflowKey(key: string): string {
  if (key.includes('>')) return 'x:__overflow__'
  if (key.startsWith('e:')) return 'e:other/__overflow__'
  if (key.startsWith('c:')) return 'c:__overflow__'
  return 'd:__overflow__'
}

/** Wire form of one process's minute: `[key, n, e, bytes, max, hist]` rows. */
export type WireRow = [string, number, number, number, number, string]
export function toWire(keys: Map<string, Agg>): WireRow[] {
  return [...keys].map(([k, a]) => [k, a.n, a.e, a.bytes, Math.round(a.max), histToText(a.hist)])
}

/** Merge the wire minutes several processes pushed (malformed entries are skipped). */
export function mergeWire(parts: unknown[]): Map<string, Agg> {
  const out = new Map<string, Agg>()
  for (const p of parts) {
    if (!Array.isArray(p)) continue
    for (const row of p) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 300) continue
      const [k, n, e, bytes, max, hist] = row as WireRow
      const a = out.get(k) ?? newAgg()
      a.n += Number(n) || 0
      a.e += Number(e) || 0
      a.bytes += Number(bytes) || 0
      a.max = Math.max(a.max, Number(max) || 0)
      const h = histFromText(hist)
      for (let i = 0; i < LAT_BUCKETS; i++) a.hist[i] += h[i]
      out.set(k, a)
    }
  }
  return out
}

export interface MinuteRow {
  bucket: Date
  key: string
  kind: 'node' | 'edge'
  requests: number
  errors: number
  p50: number
  p95: number
  bytes: number
  hist: string
}
export function toRows(minute: number, keys: Map<string, Agg>): MinuteRow[] {
  const bucket = new Date(minute * 60_000)
  return [...keys]
    .filter(([, a]) => a.n > 0)
    .map(([key, a]) => ({
      bucket,
      key: key.slice(0, 300),
      kind: key.includes('>') ? ('edge' as const) : ('node' as const),
      requests: a.n,
      errors: a.e,
      p50: histPercentile(a.hist, 0.5, a.max),
      p95: histPercentile(a.hist, 0.95, a.max),
      bytes: Math.round(a.bytes),
      hist: histToText(a.hist)
    }))
}

// ── the tap ──────────────────────────────────────────────────────────────────
function agg(): MinuteAggregator {
  return tapState<MinuteAggregator>(TAP_ID, () => new MinuteAggregator())
}

registerTrafficTap({
  id: TAP_ID,
  onRequest: (c) => {
    if (!recording) return
    const a = agg()
    const minute = Math.floor(c.sec / 60)
    const ms = c.ev.latencyMs
    const bytes = c.ev.responseBytes ?? 0
    a.add(minute, `e:${c.entityKey}`, ms, c.isError, bytes)
    a.add(minute, `c:${c.caller}`, ms, c.isError, bytes)
    if (recordEdges) a.add(minute, `c:${c.caller}>e:${c.entityKey}`, ms, c.isError, bytes)
  },
  onOutbound: (c) => {
    if (!recording) return
    const a = agg()
    const minute = Math.floor(c.sec / 60)
    a.add(minute, `d:${c.downId}`, c.ev.durationMs, c.failed, 0)
    if (recordEdges) a.add(minute, `e:${c.entityKey}>d:${c.downId}`, c.ev.durationMs, c.failed, 0)
  }
})

// ── push (every process) and write (the leader) ──────────────────────────────
interface ListRedis {
  rpush(key: string, ...values: string[]): Promise<unknown>
  expire(key: string, s: number): Promise<unknown>
  multi(): MultiChain
}
interface MultiChain {
  lrange(key: string, a: number, b: number): MultiChain
  del(key: string): MultiChain
  exec(): Promise<Array<[Error | null, unknown]> | null>
}
function redis(): ListRedis | null {
  const r = (getApp() as { redis?: ListRedis } | null)?.redis
  return r && typeof r.rpush === 'function' ? r : null
}

let tableProbe: { at: number; ok: boolean } | null = null
export async function minuteTableReady(): Promise<boolean> {
  if (tableProbe && Date.now() - tableProbe.at < (tableProbe.ok ? 3600_000 : 60_000))
    return tableProbe.ok
  let ok = false
  try {
    ok = await db.schema.hasTable(TABLE)
  } catch {
    ok = false
  }
  tableProbe = { at: Date.now(), ok }
  return ok
}

export async function writeMinuteRows(rows: MinuteRow[]): Promise<number> {
  if (!rows.length || !(await minuteTableReady())) return 0
  // 9 columns × 200 rows stays under the 2,100-parameter cap.
  for (let i = 0; i < rows.length; i += 200) await db(TABLE).insert(rows.slice(i, i + 200))
  return rows.length
}

/** Push this process's closed minutes (Redis) — or write them directly without Redis. */
export async function pushClosedMinutes(nowMs = Date.now()): Promise<number> {
  const a = agg()
  a.rotate(Math.floor(nowMs / 60_000))
  const closed = a.drain()
  if (!closed.length) return 0
  const r = redis()
  let n = 0
  for (const m of closed) {
    if (r) {
      try {
        await r.rpush(redisKey(m.minute), JSON.stringify(toWire(m.keys)))
        await r.expire(redisKey(m.minute), REDIS_TTL_S)
        n += m.keys.size
      } catch {
        /* Redis down: this minute is lost rather than double-written later */
      }
    } else {
      n += await writeMinuteRows(toRows(m.minute, m.keys)).catch(() => 0)
    }
  }
  return n
}

let pushTimer: NodeJS.Timeout | null = null
let settingsTimer: NodeJS.Timeout | null = null
/** Start the per-process settings refresh + push loop (idempotent; never in cloud mode). */
export function startMinuteStore(): void {
  if (inCloud() || pushTimer) return
  void readMinuteSettings(true)
  settingsTimer = setInterval(() => void readMinuteSettings(true), 60_000)
  settingsTimer.unref?.()
  pushTimer = setInterval(() => {
    if (!recording) return
    void pushClosedMinutes().catch(() => undefined)
  }, PUSH_MS)
  pushTimer.unref?.()
}
export function stopMinuteStore(): void {
  if (pushTimer) clearInterval(pushTimer)
  if (settingsTimer) clearInterval(settingsTimer)
  pushTimer = null
  settingsTimer = null
}
/** Tests: flip the switch without a database. */
export function setRecordingForTest(on: boolean, edges = true): void {
  recording = on
  recordEdges = edges
}

/**
 * The leader's minute write: every closed minute in the last 20 that processes pushed, merged and
 * written in one batch each. Returns rows written.
 */
export async function writePushedMinutes(nowMs = Date.now()): Promise<number> {
  const s = await readMinuteSettings()
  if (!s.enabled || inCloud()) return 0
  const r = redis()
  if (!r || !(await minuteTableReady())) return 0
  const cur = Math.floor(nowMs / 60_000)
  let written = 0
  for (let m = cur - 20; m <= cur - 2; m++) {
    let res: Array<[Error | null, unknown]> | null
    try {
      res = await r.multi().lrange(redisKey(m), 0, -1).del(redisKey(m)).exec()
    } catch {
      continue
    }
    const list = (res?.[0]?.[1] as string[] | undefined) ?? []
    if (!list.length) continue
    const parts = list.map((s) => {
      try {
        return JSON.parse(s) as unknown
      } catch {
        return null
      }
    })
    const merged = mergeWire(parts)
    if (!s.edges) for (const k of [...merged.keys()]) if (k.includes('>')) merged.delete(k)
    written += await writeMinuteRows(toRows(m, merged))
  }
  return written
}

/** Delete rows past the retention, 5,000 at a time (at most `rounds` batches). */
export async function pruneMinuteRows(rounds = 200, nowMs = Date.now()): Promise<number> {
  if (inCloud() || !(await minuteTableReady())) return 0
  const s = await readMinuteSettings()
  const cutoff = new Date(nowMs - s.retention_days * 86_400_000)
  let total = 0
  for (let i = 0; i < rounds; i++) {
    let n = 0
    if (isMssql(db)) {
      // knex/mssql raw DELETE reports no usable count — read @@ROWCOUNT in the same batch.
      const res = (await db.raw(
        `DELETE TOP (5000) FROM ${TABLE} WHERE bucket < ?; SELECT @@ROWCOUNT AS n`,
        [cutoff]
      )) as Array<{ n?: number }>
      n = Number(res?.[0]?.n ?? 0)
    } else {
      n = Number(await db(TABLE).where('bucket', '<', cutoff).del())
      total += n
      break
    }
    total += n
    if (n < 5000) break
  }
  return total
}

// ── reads ────────────────────────────────────────────────────────────────────
export interface MinuteCoverage {
  table: boolean
  first: string | null
  last: string | null
}
export async function minuteCoverage(): Promise<MinuteCoverage> {
  if (!(await minuteTableReady())) return { table: false, first: null, last: null }
  try {
    const row = (await db(TABLE).min('bucket as first').max('bucket as last').first()) as
      | { first?: Date | string | null; last?: Date | string | null }
      | undefined
    const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null)
    return { table: true, first: iso(row?.first), last: iso(row?.last) }
  } catch {
    return { table: true, first: null, last: null }
  }
}

/**
 * Node rows between `from` and `to` (epoch ms) summed per step of `stepS` seconds. p95 is the
 * request-weighted mean of the minutes' p95 (approximate once minutes are rolled up).
 */
export async function minuteSteps(
  from: number,
  to: number,
  stepS: number,
  opts: { prefix?: string; edges?: boolean } = {}
): Promise<TimelapseGroup[]> {
  if (!(await minuteTableReady())) return []
  const stepMin = Math.max(1, Math.round(stepS / 60))
  const fromD = new Date(from)
  const toD = new Date(to)
  const kind = opts.edges ? 'edge' : 'node'
  if (isMssql(db)) {
    const like = opts.prefix ? ' AND [key] LIKE ?' : ''
    // Seven days of minutes outlive tedious's 15 s default: one statement on its own timeout
    // (knex renders the bindings as escaped literals).
    const sql = db
      .raw(
        `SELECT x.s AS s, x.[key] AS [key], SUM(x.requests) AS n, SUM(x.errors) AS e,
                SUM(CAST(x.p95 AS bigint) * x.requests) AS p95w
           FROM (SELECT DATEDIFF(minute, ?, bucket) / ? AS s, [key], requests, errors, p95
                   FROM ${TABLE} WITH (NOLOCK)
                  WHERE bucket >= ? AND bucket < ? AND kind = ?${like}) x
          GROUP BY x.s, x.[key]`,
        [fromD, stepMin, fromD, toD, kind, ...(opts.prefix ? [`${opts.prefix}%`] : [])]
      )
      .toQuery()
    const rows = await runLongSql<{
      s: number
      key: string
      n: number
      e: number
      p95w: number | string
    }>(sql, { timeoutMs: STEPS_TIMEOUT_MS })
    return rows.map((r) => ({
      s: Number(r.s),
      key: String(r.key),
      n: Number(r.n) || 0,
      e: Number(r.e) || 0,
      p95: Number(r.n) > 0 ? Math.round(Number(r.p95w) / Number(r.n)) : 0
    }))
  }
  const q = db(TABLE)
    .where('bucket', '>=', fromD)
    .where('bucket', '<', toD)
    .where('kind', kind)
    .limit(200_000)
    .select('bucket', 'key', 'requests', 'errors', 'p95')
  if (opts.prefix) q.where('key', 'like', `${opts.prefix}%`)
  const rows = (await q) as Array<{
    bucket: Date | string
    key: string
    requests: number
    errors: number
    p95: number
  }>
  const groups = new Map<string, TimelapseGroup & { w: number }>()
  for (const r of rows) {
    const s = Math.floor((new Date(r.bucket).getTime() - from) / (stepMin * 60_000))
    const k = `${s}|${r.key}`
    const g = groups.get(k) ?? { s, key: r.key, n: 0, e: 0, p95: 0, w: 0 }
    g.n += Number(r.requests) || 0
    g.e += Number(r.errors) || 0
    g.w += (Number(r.p95) || 0) * (Number(r.requests) || 0)
    groups.set(k, g)
  }
  return [...groups.values()].map(({ w, ...g }) => ({ ...g, p95: g.n ? Math.round(w / g.n) : 0 }))
}

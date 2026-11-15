import type { Redis } from 'ioredis'
import { getApp } from './io-holder.js'
import { ackStampKey } from './realtime-ack-sample.js'
import { deliveryBucket } from './realtime-delivery-slo.js'
import { percentileFromHistogram } from './slo.js'

/**
 * Write-to-screen time (realtime round 5, item 25): from the moment a change is saved to the
 * moment ANOTHER open tab shows it.
 *
 * Built on the delivery acknowledgements (#2477). A small sample of live events carries `_st`,
 * the server time the event left — right after the write committed (broadcastCollectionUpdate
 * runs after the commit) — and the server keeps that stamp for 5 minutes (ackStampKey). A tab
 * on a screen that shows the collection notes when the event arrived (`rx`) and when the screen
 * finished re-drawing for it (`done`: the reads the event set off settled, then a painted frame
 * — packages/shared lib/write-to-screen.ts), both on the server clock. It sends those in a
 * batched telemetry beacon (POST /api/rum/screen-timing). A sample is kept only when its `st`
 * equals the stamp the server kept for that sequence, so nobody can invent timings.
 *
 * Kept as latency histograms in Redis per hour (15 days), never one row per sample:
 *   t|<bucket>                              write → on screen (total)
 *   d|<bucket>                              write → arrived in the tab (delivery)
 *   r|<bucket>                              arrived → on screen (render)
 *   s|<app>|<screen>|<collection>|<bucket>  total per screen and collection
 * Keys carry the tenant (`nvr:rt:w2s:<tenant>:h:<hour>`), so cloud tenants stay apart.
 */

const HOUR_MS = 3_600_000
const TTL_S = 15 * 86_400
/** A sample longer than this is a clock or sleep problem, not a screen update. */
export const W2S_MAX_MS = 60_000
/** The client's clock offset is an estimate: an arrival this much before the stamp still counts. */
const SKEW_MS = 500
export const W2S_MAX_SAMPLES_PER_BEACON = 10
export const W2S_SAMPLES_PER_MINUTE = 12

const SCREEN_OK = /^\/[A-Za-z0-9_\-/:.]{0,119}$/
const APP_OK = /^[A-Za-z0-9_.-]{1,40}$/
const COLLECTION_OK = /^[A-Za-z0-9_]{1,128}$/
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{24,})$/i

export interface W2SSample {
  seq: number
  st: number
  rx: number
  done: number
  screen: string
  collection: string
  app: string
}

/** A screen path → its pattern: id-like segments become `:id`, nothing else survives. */
export function screenPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const path = raw.split(/[?#]/)[0].trim()
  if (!path.startsWith('/') || path.startsWith('//')) return null
  const out = path
    .split('/')
    .map((seg) => (seg && !seg.startsWith(':') && ID_SEGMENT.test(seg) ? ':id' : seg))
    .join('/')
    .slice(0, 120)
  return SCREEN_OK.test(out) && !out.includes('|') ? out : null
}

/** One sample from a beacon, checked and clamped (pure); null = dropped. */
export function cleanSample(raw: unknown, fallbackApp?: unknown): W2SSample | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const seq = Number(p.seq)
  const st = Number(p.st)
  let rx = Number(p.rx)
  let done = Number(p.done)
  if (!Number.isSafeInteger(seq) || seq <= 0) return null
  if (![st, rx, done].every((n) => Number.isFinite(n) && n > 0)) return null
  // An estimated clock offset can put the arrival a moment before the stamp: clamp a small one.
  if (rx < st) {
    if (st - rx > SKEW_MS) return null
    rx = st
  }
  if (done < rx) {
    if (rx - done > SKEW_MS) return null
    done = rx
  }
  if (done - st > W2S_MAX_MS) return null
  const screen = screenPattern(p.screen)
  const collection = typeof p.collection === 'string' ? p.collection : ''
  if (!screen || !COLLECTION_OK.test(collection)) return null
  const appRaw = typeof p.app === 'string' && p.app ? p.app : fallbackApp
  const app = typeof appRaw === 'string' && APP_OK.test(appRaw) ? appRaw : 'app'
  return { seq, st, rx: Math.round(rx), done: Math.round(done), screen, collection, app }
}

/** The beacon's samples, cleaned and capped (pure). */
export function cleanBeacon(body: unknown): W2SSample[] {
  if (!body || typeof body !== 'object') return []
  const b = body as { samples?: unknown; app?: unknown }
  if (!Array.isArray(b.samples)) return []
  const out: W2SSample[] = []
  const seen = new Set<number>()
  for (const raw of b.samples.slice(0, W2S_MAX_SAMPLES_PER_BEACON)) {
    const s = cleanSample(raw, b.app)
    if (s && !seen.has(s.seq)) {
      seen.add(s.seq)
      out.push(s)
    }
  }
  return out
}

/** Per-person sample budget (a minute's sliding window); mutates `slots`. */
export function takeSampleSlots(
  slots: Map<string, number[]>,
  userId: string,
  want: number,
  now: number,
  perMinute = W2S_SAMPLES_PER_MINUTE
): number {
  const kept = (slots.get(userId) ?? []).filter((t) => now - t < 60_000)
  const n = Math.max(0, Math.min(want, perMinute - kept.length))
  for (let i = 0; i < n; i++) kept.push(now)
  slots.delete(userId)
  slots.set(userId, kept)
  while (slots.size > 5000) {
    const oldest = slots.keys().next().value
    if (oldest === undefined) break
    slots.delete(oldest)
  }
  return n
}

function redisOf(given?: Redis | null): Redis | null {
  if (given) return given
  try {
    return (getApp()?.redis as Redis | undefined) ?? null
  } catch {
    return null
  }
}

const tenantPart = (tenant: string | null | undefined) =>
  (tenant || '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || '-'
export const w2sHourKey = (tenant: string | null | undefined, hour: number) =>
  `nvr:rt:w2s:${tenantPart(tenant)}:h:${hour}`

/** The fields one sample adds to its hour's hash (pure). */
export function sampleFields(s: W2SSample): string[] {
  const total = s.done - s.st
  return [
    `t|${deliveryBucket(total)}`,
    `d|${deliveryBucket(s.rx - s.st)}`,
    `r|${deliveryBucket(s.done - s.rx)}`,
    `s|${s.app}|${s.screen}|${s.collection}|${deliveryBucket(total)}`
  ]
}

/**
 * Keep the samples whose stamp the server really made, in their hour's histogram. Resolves how
 * many were kept. Best effort: no Redis = nothing kept.
 */
export async function recordW2SSamples(
  samples: W2SSample[],
  opts: { tenant?: string | null; now?: number; redis?: Redis | null } = {}
): Promise<number> {
  const redis = redisOf(opts.redis)
  if (!redis || samples.length === 0) return 0
  try {
    const stamps = await redis.mget(...samples.map((s) => ackStampKey(s.seq)))
    const good = samples.filter((s, i) => stamps[i] != null && Number(stamps[i]) === s.st)
    if (good.length === 0) return 0
    const m = redis.multi()
    for (const s of good) {
      const key = w2sHourKey(opts.tenant, Math.floor(s.st / HOUR_MS))
      for (const f of sampleFields(s)) m.hincrby(key, f, 1)
      m.expire(key, TTL_S)
    }
    await m.exec()
    return good.length
  } catch {
    return 0
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

export interface W2SFigures {
  samples: number
  p50_ms: number | null
  p95_ms: number | null
}

export interface W2SReport {
  window_hours: number
  overall: W2SFigures
  delivery: W2SFigures
  render: W2SFigures
  hours: Array<W2SFigures & { hour: string }>
  screens: Array<W2SFigures & { app: string; screen: string; collection: string }>
}

function figures(hist: Map<number, number>): W2SFigures {
  const buckets = [...hist].map(([upper, n]) => ({ upper, n }))
  const samples = buckets.reduce((s, b) => s + b.n, 0)
  return {
    samples,
    p50_ms: percentileFromHistogram(buckets, 0.5),
    p95_ms: percentileFromHistogram(buckets, 0.95)
  }
}

function add(hist: Map<number, number>, bucket: string, n: unknown): void {
  const b = Number(bucket)
  const c = Number(n)
  if (!Number.isFinite(b) || !Number.isFinite(c) || c <= 0) return
  hist.set(b, (hist.get(b) ?? 0) + c)
}

/** The report from hourly hashes (pure). `hours[i]` is the hash for hour `hourIds[i]`. */
export function summarizeW2S(
  hourIds: number[],
  hashes: Array<Record<string, string> | null | undefined>
): W2SReport {
  const total = new Map<number, number>()
  const delivery = new Map<number, number>()
  const render = new Map<number, number>()
  const perScreen = new Map<string, Map<number, number>>()
  const hours: W2SReport['hours'] = []
  hourIds.forEach((hour, i) => {
    const h = hashes[i] ?? {}
    const hourTotal = new Map<number, number>()
    for (const [field, n] of Object.entries(h)) {
      const parts = field.split('|')
      const bucket = parts[parts.length - 1]
      if (parts[0] === 't') {
        add(total, bucket, n)
        add(hourTotal, bucket, n)
      } else if (parts[0] === 'd') add(delivery, bucket, n)
      else if (parts[0] === 'r') add(render, bucket, n)
      else if (parts[0] === 's' && parts.length === 5) {
        const k = parts.slice(1, 4).join('|')
        let hist = perScreen.get(k)
        if (!hist) {
          hist = new Map()
          perScreen.set(k, hist)
        }
        add(hist, bucket, n)
      }
    }
    hours.push({ hour: new Date(hour * HOUR_MS).toISOString(), ...figures(hourTotal) })
  })
  const screens = [...perScreen].map(([k, hist]) => {
    const [app, screen, collection] = k.split('|')
    return { app, screen, collection, ...figures(hist) }
  })
  // Slowest first (by p95), then the busiest.
  screens.sort((a, b) => (b.p95_ms ?? 0) - (a.p95_ms ?? 0) || b.samples - a.samples)
  return {
    window_hours: hourIds.length,
    overall: figures(total),
    delivery: figures(delivery),
    render: figures(render),
    hours,
    screens: screens.slice(0, 200)
  }
}

/** The hour ids a window covers (start inclusive, end exclusive), newest last; at most 14 days. */
export function hoursBetween(start: Date, end: Date): number[] {
  const from = Math.floor(start.getTime() / HOUR_MS)
  const to = Math.ceil(end.getTime() / HOUR_MS)
  const out: number[] = []
  for (let h = Math.max(from, to - 14 * 24); h < to; h++) out.push(h)
  return out
}

export async function loadW2SReport(
  start: Date,
  end: Date,
  opts: { tenant?: string | null; redis?: Redis | null } = {}
): Promise<W2SReport> {
  const hourIds = hoursBetween(start, end)
  const redis = redisOf(opts.redis)
  if (!redis || hourIds.length === 0) return summarizeW2S(hourIds, [])
  try {
    const pipe = redis.pipeline()
    for (const h of hourIds) pipe.hgetall(w2sHourKey(opts.tenant, h))
    const res = (await pipe.exec()) ?? []
    return summarizeW2S(
      hourIds,
      res.map((r) => (r?.[1] as Record<string, string> | null) ?? null)
    )
  } catch {
    return summarizeW2S(hourIds, [])
  }
}

const secs = (ms: number | null) =>
  ms == null ? '—' : ms < 1000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`

/** The daily report's rows (pure): the p95 headline, the median, the slowest screen. */
export function w2sSectionRows(r: W2SReport): Array<{
  key: string
  label: string
  value: number
  unit: 'ms' | 'count'
  note?: string
  href?: string
  better: 'down' | 'up'
}> {
  if (r.overall.samples === 0 || r.overall.p95_ms == null) return []
  const rows: ReturnType<typeof w2sSectionRows> = [
    {
      key: 'p95_ms',
      label: 'Changes reached other screens (p95)',
      value: r.overall.p95_ms,
      unit: 'ms',
      note: `Changes reached other screens in ${secs(r.overall.p95_ms)} p95 (median ${secs(r.overall.p50_ms)}, ${r.overall.samples} sampled changes)`,
      href: '/realtime?tab=screen',
      better: 'down'
    }
  ]
  const slow = r.screens.find((s) => s.samples >= 3)
  if (slow?.p95_ms != null)
    rows.push({
      key: 'slowest_screen_p95_ms',
      label: 'Slowest screen (p95)',
      value: slow.p95_ms,
      unit: 'ms',
      note: `${slow.screen} · ${slow.collection} (${slow.app}, ${slow.samples} samples)`,
      href: '/realtime?tab=screen',
      better: 'down'
    })
  return rows
}

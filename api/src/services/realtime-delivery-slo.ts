/**
 * Realtime delivery SLO (#2477). The SLO page already showed the realtime monitor (#1682) as
 * monitor uptime; this adds a latency SLO on socket delivery itself:
 *
 *   SLI     = share of deliveries that arrived within `delivery_p95_ms` (default 2 s)
 *   target  = `delivery_good_pct` of them (default 95 — "p95 under 2 s")
 *   burn    = bad share over the last 1h / 6h / 24h ÷ (1 − target), the same multi-window burn
 *             the request SLOs show; 1 spends the budget exactly over the window
 *
 * Two sources feed it:
 * - `probe` — the synthetic delivery probe's write-to-arrival time (realtime-probe.ts). A probe
 *   event that never arrived counts as a bad delivery.
 * - `client` — real clients acknowledging a small sample of events: every event whose journal
 *   sequence is a multiple of REALTIME_ACK_EVERY (default 50; 0 = off) carries `_st`, the server
 *   time it left (event-journal.ts locally, event-stream.ts for another replica's write). The
 *   client answers `rt:ack {seq, st, rx}` with its receive time on the server clock (#2132
 *   offset). The server keeps the client's figure only when it fits inside the round trip it can
 *   see itself (0 ≤ rx − st ≤ ack arrival − st), else estimates arrival − st − rtt/2.
 *
 * Samples are not kept one by one: they land in latency histograms in Redis (the same buckets
 * the request SLO uses), per 5 minutes for the last day (burn rates) and per hour for the window
 * (up to 14 days), split by source and by replica — `node` = this process's host name.
 */
import { hostname } from 'node:os'
import type { Redis } from 'ioredis'
import { getApp } from './io-holder.js'
import { ackEvery, ackSampled } from './realtime-ack-sample.js'
import { percentileFromHistogram } from './slo.js'

export type DeliverySource = 'probe' | 'client'

const MINUTE_KEY = 'nvr:rt:dlv:m:'
const HOUR_KEY = 'nvr:rt:dlv:h:'
const FIVE_MIN_MS = 300_000
const HOUR_MS = 3_600_000
const MINUTE_TTL_S = 26 * 3600
const HOUR_TTL_S = 15 * 86_400
export const DELIVERY_WINDOW_MAX_DAYS = 14
/** The longest delay a sample may claim; anything above is a clock problem, not a delivery. */
const MAX_DELAY_MS = 120_000

export { ackEvery, ackSampled }

export const DEFAULT_DELIVERY_TARGETS = { delivery_p95_ms: 2000, delivery_good_pct: 95 }

let _redis: Redis | null = null
/** Tests hand a Redis in; at runtime the app's own client is used. */
export function setDeliveryRedis(redis: Redis | null): void {
  _redis = redis
}
function redisOf(given?: Redis | null): Redis | null {
  if (given) return given
  if (_redis) return _redis
  try {
    return (getApp()?.redis as Redis | undefined) ?? null
  } catch {
    return null
  }
}

/** This replica's label in the per-node rows. */
export function deliveryNode(): string {
  const inst = process.env.NIVARO_INSTANCE?.trim() || process.env.NODE_ENV?.trim() || 'default'
  return `${inst} · ${hostname().slice(0, 40)}`
}

/** Latency → histogram bucket (upper edge in ms), matching the request SLO's buckets. */
export function deliveryBucket(ms: number): number {
  if (ms < 1000) return (Math.floor(ms / 25) + 1) * 25
  if (ms < 10_000) return (Math.floor(ms / 250) + 1) * 250
  return (Math.floor(ms / 5000) + 1) * 5000
}

/**
 * The delay one acknowledgement stands for, or null when it cannot be trusted (pure).
 * `st` = server time the event left, `rx` = the client's receive time on the server clock,
 * `ackAt` = server time the ack arrived, `rttMs` = the socket's last measured round trip.
 */
export function ackDelayMs(a: {
  st: unknown
  rx: unknown
  ackAt: number
  rttMs: number | null
}): number | null {
  const st = Number(a.st)
  if (!Number.isFinite(st) || st <= 0) return null
  const ceiling = a.ackAt - st
  if (!(ceiling >= 0) || ceiling > MAX_DELAY_MS) return null
  const rx = Number(a.rx)
  if (Number.isFinite(rx) && rx > 0) {
    const d = rx - st
    if (d >= 0 && d <= ceiling) return Math.round(d)
  }
  const half = a.rttMs != null && a.rttMs > 0 ? a.rttMs / 2 : 0
  return Math.max(0, Math.round(ceiling - half))
}

function field(source: DeliverySource, node: string, bucket: number | 'x'): string {
  return `${source}|${node.replace(/\|/g, '/')}|${bucket}`
}

/** Record one delivery: `ms` null = it never arrived (a bad delivery). Best effort. */
export async function noteDeliverySample(
  source: DeliverySource,
  ms: number | null,
  opts: { node?: string; at?: number; redis?: Redis | null } = {}
): Promise<void> {
  const redis = redisOf(opts.redis)
  if (!redis) return
  if (ms != null && (!Number.isFinite(ms) || ms < 0 || ms > MAX_DELAY_MS)) return
  const at = opts.at ?? Date.now()
  const f = field(source, opts.node ?? deliveryNode(), ms == null ? 'x' : deliveryBucket(ms))
  const mKey = `${MINUTE_KEY}${Math.floor(at / FIVE_MIN_MS)}`
  const hKey = `${HOUR_KEY}${Math.floor(at / HOUR_MS)}`
  try {
    await redis
      .multi()
      .hincrby(mKey, f, 1)
      .expire(mKey, MINUTE_TTL_S)
      .hincrby(hKey, f, 1)
      .expire(hKey, HOUR_TTL_S)
      .exec()
  } catch {
    /* a lost sample never matters */
  }
}

// ─── Acknowledgements ──────────────────────────────────────────────────────────

const lastAckAt = new Map<string, number>()
/** One acknowledgement per socket per this many ms (a client cannot flood the histograms). */
const ACK_MIN_GAP_MS = 5000

/** The `rt:ack` handler body for one socket. Returns the delay it recorded (or null). */
export function acceptAck(
  socketId: string,
  payload: unknown,
  rttMs: number | null,
  now: number = Date.now()
): number | null {
  if (ackEvery() === 0) return null
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  if (!ackSampled(Number(p.seq))) return null
  const last = lastAckAt.get(socketId) ?? 0
  if (now - last < ACK_MIN_GAP_MS) return null
  const ms = ackDelayMs({ st: p.st, rx: p.rx, ackAt: now, rttMs })
  if (ms == null) return null
  lastAckAt.set(socketId, now)
  if (lastAckAt.size > 20_000) lastAckAt.clear()
  void noteDeliverySample('client', ms, { at: now })
  return ms
}

export function forgetAckSocket(socketId: string): void {
  lastAckAt.delete(socketId)
}

// ─── Report ────────────────────────────────────────────────────────────────────

export interface DeliveryTargets {
  delivery_p95_ms: number
  delivery_good_pct: number
  window_days: number
}

export interface DeliveryFigures {
  samples: number
  missed: number
  p95_ms: number | null
  good_pct: number | null
}

export interface DeliverySlo {
  target_ms: number
  good_pct_target: number
  window_days: number
  overall: DeliveryFigures & { meets: boolean | null }
  by_source: Record<DeliverySource, DeliveryFigures>
  by_node: Array<DeliveryFigures & { node: string; source: DeliverySource }>
  burn: { h1: number | null; h6: number | null; h24: number | null }
  days: Array<DeliveryFigures & { day: string }>
  ack_every: number
}

type Counts = Map<string, number>

function addHash(into: Counts, h: Record<string, string> | null | undefined): void {
  if (!h) return
  for (const [k, v] of Object.entries(h)) into.set(k, (into.get(k) ?? 0) + (Number(v) || 0))
}

/** Figures from `source|node|bucket` counts, optionally narrowed (pure). */
export function figuresOf(
  counts: Counts,
  targetMs: number,
  keep: (source: string, node: string) => boolean = () => true
): DeliveryFigures {
  const buckets = new Map<number, number>()
  let samples = 0
  let missed = 0
  let good = 0
  for (const [k, n] of counts) {
    const [source, node, b] = k.split('|')
    if (!keep(source, node)) continue
    samples += n
    if (b === 'x') {
      missed += n
      continue
    }
    const upper = Number(b)
    if (!Number.isFinite(upper)) continue
    buckets.set(upper, (buckets.get(upper) ?? 0) + n)
    if (upper <= targetMs) good += n
  }
  // A missed delivery is slower than anything: it sits above every bucket for the percentile.
  if (missed) buckets.set(Number.MAX_SAFE_INTEGER, missed)
  const p95 = percentileFromHistogram(
    [...buckets].map(([upper, n]) => ({ upper, n })),
    0.95
  )
  return {
    samples,
    missed,
    p95_ms: p95 === Number.MAX_SAFE_INTEGER ? null : p95,
    good_pct: samples ? Math.round((good / samples) * 100_000) / 1000 : null
  }
}

/** Burn rate of a window's figures against the target share (pure). */
export function burnOf(f: DeliveryFigures, goodPctTarget: number): number | null {
  const allowed = 1 - goodPctTarget / 100
  if (!f.samples || f.good_pct == null || allowed <= 0) return null
  return Math.round(((1 - f.good_pct / 100) / allowed) * 100) / 100
}

async function readHashes(redis: Redis, keys: string[]): Promise<Array<Record<string, string>>> {
  if (keys.length === 0) return []
  const pipe = redis.pipeline()
  for (const k of keys) pipe.hgetall(k)
  const out = (await pipe.exec()) ?? []
  return out.map(([, v]) => (v ?? {}) as Record<string, string>)
}

export async function computeDeliverySlo(
  targets: DeliveryTargets,
  opts: { redis?: Redis | null; now?: number } = {}
): Promise<DeliverySlo | null> {
  const redis = redisOf(opts.redis)
  if (!redis) return null
  const now = opts.now ?? Date.now()
  const days = Math.min(DELIVERY_WINDOW_MAX_DAYS, Math.max(1, targets.window_days))
  const target = targets.delivery_p95_ms

  const hNow = Math.floor(now / HOUR_MS)
  const hourKeys = Array.from({ length: days * 24 }, (_, i) => hNow - i)
  const mNow = Math.floor(now / FIVE_MIN_MS)
  const minuteKeys = Array.from({ length: 24 * 12 }, (_, i) => mNow - i)
  let hours: Array<Record<string, string>>
  let minutes: Array<Record<string, string>>
  try {
    hours = await readHashes(
      redis,
      hourKeys.map((h) => `${HOUR_KEY}${h}`)
    )
    minutes = await readHashes(
      redis,
      minuteKeys.map((m) => `${MINUTE_KEY}${m}`)
    )
  } catch {
    return null
  }

  const all: Counts = new Map()
  const perDay = new Map<string, Counts>()
  hours.forEach((h, i) => {
    addHash(all, h)
    const day = new Date(hourKeys[i] * HOUR_MS).toISOString().slice(0, 10)
    const c = perDay.get(day) ?? new Map()
    addHash(c, h)
    perDay.set(day, c)
  })
  const windowOf = (n5: number): Counts => {
    const c: Counts = new Map()
    for (let i = 0; i < Math.min(n5, minutes.length); i++) addHash(c, minutes[i])
    return c
  }

  const nodes = new Set<string>()
  for (const k of all.keys()) {
    const [source, node] = k.split('|')
    if (node) nodes.add(`${source}|${node}`)
  }
  const overall = figuresOf(all, target)
  return {
    target_ms: target,
    good_pct_target: targets.delivery_good_pct,
    window_days: days,
    overall: {
      ...overall,
      meets: overall.good_pct == null ? null : overall.good_pct >= targets.delivery_good_pct
    },
    by_source: {
      probe: figuresOf(all, target, (s) => s === 'probe'),
      client: figuresOf(all, target, (s) => s === 'client')
    },
    by_node: [...nodes]
      .map((sn) => {
        const [source, node] = sn.split('|') as [DeliverySource, string]
        return {
          node,
          source,
          ...figuresOf(all, target, (s, n) => s === source && n === node)
        }
      })
      .sort((a, b) => b.samples - a.samples),
    burn: {
      h1: burnOf(figuresOf(windowOf(12), target), targets.delivery_good_pct),
      h6: burnOf(figuresOf(windowOf(72), target), targets.delivery_good_pct),
      h24: burnOf(figuresOf(windowOf(288), target), targets.delivery_good_pct)
    },
    days: [...perDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, c]) => ({ day, ...figuresOf(c, target) }))
      .filter((d) => d.samples > 0),
    ack_every: ackEvery()
  }
}

// ─── Burn-rate alert ───────────────────────────────────────────────────────────

export type BurnVerdict = { state: 'ok' } | { state: 'fast' | 'slow'; burn: number }

/**
 * Multi-window verdict (pure): fast = the last hour burns ≥ 14× (a 30-day budget gone in about
 * two days) over at least 6 samples; slow = the last 6 hours burn ≥ 6× over at least 24.
 */
export function burnVerdict(f: {
  h1: { burn: number | null; samples: number }
  h6: { burn: number | null; samples: number }
}): BurnVerdict {
  if (f.h1.burn != null && f.h1.samples >= 6 && f.h1.burn >= 14)
    return { state: 'fast', burn: f.h1.burn }
  if (f.h6.burn != null && f.h6.samples >= 24 && f.h6.burn >= 6)
    return { state: 'slow', burn: f.h6.burn }
  return { state: 'ok' }
}

/**
 * After the realtime monitor ran: raise (or bump) one issue while delivery burns its budget.
 * The message carries no numbers so the issue dedupes; the figures are on the SLO page.
 */
export async function evaluateDeliveryBurn(targets: DeliveryTargets): Promise<BurnVerdict> {
  const redis = redisOf()
  if (!redis) return { state: 'ok' }
  const now = Date.now()
  const mNow = Math.floor(now / FIVE_MIN_MS)
  let minutes: Array<Record<string, string>>
  try {
    minutes = await readHashes(
      redis,
      Array.from({ length: 72 }, (_, i) => `${MINUTE_KEY}${mNow - i}`)
    )
  } catch {
    return { state: 'ok' }
  }
  const win = (n: number) => {
    const c: Counts = new Map()
    for (let i = 0; i < n; i++) addHash(c, minutes[i])
    const f = figuresOf(c, targets.delivery_p95_ms)
    return { burn: burnOf(f, targets.delivery_good_pct), samples: f.samples }
  }
  const verdict = burnVerdict({ h1: win(12), h6: win(72) })
  if (verdict.state === 'ok') return verdict
  try {
    const { trackError } = await import('./error-tracking.js')
    await trackError({
      source: 'server',
      route: 'realtime/delivery-slo',
      severity: verdict.state === 'fast' ? 'high' : 'medium',
      message:
        verdict.state === 'fast'
          ? 'Realtime delivery SLO is burning its error budget fast (last hour)'
          : 'Realtime delivery SLO is burning its error budget (last 6 hours)'
    })
  } catch {
    /* the SLO page still shows it */
  }
  return verdict
}

/** One figure for a metric alert rule (`realtime_slo` source in metric-alerts.ts). */
export async function deliverySloMetric(
  metric: 'p95_ms' | 'good_pct' | 'burn_1h' | 'burn_6h' | 'samples',
  targets: DeliveryTargets
): Promise<number | null> {
  const slo = await computeDeliverySlo({ ...targets, window_days: 1 })
  if (!slo) return null
  if (metric === 'burn_1h') return slo.burn.h1
  if (metric === 'burn_6h') return slo.burn.h6
  if (metric === 'samples') return slo.overall.samples
  if (metric === 'good_pct') return slo.overall.good_pct
  return slo.overall.p95_ms
}

import { _backgroundDb, _staticDb, db } from '../db/index.js'
import type { PoolName } from '../db/pool-context.js'
import { currentRequestHint } from './request-trace.js'

/**
 * Pool leak attribution (#304): tarn (knex's pool) emits acquire/release
 * events — each acquired connection is stamped with when and for WHICH request
 * (the trace ALS's URL hint; crons show as null). Connections held past 30s
 * are reported with their holder, which turns "the pool is exhausted" into
 * "these two routes are holding connections".
 *
 * #1321 — tracked per pool: 'main' (interactive requests) and 'background'
 * (crons, imports, warms; only when DB_POOL_BACKGROUND_MAX > 0). Every reader
 * defaults to 'main', the pool a person waits on.
 */

interface Held {
  at: number
  hint: string | null
}

// ─── Pool pressure (#493) ────────────────────────────────────────────────────
// Saturation was invisible until measured by hand: identical 80ms statements
// read 2176ms at DB_POOL_MAX 25 and 447ms at 60, because the time went into
// WAITING for a connection, which no query timing shows. tarn emits
// acquireRequest / acquireSuccess per checkout; pairing them gives the wait.
// A rolling window keeps the last WINDOW_MS of waits plus 5s samples of the
// pool's in-use / pending counts, so the panel and the monitor cron can say
// "p95 wait 340ms, saturated 31% of the last five minutes" instead of a
// point sample that happened to land between bursts.

const WINDOW_MS = 5 * 60_000
const SAMPLE_MS = 5_000

interface Tracker {
  held: Map<unknown, Held>
  pendingAcquire: Map<unknown, number>
  waits: Array<{ at: number; ms: number }>
  samples: Array<{ at: number; used: number; pending: number; saturated: boolean }>
  attached: TarnPool | null
}

function tracker(): Tracker {
  return { held: new Map(), pendingAcquire: new Map(), waits: [], samples: [], attached: null }
}

const trackers: Record<PoolName, Tracker> = { main: tracker(), background: tracker() }
let sampler: NodeJS.Timeout | null = null

// A busy import checks out hundreds of thousands of connections inside one window. Dropping
// expired entries with shift() in a loop copied the whole array per entry — O(n²) — and froze
// the event loop for 48–90 s five minutes after a 6k–14k-row import (2026-10-29: the staging
// worker failed its health check and was killed). Expired entries are now cut with ONE splice,
// and the window keeps at most MAX_WAITS waits (the newest), which is plenty for percentiles.
const MAX_WAITS = 50_000

/** Index of the first entry at or after `cutoff` (entries are in time order). */
export function firstAtOrAfter(list: ReadonlyArray<{ at: number }>, cutoff: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (list[mid].at < cutoff) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function pruneWindow<T extends { at: number }>(
  list: T[],
  cutoff: number,
  max: number
): void {
  const drop = Math.max(firstAtOrAfter(list, cutoff), list.length - max)
  if (drop > 0) list.splice(0, drop)
}

function prune(t: Tracker, now: number): void {
  pruneWindow(t.waits, now - WINDOW_MS, MAX_WAITS)
  pruneWindow(t.samples, now - WINDOW_MS, Number.MAX_SAFE_INTEGER)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx]
}

export interface PoolPressure {
  window_s: number
  acquires: number
  wait_p50_ms: number
  wait_p95_ms: number
  wait_max_ms: number
  /** Share of the window's samples with every connection in use. */
  saturated_pct: number
  peak_used: number
  peak_pending: number
  max: number
}

export function poolPressure(which: PoolName = 'main'): PoolPressure {
  const now = Date.now()
  const t = trackers[which]
  prune(t, now)
  const sorted = t.waits.map((w) => w.ms).sort((a, b) => a - b)
  const pool = poolOf(which)
  const max = pool?.max ?? 0
  return {
    window_s: WINDOW_MS / 1000,
    acquires: t.waits.length,
    wait_p50_ms: Math.round(percentile(sorted, 0.5)),
    wait_p95_ms: Math.round(percentile(sorted, 0.95)),
    wait_max_ms: Math.round(sorted[sorted.length - 1] ?? 0),
    saturated_pct: t.samples.length
      ? Math.round((t.samples.filter((s) => s.saturated).length / t.samples.length) * 100)
      : 0,
    peak_used: t.samples.reduce((m, s) => Math.max(m, s.used), 0),
    peak_pending: t.samples.reduce((m, s) => Math.max(m, s.pending), 0),
    max
  }
}

interface TarnPool {
  on: (ev: string, fn: (...a: unknown[]) => void) => void
  numUsed?: () => number
  numFree?: () => number
  numPendingAcquires?: () => number
  numPendingCreates?: () => number
  max?: number
}

/** The pool's counters right now (null = no tarn pool, e.g. in tests, or the background pool is off). */
export function poolNow(
  which: PoolName = 'main'
): { used: number; pending: number; max: number } | null {
  const pool = poolOf(which)
  if (!pool) return null
  return {
    used: pool.numUsed?.() ?? 0,
    pending: pool.numPendingAcquires?.() ?? 0,
    max: pool.max ?? 0
  }
}

/** Full tarn counters for one pool — /ops-db/pool, /ops/runtime, the health detail. */
export function poolCounters(which: PoolName = 'main'): {
  used: number
  free: number
  pending_acquires: number
  pending_creates: number
  max: number
} | null {
  const pool = poolOf(which)
  if (!pool) return null
  return {
    used: pool.numUsed?.() ?? 0,
    free: pool.numFree?.() ?? 0,
    pending_acquires: pool.numPendingAcquires?.() ?? 0,
    pending_creates: pool.numPendingCreates?.() ?? 0,
    max: pool.max ?? 0
  }
}

/** True when this process runs a separate background pool (DB_POOL_BACKGROUND_MAX > 0, self-hosted). */
export function backgroundPoolEnabled(): boolean {
  return poolOf('background') !== null
}

function tarnOf(k: unknown): TarnPool | null {
  const pool = (k as { client?: { pool?: TarnPool } } | null | undefined)?.client?.pool
  return pool && typeof pool.on === 'function' ? pool : null
}

function poolOf(which: PoolName): TarnPool | null {
  if (which === 'background') return _backgroundDb ? tarnOf(_backgroundDb) : null
  // Cloud mode: the request's tenant pool (resolved by the db proxy); self-hosted:
  // the main pool explicitly, whatever pool the caller itself is bound to.
  return process.env.CLOUD_META_DB_URL ? tarnOf(db) : tarnOf(_staticDb)
}

function attach(which: PoolName): void {
  const t = trackers[which]
  const pool = poolOf(which)
  if (!pool || t.attached === pool) return
  t.attached = pool
  pool.on('acquireRequest', (eventId: unknown) => {
    t.pendingAcquire.set(eventId, performance.now())
  })
  pool.on('acquireFail', (eventId: unknown) => {
    t.pendingAcquire.delete(eventId)
  })
  pool.on('acquireSuccess', (eventId: unknown, resource: unknown) => {
    const started = t.pendingAcquire.get(eventId)
    if (started !== undefined) {
      t.pendingAcquire.delete(eventId)
      t.waits.push({ at: Date.now(), ms: performance.now() - started })
    }
    t.held.set(resource, { at: Date.now(), hint: currentRequestHint() })
  })
  pool.on('release', (resource: unknown) => {
    t.held.delete(resource)
  })
  pool.on('destroySuccess', (_eventId: unknown, resource: unknown) => {
    t.held.delete(resource)
  })
}

export function startPoolAttribution(): void {
  attach('main')
  attach('background')
  if (!sampler) {
    sampler = setInterval(() => {
      for (const which of ['main', 'background'] as const) {
        const p = poolOf(which)
        if (!p) continue
        const t = trackers[which]
        const used = p.numUsed?.() ?? 0
        const pending = p.numPendingAcquires?.() ?? 0
        const max = p.max ?? 0
        t.samples.push({ at: Date.now(), used, pending, saturated: max > 0 && used >= max })
        prune(t, Date.now())
      }
    }, SAMPLE_MS)
    sampler.unref()
  }
}

export function heldConnections(
  which: PoolName = 'main'
): Array<{ held_ms: number; hint: string | null }> {
  const now = Date.now()
  return [...trackers[which].held.values()]
    .map((h) => ({ held_ms: now - h.at, hint: h.hint }))
    .filter((h) => h.held_ms > 1000)
    .sort((a, b) => b.held_ms - a.held_ms)
    .slice(0, 50)
}

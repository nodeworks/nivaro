import { db } from '../db/index.js'
import { currentRequestHint } from './request-trace.js'

/**
 * Pool leak attribution (#304): tarn (knex's pool) emits acquire/release
 * events — each acquired connection is stamped with when and for WHICH request
 * (the trace ALS's URL hint; crons show as null). Connections held past 30s
 * are reported with their holder, which turns "the pool is exhausted" into
 * "these two routes are holding connections".
 */

interface Held {
  at: number
  hint: string | null
}

const held = new Map<unknown, Held>()

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

const pendingAcquire = new Map<unknown, number>()
const waits: Array<{ at: number; ms: number }> = []
const samples: Array<{ at: number; used: number; pending: number; saturated: boolean }> = []
let sampler: NodeJS.Timeout | null = null

function prune(now: number): void {
  while (waits.length && waits[0].at < now - WINDOW_MS) waits.shift()
  while (samples.length && samples[0].at < now - WINDOW_MS) samples.shift()
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

export function poolPressure(): PoolPressure {
  const now = Date.now()
  prune(now)
  const sorted = waits.map((w) => w.ms).sort((a, b) => a - b)
  const pool = poolOf()
  const max = pool?.max ?? 0
  return {
    window_s: WINDOW_MS / 1000,
    acquires: waits.length,
    wait_p50_ms: Math.round(percentile(sorted, 0.5)),
    wait_p95_ms: Math.round(percentile(sorted, 0.95)),
    wait_max_ms: Math.round(sorted[sorted.length - 1] ?? 0),
    saturated_pct: samples.length
      ? Math.round((samples.filter((s) => s.saturated).length / samples.length) * 100)
      : 0,
    peak_used: samples.reduce((m, s) => Math.max(m, s.used), 0),
    peak_pending: samples.reduce((m, s) => Math.max(m, s.pending), 0),
    max
  }
}

interface TarnPool {
  on: (ev: string, fn: (...a: unknown[]) => void) => void
  numUsed?: () => number
  numPendingAcquires?: () => number
  max?: number
}

function poolOf(): TarnPool | null {
  const pool = (db.client as unknown as { pool?: TarnPool }).pool
  return pool && typeof pool.on === 'function' ? pool : null
}

export function startPoolAttribution(): void {
  const pool = poolOf()
  if (!pool) return
  pool.on('acquireRequest', (eventId: unknown) => {
    pendingAcquire.set(eventId, performance.now())
  })
  pool.on('acquireFail', (eventId: unknown) => {
    pendingAcquire.delete(eventId)
  })
  pool.on('acquireSuccess', (eventId: unknown, resource: unknown) => {
    const started = pendingAcquire.get(eventId)
    if (started !== undefined) {
      pendingAcquire.delete(eventId)
      waits.push({ at: Date.now(), ms: performance.now() - started })
    }
    held.set(resource, { at: Date.now(), hint: currentRequestHint() })
  })
  if (!sampler) {
    sampler = setInterval(() => {
      const p = poolOf()
      if (!p) return
      const used = p.numUsed?.() ?? 0
      const pending = p.numPendingAcquires?.() ?? 0
      const max = p.max ?? 0
      samples.push({ at: Date.now(), used, pending, saturated: max > 0 && used >= max })
      prune(Date.now())
    }, SAMPLE_MS)
    sampler.unref()
  }
  pool.on('release', (resource: unknown) => {
    held.delete(resource)
  })
  pool.on('destroySuccess', (_eventId: unknown, resource: unknown) => {
    held.delete(resource)
  })
}

export function heldConnections(): Array<{ held_ms: number; hint: string | null }> {
  const now = Date.now()
  return [...held.values()]
    .map((h) => ({ held_ms: now - h.at, hint: h.hint }))
    .filter((h) => h.held_ms > 1000)
    .sort((a, b) => b.held_ms - a.held_ms)
    .slice(0, 50)
}

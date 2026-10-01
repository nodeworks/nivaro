// api/src/services/traffic-taps/queue-cache.ts
/**
 * Traffic Map tap `queue-cache` (#1175) — what keeping materialized queues current costs.
 *   • per queue: rows re-synced, their total / worst time and failures (syncMaterializedQueueItem
 *     times each source it resyncs and calls noteQueueSync);
 *   • per written collection: the per-write lookup every business write pays to learn whether any
 *     materialized queue reads it (noteQueueLookup, from hooks/queue-materialization.ts).
 * The route adds what the database holds: which queues are materialized, their backfill runs
 * (nivaro_job_runs kind 'backfill', job_id = the queue id) and time since the last rebuild.
 * Memory only on the write path; never throws into a write.
 */
import { db } from '../../db/index.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { boundedGet, MinuteSlots } from './minute-slots.js'

export const QUEUE_CACHE_TAP = 'queue-cache'
const QUEUE_CAP = 200
const COLLECTION_CAP = 300
// queue slots: rows synced, ms, failed
const Q = { n: 0, ms: 1, failed: 2 } as const
// lookup slots: writes, ms, writes that found a materialized queue
const L = { n: 0, ms: 1, hit: 2 } as const

interface QueueFig {
  slots: MinuteSlots
  /** collections whose writes this queue resynced (for the canvas edges) */
  collections: Set<string>
  maxMs: number
  lastAt: number
}
interface State {
  queues: Map<string, QueueFig>
  lookups: Map<string, MinuteSlots>
}
const state = () =>
  tapState<State>(QUEUE_CACHE_TAP, () => ({ queues: new Map(), lookups: new Map() }))

const nowSec = () => Math.floor(Date.now() / 1000)

/** One materialized queue resynced one row of `collection`. */
export function noteQueueSync(
  queueId: string,
  collection: string,
  ms: number,
  failed = false,
  at = Date.now()
): void {
  try {
    const q = boundedGet(state().queues, String(queueId).toUpperCase(), QUEUE_CAP, () => ({
      slots: new MinuteSlots(3),
      collections: new Set<string>(),
      maxMs: 0,
      lastAt: 0
    }))
    if (!q) return
    const sec = Math.floor(at / 1000)
    q.slots.add(sec, Q.n, 1)
    q.slots.add(sec, Q.ms, Math.max(0, ms))
    if (failed) q.slots.add(sec, Q.failed, 1)
    if (q.collections.size < 20) q.collections.add(collection)
    if (ms > q.maxMs) q.maxMs = ms
    q.lastAt = at
  } catch {
    /* never into a write */
  }
}

/** The per-write "does a materialized queue read this collection?" check. */
export function noteQueueLookup(collection: string, ms: number, found: boolean): void {
  try {
    const l = boundedGet(state().lookups, collection, COLLECTION_CAP, () => new MinuteSlots(3))
    if (!l) return
    const sec = nowSec()
    l.add(sec, L.n, 1)
    l.add(sec, L.ms, Math.max(0, ms))
    if (found) l.add(sec, L.hit, 1)
  } catch {
    /* never into a write */
  }
}

export interface QueueCacheRow {
  id: string
  name: string
  materialized: boolean
  rows: number | null
  /** Rows re-synced in the window, their summed and average time, failures. */
  syncs: number
  sync_ms: number
  avg_ms: number | null
  max_ms: number | null
  failed: number
  /** Collections whose writes it resynced in the window. */
  collections: string[]
  last_sync_at: number | null
  backfill: {
    runs: number
    last_status: string | null
    last_started_at: string | null
    last_duration_ms: number | null
    running: boolean
  }
  /** Seconds since the last completed backfill (the last full rebuild); null = never. */
  since_rebuild_s: number | null
}
export interface QueueCacheFigures {
  window_s: number
  queues: QueueCacheRow[]
  /** Per written collection: writes, total lookup ms, writes that found a materialized queue. */
  lookups: Array<{ collection: string; writes: number; ms: number; hits: number }>
}

/** The in-memory figures for one window (pure over the tap state; the route adds the DB side). */
export function queueCacheMemory(
  windowS: number,
  sec: number
): {
  queues: Map<
    string,
    {
      syncs: number
      ms: number
      failed: number
      collections: string[]
      maxMs: number
      lastAt: number
    }
  >
  lookups: QueueCacheFigures['lookups']
} {
  const queues = new Map<
    string,
    {
      syncs: number
      ms: number
      failed: number
      collections: string[]
      maxMs: number
      lastAt: number
    }
  >()
  for (const [id, q] of state().queues) {
    const [n, ms, failed] = q.slots.sum(windowS, sec)
    queues.set(id, {
      syncs: n,
      ms,
      failed,
      collections: [...q.collections],
      maxMs: q.maxMs,
      lastAt: q.lastAt
    })
  }
  const lookups: QueueCacheFigures['lookups'] = []
  for (const [collection, l] of state().lookups) {
    const [writes, ms, hits] = l.sum(windowS, sec)
    if (writes > 0) lookups.push({ collection, writes, ms: Math.round(ms * 10) / 10, hits })
  }
  lookups.sort((a, b) => b.ms - a.ms)
  return { queues, lookups: lookups.slice(0, 30) }
}

/** Materialized queues (and any queue that synced in the window) with their backfill history. */
export async function queueCacheFigures(windowS: number, sec: number): Promise<QueueCacheFigures> {
  const mem = queueCacheMemory(windowS, sec)
  const queues = (await db('nivaro_queues')
    .where({ materialized: true })
    .select('id', 'name', 'materialized')
    .catch(() => [])) as Array<{ id: string; name: string; materialized: unknown }>
  const ids = new Set(queues.map((q) => String(q.id).toUpperCase()))
  // a queue demoted mid-window still shows what its syncs cost
  const extra = [...mem.queues.keys()].filter((id) => !ids.has(id))
  if (extra.length) {
    const more = (await db('nivaro_queues')
      .whereIn('id', extra.slice(0, 100))
      .select('id', 'name', 'materialized')
      .catch(() => [])) as typeof queues
    queues.push(...more)
  }
  const all = queues.map((q) => String(q.id))
  const counts = new Map<string, number>()
  const runs = new Map<
    string,
    Array<{ status: string; started_at: unknown; finished_at: unknown; duration_ms: unknown }>
  >()
  if (all.length) {
    const rows = (await db('nivaro_queue_items')
      .whereIn('queue_id', all)
      .groupBy('queue_id')
      .select('queue_id')
      .count({ n: '*' })
      .catch(() => [])) as Array<{ queue_id: string; n: number | string }>
    for (const r of rows) counts.set(String(r.queue_id).toUpperCase(), Number(r.n))
    const jr = (await db('nivaro_job_runs')
      .where({ kind: 'backfill' })
      .whereIn('job_id', all)
      .orderBy('id', 'desc')
      .limit(all.length * 10)
      .select('job_id', 'status', 'started_at', 'finished_at', 'duration_ms')
      .catch(() => [])) as Array<{
      job_id: string
      status: string
      started_at: unknown
      finished_at: unknown
      duration_ms: unknown
    }>
    for (const r of jr) {
      const k = String(r.job_id).toUpperCase()
      const list = runs.get(k) ?? []
      list.push(r)
      runs.set(k, list)
    }
  }
  const iso = (v: unknown) => {
    if (!v) return null
    const d = new Date(v as string)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const now = Date.now()
  const out: QueueCacheRow[] = queues.map((q) => {
    const id = String(q.id)
    const m = mem.queues.get(id.toUpperCase())
    const list = runs.get(id.toUpperCase()) ?? []
    const last = list[0]
    const lastDone = list.find((r) => r.status === 'completed')
    const doneAt = lastDone ? Date.parse(iso(lastDone.finished_at) ?? '') : Number.NaN
    return {
      id,
      name: q.name,
      materialized: q.materialized === true || q.materialized === 1,
      rows: counts.get(id.toUpperCase()) ?? null,
      syncs: m?.syncs ?? 0,
      sync_ms: Math.round((m?.ms ?? 0) * 10) / 10,
      avg_ms: m?.syncs ? Math.round((m.ms / m.syncs) * 10) / 10 : null,
      max_ms: m?.syncs ? Math.round(m.maxMs * 10) / 10 : null,
      failed: m?.failed ?? 0,
      collections: m?.collections ?? [],
      last_sync_at: m?.lastAt || null,
      backfill: {
        runs: list.length,
        last_status: last?.status ?? null,
        last_started_at: iso(last?.started_at),
        last_duration_ms: last?.duration_ms == null ? null : Number(last.duration_ms),
        running: last?.status === 'running'
      },
      since_rebuild_s: Number.isFinite(doneAt)
        ? Math.max(0, Math.round((now - doneAt) / 1000))
        : null
    }
  })
  out.sort((a, b) => b.sync_ms - a.sync_ms || a.name.localeCompare(b.name))
  return { window_s: windowS, queues: out, lookups: mem.lookups }
}

export const queueCacheTap: TrafficTap = {
  id: QUEUE_CACHE_TAP,
  sweep(sec) {
    const s = state()
    for (const [id, q] of s.queues) if (q.slots.idle(sec)) s.queues.delete(id)
    for (const [c, l] of s.lookups) if (l.idle(sec)) s.lookups.delete(c)
  }
}

registerTrafficTap(queueCacheTap)

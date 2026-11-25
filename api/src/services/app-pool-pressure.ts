/**
 * Pool pressure per app on a Hub shared deployment.
 *
 * Self-hosted, the pool monitor (#114 / #493, services/pool-attribution.ts) judges the process's
 * own pool over the last five minutes of acquire waits and 5-second samples. On a shared
 * deployment every app has a pool of its own (its placement's pool size) and the process's
 * static pool is a stand-in that never runs a statement, so that figure said nothing. Here each
 * app's pool is watched the same way:
 *  - when the app becomes ready (and again on each monitor run, for an app adopted earlier),
 *    its pool's acquire events are timed and its in-use / pending counts are sampled every 5 s;
 *  - the `app-pool-monitor` job (once per app, every 5 minutes) raises one deduped issue in that
 *    app's own issue log when its pool is under pressure — same rule as self-hosted;
 *  - `appPoolTotals()` sums every watched app pool for the deployment link status, which only the
 *    Hub operator reads (counts only, never which app).
 *
 * An app that leaves the process is dropped with forgetAppState (registerAppKeyed); its pool's
 * listeners stay attached but do nothing until the app comes back and is watched again.
 */
import { getTenantDb } from '../db/tenant-context.js'
import { registerAppKeyed } from './app-forget.js'
import type { PoolPressure } from './pool-attribution.js'
import { onAppReady } from './tenancy/app-lifecycle.js'
import { currentTenantKey } from './tenant-rooms.js'

const WINDOW_MS = 5 * 60_000
const SAMPLE_MS = 5_000
const MAX_WAITS = 20_000

interface TarnPool {
  on: (ev: string, fn: (...a: unknown[]) => void) => void
  numUsed?: () => number
  numFree?: () => number
  numPendingAcquires?: () => number
  max?: number
}

interface AppTracker {
  pool: TarnPool
  pendingAcquire: Map<unknown, number>
  waits: Array<{ at: number; ms: number }>
  samples: Array<{ at: number; used: number; pending: number; saturated: boolean }>
}

/** One tracker per app, keyed by the app's key: dropped when the app leaves the process. */
const trackers = registerAppKeyed(new Map<string, AppTracker>())
/** Pools whose events are already timed (listeners are attached once per pool). */
const listening = new WeakSet<object>()
let sampler: NodeJS.Timeout | null = null

function tarnOf(k: unknown): TarnPool | null {
  const pool = (k as { client?: { pool?: TarnPool } } | null | undefined)?.client?.pool
  return pool && typeof pool.on === 'function' ? pool : null
}

/** Drop entries older than `cutoff` (entries are in time order) and keep at most `max`. */
function pruneWindow<T extends { at: number }>(list: T[], cutoff: number, max: number): void {
  let drop = 0
  while (drop < list.length && list[drop].at < cutoff) drop++
  drop = Math.max(drop, list.length - max)
  if (drop > 0) list.splice(0, drop)
}

function prune(t: AppTracker, now: number): void {
  pruneWindow(t.waits, now - WINDOW_MS, MAX_WAITS)
  pruneWindow(t.samples, now - WINDOW_MS, Number.MAX_SAFE_INTEGER)
}

function sampleAll(): void {
  const now = Date.now()
  for (const t of trackers.values()) {
    const used = t.pool.numUsed?.() ?? 0
    const pending = t.pool.numPendingAcquires?.() ?? 0
    const max = t.pool.max ?? 0
    t.samples.push({ at: now, used, pending, saturated: max > 0 && used >= max })
    prune(t, now)
  }
}

/**
 * Start watching the current app's pool (inside an app; a no-op elsewhere, and when it is already
 * watched). Answers whether the app is watched now.
 */
export function trackCurrentAppPool(): boolean {
  const key = currentTenantKey()
  if (!key) return false
  const pool = tarnOf(getTenantDb())
  if (!pool) return false
  const known = trackers.get(key)
  if (known?.pool === pool) return true
  const t: AppTracker = { pool, pendingAcquire: new Map(), waits: [], samples: [] }
  trackers.set(key, t)
  if (!listening.has(pool)) {
    listening.add(pool)
    // The events read the app's CURRENT tracker: after the app left (tracker dropped) they do
    // nothing, and a returning app's new tracker gets them without a second listener.
    const mine = () => {
      const cur = trackers.get(key)
      return cur?.pool === pool ? cur : null
    }
    pool.on('acquireRequest', (eventId: unknown) => {
      mine()?.pendingAcquire.set(eventId, performance.now())
    })
    pool.on('acquireFail', (eventId: unknown) => {
      mine()?.pendingAcquire.delete(eventId)
    })
    pool.on('acquireSuccess', (eventId: unknown) => {
      const cur = mine()
      if (!cur) return
      const started = cur.pendingAcquire.get(eventId)
      if (started === undefined) return
      cur.pendingAcquire.delete(eventId)
      cur.waits.push({ at: Date.now(), ms: performance.now() - started })
      if (cur.waits.length > MAX_WAITS * 2) prune(cur, Date.now())
    })
  }
  if (!sampler) {
    sampler = setInterval(sampleAll, SAMPLE_MS)
    sampler.unref?.()
  }
  return true
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

/** The current app's pool pressure over the last five minutes, or null when it is not watched. */
export function appPoolPressure(): PoolPressure | null {
  const t = trackers.get(currentTenantKey())
  if (!currentTenantKey() || !t) return null
  prune(t, Date.now())
  const sorted = t.waits.map((w) => w.ms).sort((a, b) => a - b)
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
    max: t.pool.max ?? 0
  }
}

/** The pool-monitor rule (same as self-hosted): enough acquires, and slow or often full. */
export function underPressure(p: PoolPressure): boolean {
  return p.acquires >= 50 && (p.wait_p95_ms >= 500 || p.saturated_pct >= 25)
}

/** Every watched app pool, summed right now — the deployment link's process figure. */
export function appPoolTotals(): {
  apps: number
  used: number
  free: number
  pending: number
  max: number
} {
  const out = { apps: 0, used: 0, free: 0, pending: 0, max: 0 }
  for (const t of trackers.values()) {
    out.apps++
    out.used += t.pool.numUsed?.() ?? 0
    out.free += t.pool.numFree?.() ?? 0
    out.pending += t.pool.numPendingAcquires?.() ?? 0
    out.max += t.pool.max ?? 0
  }
  return out
}

/** The current app's own sockets and distinct people among `sockets` (each socket names its
 *  app), for the per-app concurrency sample. */
export function appConcurrency(
  sockets: ReadonlyArray<{ tenant?: unknown; user?: unknown }>,
  tenant: string = currentTenantKey()
): { sockets: number; users: number } {
  if (!tenant) return { sockets: 0, users: 0 }
  let n = 0
  const users = new Set<string>()
  for (const s of sockets) {
    if (s.tenant !== tenant) continue
    n++
    const u = s.user as { id?: unknown } | string | null | undefined
    const id = typeof u === 'string' ? u : u?.id
    if (typeof id === 'string' && id) users.add(id)
  }
  return { sockets: n, users: users.size }
}

/** Boot (Hub shared deployment): watch each app's pool from the moment it becomes ready. Must be
 *  registered before the app migrations start (an app that is ready never fires it again). */
export function registerAppPoolTracking(): void {
  onAppReady('app-pool-pressure', () => {
    trackCurrentAppPool()
  })
}

/** Tests only. */
export function _resetAppPoolPressureForTests(): void {
  trackers.clear()
  if (sampler) clearInterval(sampler)
  sampler = null
}

/** Tests only: take one sample of every watched pool now. */
export function _sampleAppPoolsForTests(): void {
  sampleAll()
}

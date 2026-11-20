import { stat } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { stableIssueKey, trackError } from './error-tracking.js'

/**
 * Stall watchdog (2026-11-18). One prod web process froze for 10 s at 2:25 PM ET: every request
 * it held — the online list and session-recording uploads too — finished in the same second,
 * and three waited out the 10 s connection wait ("server busy"). The runtime monitor raises only
 * after ~30 s of continuous lag and keeps no in-flight list, so nothing said what froze.
 *
 * Every second this process checks three things and, on a stall of STALL_WATCHDOG_MS (default
 * 2 s), opens or bumps ONE issue per kind naming the requests in flight at that moment:
 *
 *  - main loop: a 1 s timer fired late (CPU-heavy synchronous work, a long garbage collection);
 *  - helper threads: a local file check (libuv thread pool — also used by file I/O, DNS lookups
 *    for new database connections, compression, crypto) has not answered — the pool is
 *    backed up, e.g. behind a slow NFS share;
 *  - connections: every request connection is in use and requests are queued for one.
 *
 * Reported while still stuck where it can be (helper threads, connections); the main loop can
 * only be measured once it runs again. At most one report per kind per minute per process.
 * Off with STALL_WATCHDOG=off.
 *
 * Each report also names the background work running on the process (scheduled jobs, import
 * runs — services/background-inflight.ts) and, for a main-loop block, the garbage-collection
 * pauses inside the stall window: a cron worker serves no requests, so "in flight" alone read
 * empty while the hourly jobs ran (EFP prod issue 1122, 2026-11-20), and a long memory clean-up
 * looks the same as a job holding the processor until the GC time is beside it.
 */

export type StallKind = 'main-loop' | 'helper-threads' | 'connections'

export interface StallReport {
  kind: StallKind
  ms: number
  host: string
  inflight: Array<{ route: string; method: string; age_ms: number; caller: string; phase: string }>
  pool: { used: number; pending: number; max: number } | null
  /** Background work running on the process (jobs, imports), longest-running first. */
  jobs?: Array<{ kind: string; label: string; age_ms: number }>
  /** How many pieces of background work were running (`jobs` is capped). */
  jobs_total?: number
  /** Garbage-collection pauses inside a main-loop stall's window (null = not measured). */
  gc?: { count: number; total_ms: number; longest_ms: number } | null
  /** Heap in use when reported, MB. */
  heap_mb?: number
}

const TICK_MS = 1000
const REPORT_GAP_MS = 60_000

function thresholdMs(): number {
  const v = Number(process.env.STALL_WATCHDOG_MS)
  return Number.isFinite(v) && v >= 500 ? v : 2000
}

const LABEL: Record<StallKind, string> = {
  'main-loop': 'main loop blocked',
  'helper-threads': 'helper threads backed up',
  connections: 'every database connection in use'
}

/** The issue message (the issue log reads it into a sentence: services/issue-readable.ts). */
export function stallMessage(r: StallReport): string {
  const secs = (r.ms / 1000).toFixed(1)
  const top = r.inflight
    .slice(0, 5)
    .map((i) => `${i.method} ${i.route}`)
    .join(', ')
  const jobs = r.jobs ?? []
  const total = Math.max(r.jobs_total ?? jobs.length, jobs.length)
  const running = jobs
    .slice(0, 5)
    .map((j) => `${j.kind} ${j.label}`)
    .join(', ')
  const more = total > 5 ? ` +${total - 5} more` : ''
  const gc =
    r.kind === 'main-loop' && r.gc && r.gc.longest_ms >= 250
      ? ` — garbage collection ${(r.gc.total_ms / 1000).toFixed(1)}s of it`
      : ''
  return `Process stalled ${secs}s (${LABEL[r.kind]}) on ${r.host}${top ? ` — in flight: ${top}` : ''}${running ? ` — running: ${running}${more}` : ''}${gc}`
}

export interface WatchdogDeps {
  now: () => number
  probe: () => Promise<unknown>
  inflight: () => StallReport['inflight']
  pool: () => StallReport['pool']
  report: (r: StallReport) => void
  /** Background work running now (optional: tests and old callers leave it out). */
  jobs?: () => { list: NonNullable<StallReport['jobs']>; total: number }
  /** GC pauses that started inside [from, to] (epoch ms). */
  gc?: (from: number, to: number) => StallReport['gc']
  heapMb?: () => number
}

async function defaultDeps(): Promise<WatchdogDeps> {
  const { listInflight } = await import('./traffic-inflight.js')
  const { poolNow } = await import('./pool-attribution.js')
  const { listBackgroundWork, backgroundWorkCount } = await import('./background-inflight.js')
  const dir = tmpdir()
  const gcLog = startGcLog()
  return {
    jobs: () => ({ list: listBackgroundWork(20), total: backgroundWorkCount() }),
    gc: (from, to) => gcLog(from, to),
    heapMb: () => Math.round(process.memoryUsage().heapUsed / 1_048_576),
    now: () => Date.now(),
    probe: () => stat(dir),
    inflight: () =>
      listInflight({ limit: 20 }).rows.map((r) => ({
        route: r.route,
        method: r.method,
        age_ms: r.age_ms,
        caller: r.caller,
        phase: r.phase
      })),
    pool: () => {
      try {
        return poolNow('main')
      } catch {
        return null
      }
    },
    report: (r) => {
      void trackError({
        source: 'server',
        route: 'process-stall',
        severity: r.ms >= 10_000 ? 'high' : 'medium',
        fingerprint: stableIssueKey('process-stall', r.kind),
        refreshDetails: true,
        message: stallMessage(r),
        stack: JSON.stringify(r, null, 1).slice(0, 8000)
      }).catch(() => {})
    }
  }
}

/** The watchdog's state machine, one `tick()` per second (exported for tests). */
export function createWatchdog(deps: WatchdogDeps, host = hostname()) {
  let lastTick = deps.now()
  let probeStarted: number | null = null
  let probeReported = false
  let poolStuckSince: number | null = null
  let poolReported = false
  const lastReport = new Map<StallKind, number>()

  const emit = (kind: StallKind, ms: number) => {
    const now = deps.now()
    if (now - (lastReport.get(kind) ?? -Infinity) < REPORT_GAP_MS) return
    lastReport.set(kind, now)
    const jobs = safe(() => deps.jobs?.(), undefined)
    deps.report({
      kind,
      ms,
      host,
      inflight: deps.inflight(),
      pool: deps.pool(),
      ...(jobs ? { jobs: jobs.list, jobs_total: jobs.total } : {}),
      ...(kind === 'main-loop' && deps.gc
        ? { gc: safe(() => deps.gc?.(now - ms - TICK_MS, now) ?? null, null) }
        : {}),
      ...(deps.heapMb ? { heap_mb: safe(() => deps.heapMb?.(), undefined) } : {})
    })
  }

  return {
    tick(): void {
      const now = deps.now()
      const limit = thresholdMs()
      // Main loop: this tick came late by the time the loop could not run.
      const late = now - lastTick - TICK_MS
      lastTick = now
      if (late >= limit) emit('main-loop', late)

      // Helper threads: one small local file check at a time; a check still out is the backlog.
      if (probeStarted === null) {
        probeStarted = now
        probeReported = false
        const began = now
        deps
          .probe()
          .catch(() => {})
          .finally(() => {
            noteHelperCheck(deps.now() - began)
            probeStarted = null
          })
      } else if (!probeReported && now - probeStarted >= limit) {
        probeReported = true
        emit('helper-threads', now - probeStarted)
      }

      // Connections: every one in use with requests queued, continuously.
      const p = deps.pool()
      if (p && p.max > 0 && p.used >= p.max && p.pending > 0) {
        poolStuckSince ??= now
        if (!poolReported && now - poolStuckSince >= limit) {
          poolReported = true
          emit('connections', now - poolStuckSince)
        }
      } else {
        poolStuckSince = null
        poolReported = false
      }
    }
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * Recent garbage-collection pauses (a small ring, epoch-ms start + duration) and a reader for
 * the ones that started inside a window. Observing 'gc' entries costs nothing between GCs.
 */
function startGcLog(): (from: number, to: number) => StallReport['gc'] {
  const ring: Array<{ at: number; ms: number }> = []
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        ring.push({ at: performance.timeOrigin + e.startTime, ms: e.duration })
        if (ring.length > 200) ring.splice(0, ring.length - 200)
      }
    })
    obs.observe({ entryTypes: ['gc'] })
  } catch {
    return () => null
  }
  return (from, to) => gcWithin(ring, from, to)
}

/** GC pauses that started inside [from, to] (exported for tests). */
export function gcWithin(
  ring: Array<{ at: number; ms: number }>,
  from: number,
  to: number
): NonNullable<StallReport['gc']> {
  let count = 0
  let total = 0
  let longest = 0
  for (const g of ring) {
    if (g.at < from || g.at > to) continue
    count++
    total += g.ms
    if (g.ms > longest) longest = g.ms
  }
  return { count, total_ms: Math.round(total), longest_ms: Math.round(longest) }
}

// The longest helper-thread check since the last metrics read (plugins/metrics.ts): a backed-up
// pool shows as seconds here even when it clears between two scrapes.
let helperMaxMs = 0
function noteHelperCheck(ms: number): void {
  if (ms > helperMaxMs) helperMaxMs = ms
}

/** Longest helper-thread check since the previous call, then resets (null = watchdog off). */
export function takeHelperCheckMaxMs(): number | null {
  if (!timer) return null
  const v = helperMaxMs
  helperMaxMs = 0
  return v
}

let timer: ReturnType<typeof setInterval> | null = null

export async function startStallWatchdog(): Promise<void> {
  if (timer || process.env.STALL_WATCHDOG === 'off') return
  const dog = createWatchdog(await defaultDeps())
  timer = setInterval(() => {
    try {
      dog.tick()
    } catch {
      /* a watchdog never takes the process down */
    }
  }, TICK_MS)
  timer.unref()
}

export function stopStallWatchdog(): void {
  if (timer) clearInterval(timer)
  timer = null
}

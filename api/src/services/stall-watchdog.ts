import { stat } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
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
 */

export type StallKind = 'main-loop' | 'helper-threads' | 'connections'

export interface StallReport {
  kind: StallKind
  ms: number
  host: string
  inflight: Array<{ route: string; method: string; age_ms: number; caller: string; phase: string }>
  pool: { used: number; pending: number; max: number } | null
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
  return `Process stalled ${secs}s (${LABEL[r.kind]}) on ${r.host}${top ? ` — in flight: ${top}` : ''}`
}

export interface WatchdogDeps {
  now: () => number
  probe: () => Promise<unknown>
  inflight: () => StallReport['inflight']
  pool: () => StallReport['pool']
  report: (r: StallReport) => void
}

async function defaultDeps(): Promise<WatchdogDeps> {
  const { listInflight } = await import('./traffic-inflight.js')
  const { poolNow } = await import('./pool-attribution.js')
  const dir = tmpdir()
  return {
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
    deps.report({ kind, ms, host, inflight: deps.inflight(), pool: deps.pool() })
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

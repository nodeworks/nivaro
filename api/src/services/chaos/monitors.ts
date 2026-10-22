import { type AlertFired, onAlertFired } from '../alert-fired.js'
import type { ArmedFault } from './catalog.js'
import { armedFaults, onRegistryChange, type RegistryEvent } from './registry.js'
import type { RunEventKind } from './runs.js'

/**
 * What the readiness checks and the monitors said during each run (#1773).
 *
 * Readiness: the replica that armed a run's fault takes the scorecard live at arm, at the
 * window's midpoint (windows of 30 s or more) and at the end, and appends a `readiness` event
 * each time — score, counts, the failing and warning check ids, and what changed since the
 * arm. Live runs are single-flight per process and reuse an evaluation finished in the last
 * few seconds (READINESS_FRESH_REUSE_MS), so three per drill stay cheap.
 *
 * Alerts: every alert that fires in this process (log alert rules, metric and Traffic Map
 * alerts, monitors — services/alert-fired.ts) becomes an `alert` event on every run whose
 * fault is armed here, on any replica (the run store is shared), once per alert per minute.
 */

export interface ReadinessSnapshot {
  score: number | null
  counts: Record<string, number>
  failing: string[]
  warning: string[]
}

export interface MonitorDeps {
  snapshot: () => Promise<ReadinessSnapshot>
  addEvent: (runId: string, kind: RunEventKind, data: Record<string, unknown>) => Promise<unknown>
}

const LIST_CAP = 20
const SNAPSHOT_TIMEOUT_MS = 60_000
const ALERT_DEDUPE_MS = 60_000

export function summarizeReadiness(report: {
  score: number | null
  counts: Record<string, number>
  checks: Array<{ id: string; status: string }>
}): ReadinessSnapshot {
  return {
    score: report.score,
    counts: { ...report.counts },
    failing: report.checks
      .filter((c) => c.status === 'fail' || c.status === 'error')
      .map((c) => c.id)
      .slice(0, LIST_CAP),
    warning: report.checks
      .filter((c) => c.status === 'warn')
      .map((c) => c.id)
      .slice(0, LIST_CAP)
  }
}

let deps: MonitorDeps = {
  snapshot: async () => {
    const { runReadinessChecks, READINESS_FRESH_REUSE_MS } = await import('../readiness.js')
    return summarizeReadiness(await runReadinessChecks({ reuseMs: READINESS_FRESH_REUSE_MS }))
  },
  addEvent: async (runId, kind, data) => {
    const { addRunEvent } = await import('./drill.js')
    return addRunEvent(runId, kind, data)
  }
}

/** Tests: replace the readiness reader and the event writer. */
export function _setMonitorDepsForTests(d: Partial<MonitorDeps>): void {
  deps = { ...deps, ...d }
}

interface Watch {
  arm: ReadinessSnapshot | null
  midTimer: ReturnType<typeof setTimeout> | null
  ended: boolean
}

const watches = new Map<string, Watch>()
const alertSeen = new Map<string, number>()

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      () => {
        clearTimeout(t)
        resolve(null)
      }
    )
  })
}

function diff(a: string[], b: string[]): string[] {
  const s = new Set(a)
  return b.filter((x) => !s.has(x))
}

async function record(runId: string, phase: 'arm' | 'mid' | 'end', w: Watch): Promise<void> {
  const t0 = Date.now()
  const snap = await withTimeout(deps.snapshot(), SNAPSHOT_TIMEOUT_MS)
  const data: Record<string, unknown> = { phase, ms: Date.now() - t0 }
  if (!snap) {
    data.unavailable = true
  } else {
    Object.assign(data, snap)
    if (phase === 'arm') w.arm = snap
    else if (w.arm) {
      const newly = diff(w.arm.failing, snap.failing)
      const cleared = diff(snap.failing, w.arm.failing)
      data.newly_failing = newly
      data.cleared = cleared
      data.changed = newly.length > 0 || cleared.length > 0 || snap.score !== w.arm.score
    }
  }
  try {
    await deps.addEvent(runId, 'readiness', data)
  } catch {
    /* the run store reports its own trouble */
  }
}

function start(fault: ArmedFault): void {
  const runId = fault.run_id
  if (!runId || watches.has(runId)) return
  const w: Watch = { arm: null, midTimer: null, ended: false }
  watches.set(runId, w)
  const armed = record(runId, 'arm', w)
  const windowMs = fault.ends_at - fault.started_at
  if (windowMs >= 30_000) {
    w.midTimer = setTimeout(() => {
      w.midTimer = null
      if (!w.ended) void armed.then(() => record(runId, 'mid', w))
    }, windowMs / 2)
    w.midTimer.unref?.()
  }
}

function end(runId: string | null): void {
  if (!runId) return
  const w = watches.get(runId)
  if (!w || w.ended) return
  w.ended = true
  if (w.midTimer) clearTimeout(w.midTimer)
  watches.delete(runId)
  void record(runId, 'end', w)
}

function onRegistry(ev: RegistryEvent): void {
  if (ev.remote) return
  if (ev.type === 'armed') start(ev.fault)
  else if (ev.type === 'expired' || ev.type === 'disarmed') end(ev.fault.run_id)
  else if (ev.type === 'stop-all') for (const f of ev.faults) end(f.run_id)
}

function onAlert(a: AlertFired): void {
  const runs = new Set<string>()
  for (const f of armedFaults()) if (f.run_id) runs.add(f.run_id)
  if (runs.size === 0) return
  const now = Date.now()
  for (const runId of runs) {
    const k = `${runId}|${a.source}|${a.key}`
    if (now - (alertSeen.get(k) ?? 0) < ALERT_DEDUPE_MS) continue
    alertSeen.set(k, now)
    if (alertSeen.size > 2000) alertSeen.clear()
    void deps
      .addEvent(runId, 'alert', {
        source: a.source,
        key: a.key,
        label: a.label.slice(0, 200),
        severity: a.severity ?? null,
        fired_at: new Date(a.at).toISOString()
      })
      .catch(() => {})
  }
}

let unsubs: Array<() => void> = []

/** Start recording (idempotent; the catalog load calls it). */
export function wireRunMonitors(): void {
  if (unsubs.length) return
  unsubs = [onRegistryChange(onRegistry), onAlertFired(onAlert)]
}

/** Tests only. */
export function _resetMonitorsForTests(): void {
  for (const u of unsubs) u()
  unsubs = []
  for (const w of watches.values()) if (w.midTimer) clearTimeout(w.midTimer)
  watches.clear()
  alertSeen.clear()
}

wireRunMonitors()

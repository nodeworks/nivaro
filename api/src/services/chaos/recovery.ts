import { CHAOS_NODE, onRegistryChange, type RegistryEvent } from './registry.js'
import { type Band, baselineBand, insideBand } from './report.js'
import type { ChaosRun } from './runs.js'
import { sampleMany } from './steady-state.js'

/**
 * The recovery watch (#2849): time to recover needs samples AFTER the fault ends, and the
 * steady-state watcher (#2828) stops when the fault is disarmed. So when a run's fault ends on
 * the replica that armed it, this keeps sampling the run's hypothesis samplers every 5 s for at
 * most two minutes, writing `sample {s, phase: 'after'}` events, and stops early once every
 * sampler with a baseline has been back inside it for two samples in a row. Read-only: it
 * never arms, aborts or changes a verdict. One watch per run.
 */

export const RECOVERY_INTERVAL_MS = 5_000
export const RECOVERY_MAX_MS = 120_000
const SETTLE_MS = 1_500
const STABLE_SAMPLES = 2

export interface RecoveryIo {
  getRun(id: string): Promise<ChaosRun | null>
  sample(keys: string[]): Promise<Record<string, number | null>>
  event(runId: string, data: Record<string, unknown>): Promise<unknown>
}

const defaultIo: RecoveryIo = {
  getRun: async (id) => (await import('./runs.js')).getRun(id),
  sample: (keys) => sampleMany(keys),
  event: async (runId, data) => (await import('./drill.js')).addRunEvent(runId, 'sample', data)
}

const watching = new Map<string, ReturnType<typeof setTimeout>>()

/** The samplers a run's recovery is judged on: its hypothesis samplers with a baseline. */
export function recoveryTargets(run: ChaosRun): Array<{ key: string; band: Band; tol: number }> {
  const out: Array<{ key: string; band: Band; tol: number }> = []
  for (const r of run.hypothesis ?? []) {
    const band = baselineBand(run.baseline, r.sampler)
    if (band && !out.some((o) => o.key === r.sampler))
      out.push({ key: r.sampler, band, tol: r.tolerance ?? 0 })
  }
  return out
}

/** Watch one finished run's recovery. Resolves when the watch ends (tests await it). */
export interface RecoveryOptions {
  io?: RecoveryIo
  intervalMs?: number
  maxMs?: number
  settleMs?: number
}

export async function watchRecovery(
  runId: string,
  opts: RecoveryOptions = {}
): Promise<'recovered' | 'timeout' | 'skipped'> {
  if (watching.has(runId)) return 'skipped'
  const io = opts.io ?? defaultIo
  const interval = opts.intervalMs ?? RECOVERY_INTERVAL_MS
  const maxMs = opts.maxMs ?? RECOVERY_MAX_MS
  const wait = (ms: number) =>
    new Promise<void>((res) => {
      const t = setTimeout(res, ms)
      t.unref?.()
      watching.set(runId, t)
    })
  try {
    // Let the drill write its verdict and end event first.
    await wait(opts.settleMs ?? SETTLE_MS)
    const run = await io.getRun(runId)
    const targets = run ? recoveryTargets(run) : []
    if (!run || !targets.length) return 'skipped'
    const keys = targets.map((t) => t.key)
    const started = Date.now()
    let stable = 0
    while (Date.now() - started <= maxMs) {
      let values: Record<string, number | null> = {}
      try {
        values = await io.sample(keys)
      } catch {
        values = {}
      }
      const judged = targets.filter((t) => values[t.key] != null)
      if (judged.length) {
        await io.event(runId, { s: values, phase: 'after' })
        const ok = judged.every((t) => insideBand(values[t.key] as number, t.band, t.tol))
        stable = ok ? stable + 1 : 0
        if (stable >= STABLE_SAMPLES) return 'recovered'
      }
      await wait(interval)
    }
    return 'timeout'
  } catch {
    return 'skipped'
  } finally {
    const t = watching.get(runId)
    if (t) clearTimeout(t)
    watching.delete(runId)
  }
}

let wired = false
/** Start a recovery watch whenever a fault armed on THIS replica ends. Idempotent. */
export function wireRecoveryWatch(opts: RecoveryOptions = {}): () => void {
  if (wired) return () => {}
  wired = true
  const off = onRegistryChange((ev: RegistryEvent) => {
    if (ev.remote) return
    const faults =
      ev.type === 'expired' || ev.type === 'disarmed'
        ? [ev.fault]
        : ev.type === 'stop-all'
          ? ev.faults
          : []
    for (const f of faults)
      if (f.run_id && f.node === CHAOS_NODE) void watchRecovery(f.run_id, opts)
  })
  return () => {
    off()
    wired = false
  }
}

/** Tests only. */
export function _resetRecoveryForTests(): void {
  for (const t of watching.values()) clearTimeout(t)
  watching.clear()
  wired = false
}

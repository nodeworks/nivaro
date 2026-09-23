/**
 * Integration signal registry (spec 2026-09-23 §3.1–3.2).
 *
 * A signal is one KIND of integration problem. Core registers generic ones
 * (integration-signals-core.ts); extensions register theirs through
 * ctx.integrations.registerSignal. `runSignalsCycle` evaluates every enabled
 * signal (60 s budget each, failures isolated) and writes the snapshot:
 * new keys insert, seen keys update, vanished keys clear. The console reads
 * the snapshot, never evaluates on page load.
 */
import { db } from '../db/index.js'
import { resolveThresholds } from './integration-signal-settings.js'

export interface SignalThreshold {
  key: string
  label: string
  default: number
  unit: string
  min?: number
  max?: number
}

export interface SignalAction {
  kind: 'retry_submission' | 'resend' | 'open' | 'explain' | 'extension'
  label: string
  /** Extension action id (kind 'extension'), submission id (retry), etc. */
  id?: string
  payload?: Record<string, unknown>
}

export interface SignalRow {
  /** Stable identity of the problem instance — NEVER a message or timestamp. */
  key: string
  group?: string
  group_label?: string
  title: string
  detail?: string
  since?: string
  api?: string
  record?: { collection: string; id: string; label?: string }
  actions: SignalAction[]
}

export interface SignalEvalContext {
  thresholds: Record<string, number>
  /** A Date `n` business days before now (core SLA schedule: days + holidays). */
  businessDaysAgo(n: number): Promise<Date>
}

export interface IntegrationSignal {
  id: string
  label: string
  description: string
  tab: string
  severity: 'critical' | 'warn'
  thresholds: SignalThreshold[]
  evaluate(ctx: SignalEvalContext): Promise<{ count: number; rows: SignalRow[] }>
}

export interface SignalActionHandler {
  id: string
  label: string
  run(args: {
    rows: SignalRow[]
    userId: string | null
    authHeaders: Record<string, string>
  }): Promise<Array<{ key: string; ok: boolean; message: string }>>
}

export const ROW_CAP = 500
const DEFAULT_BUDGET_MS = 60_000

const signals = new Map<string, { def: IntegrationSignal; owner: string }>()
const actions = new Map<string, { def: SignalActionHandler; owner: string }>()

export function registerIntegrationSignal(def: IntegrationSignal, owner = 'core'): void {
  if (!/^[a-z0-9_-]+:[a-z0-9_-]+$/.test(def.id)) {
    throw new Error(`Integration signal id "${def.id}" must look like "owner:name"`)
  }
  signals.set(def.id, { def, owner })
}

export function registerIntegrationSignalAction(def: SignalActionHandler, owner = 'core'): void {
  actions.set(def.id, { def, owner })
}

export function listIntegrationSignals(): IntegrationSignal[] {
  return [...signals.values()].map((s) => s.def)
}

export function getIntegrationSignal(id: string): IntegrationSignal | undefined {
  return signals.get(id)?.def
}

export function signalOwner(id: string): string | undefined {
  return signals.get(id)?.owner
}

export function getSignalAction(
  id: string
): { def: SignalActionHandler; owner: string } | undefined {
  return actions.get(id)
}

// ── snapshot diff (pure) ────────────────────────────────────────────────────

export interface OpenRow {
  id: number
  row_key: string
  first_seen: Date
}

export interface SnapshotDiff {
  inserts: Array<{ row: SignalRow; first_seen: Date }>
  updates: Array<{ id: number; row: SignalRow }>
  clears: number[]
}

export function diffSnapshot(open: OpenRow[], fresh: SignalRow[], now: Date): SnapshotDiff {
  const byKey = new Map<string, SignalRow>()
  for (const r of fresh) byKey.set(r.key, r)
  const openByKey = new Map(open.map((o) => [o.row_key, o]))
  const inserts: SnapshotDiff['inserts'] = []
  const updates: SnapshotDiff['updates'] = []
  for (const [key, row] of byKey) {
    const existing = openByKey.get(key)
    if (existing) updates.push({ id: existing.id, row })
    else {
      const since = row.since ? new Date(row.since) : null
      inserts.push({ row, first_seen: since && !Number.isNaN(since.getTime()) ? since : now })
    }
  }
  const clears = open.filter((o) => !byKey.has(o.row_key)).map((o) => o.id)
  return { inserts, updates, clears }
}

// ── evaluation ──────────────────────────────────────────────────────────────

export interface EvalResult {
  signal: string
  count: number
  rows: SignalRow[]
  error: string | null
  duration_ms: number
}

async function businessDaysAgo(n: number): Promise<Date> {
  const { getSlaSchedule } = await import('./business-hours.js')
  const s = await getSlaSchedule()
  const d = new Date()
  let left = Math.max(0, Math.floor(n))
  while (left > 0) {
    d.setDate(d.getDate() - 1)
    const iso = d.toISOString().slice(0, 10)
    if (s.days.has(d.getDay()) && !s.holidays.has(iso)) left--
  }
  return d
}

function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    timer.unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

export async function evaluateAll(
  opts: { only?: string[]; budgetMs?: number } = {}
): Promise<EvalResult[]> {
  const list = listIntegrationSignals().filter((s) => !opts.only || opts.only.includes(s.id))
  return Promise.all(
    list.map(async (s): Promise<EvalResult> => {
      const t0 = Date.now()
      try {
        const settings = await resolveThresholds(s)
        if (!settings.enabled) {
          return { signal: s.id, count: 0, rows: [], error: null, duration_ms: 0 }
        }
        const out = await withBudget(
          s.evaluate({ thresholds: settings.thresholds, businessDaysAgo }),
          opts.budgetMs ?? DEFAULT_BUDGET_MS
        )
        return {
          signal: s.id,
          count: out.count,
          rows: out.rows.slice(0, ROW_CAP),
          error: null,
          duration_ms: Date.now() - t0
        }
      } catch (err) {
        return {
          signal: s.id,
          count: 0,
          rows: [],
          error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
          duration_ms: Date.now() - t0
        }
      }
    })
  )
}

// ── cycle (single-flight) ───────────────────────────────────────────────────

export interface CycleSummary {
  ran_at: string
  results: Array<{ signal: string; count: number; error: string | null; new_keys: string[] }>
}

let inFlight: Promise<CycleSummary> | null = null

export function runSignalsCycle(opts: { only?: string[] } = {}): Promise<CycleSummary> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      return await doCycle(opts)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

async function doCycle(opts: { only?: string[] }): Promise<CycleSummary> {
  const now = new Date()
  const results = await evaluateAll(opts)
  const summary: CycleSummary = { ran_at: now.toISOString(), results: [] }
  for (const r of results) {
    const newKeys: string[] = []
    try {
      await db('nivaro_integration_signal_runs').insert({
        signal: r.signal,
        ran_at: now,
        duration_ms: r.duration_ms,
        count: r.count,
        error: r.error
      })
      // A failed evaluation leaves the snapshot as it was — clearing every
      // row because the checker broke would read as "all fixed".
      if (!r.error) {
        const open = (await db('nivaro_integration_signal_rows')
          .where({ signal: r.signal })
          .whereNull('cleared_at')
          .select('id', 'row_key', 'first_seen')) as OpenRow[]
        const diff = diffSnapshot(open, r.rows, now)
        for (const ins of diff.inserts) {
          await db('nivaro_integration_signal_rows').insert({
            signal: r.signal,
            row_key: ins.row.key.slice(0, 300),
            group_key: ins.row.group?.slice(0, 300) ?? null,
            payload: JSON.stringify(ins.row),
            first_seen: ins.first_seen,
            last_seen: now
          })
          newKeys.push(ins.row.key)
        }
        for (const up of diff.updates) {
          await db('nivaro_integration_signal_rows')
            .where({ id: up.id })
            .update({
              payload: JSON.stringify(up.row),
              group_key: up.row.group?.slice(0, 300) ?? null,
              last_seen: now
            })
        }
        for (let i = 0; i < diff.clears.length; i += 1000) {
          await db('nivaro_integration_signal_rows')
            .whereIn('id', diff.clears.slice(i, i + 1000))
            .update({ cleared_at: now })
        }
      }
    } catch (err) {
      summary.results.push({
        signal: r.signal,
        count: r.count,
        error: `snapshot write failed: ${err instanceof Error ? err.message : String(err)}`,
        new_keys: []
      })
      continue
    }
    summary.results.push({ signal: r.signal, count: r.count, error: r.error, new_keys: newKeys })
  }
  await db('nivaro_integration_signal_runs')
    .where('ran_at', '<', new Date(now.getTime() - 7 * 86_400_000))
    .del()
    .catch(() => undefined)
  return summary
}

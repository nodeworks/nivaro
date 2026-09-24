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
import { chunkArray } from './db-batch.js'
import { planStaleDismissalPrune, resolveThresholds } from './integration-signal-settings.js'

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
  /**
   * Identity of THIS occurrence of the problem — the failing run id
   * (`run:<id>`), the submission attempt (`sub:<id>:<attempts>`), the
   * obligation (`obl:<id>`), a snapshot/import timestamp, whatever the
   * signal knows best. Distinct from `key`: `key` names the PROBLEM ("this
   * import keeps failing") and stays the same across every failure; a
   * Dismiss hides the row only until `occurrence` next changes — a genuinely
   * new instance of the same problem re-shows it, like a notification you
   * can dismiss once. Unset falls back to `since`, then a masked hash of the
   * row (see `rowOccurrence` in integration-signal-settings.ts).
   */
  occurrence?: string
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
  /** Exactly what was last written to the `payload` column (JSON.stringify
   *  of the SignalRow at write time) — planSnapshotWrite string-compares
   *  against this, it is never read by diffSnapshot itself. */
  payload: string
  group_key: string | null
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

// ── write plan (pure) ───────────────────────────────────────────────────────

export interface PlannedInsert {
  /** Untruncated — this is what newKeys reports, never the DB row_key. */
  key: string
  row_key: string
  group_key: string | null
  payload: string
  first_seen: Date
}

export interface PlannedChange {
  id: number
  payload: string
  group_key: string | null
}

export interface SnapshotWritePlan {
  inserts: PlannedInsert[]
  changed: PlannedChange[]
  /** Open rows whose payload AND group_key are unchanged — last_seen only. */
  touchIds: number[]
  clears: number[]
}

/**
 * Decides how to turn a diff into writes without touching the DB: unchanged
 * rows only need last_seen advanced (bulk, cheap), a changed payload or a
 * drifted group_key needs a real per-row UPDATE, and a new key needs an
 * INSERT. The comparison is a plain string compare of the stored `payload`
 * against a fresh `JSON.stringify` of the row — the stored value is exactly
 * what evaluate() produced last time, so as long as the same code produces
 * the same key order this run, string equality is correct; it is
 * deliberately NOT a deep-equal (semantically-equal-but-differently-ordered
 * JSON registers as changed, and that is fine).
 */
export function planSnapshotWrite(open: OpenRow[], diff: SnapshotDiff): SnapshotWritePlan {
  const openById = new Map(open.map((o) => [o.id, o]))
  const inserts: PlannedInsert[] = diff.inserts.map((ins) => ({
    key: ins.row.key,
    row_key: ins.row.key.slice(0, 300),
    group_key: ins.row.group?.slice(0, 300) ?? null,
    payload: JSON.stringify(ins.row),
    first_seen: ins.first_seen
  }))
  const changed: PlannedChange[] = []
  const touchIds: number[] = []
  for (const up of diff.updates) {
    const payload = JSON.stringify(up.row)
    const group_key = up.row.group?.slice(0, 300) ?? null
    const stored = openById.get(up.id)
    if (stored && stored.payload === payload && stored.group_key === group_key) {
      touchIds.push(up.id)
    } else {
      changed.push({ id: up.id, payload, group_key })
    }
  }
  return { inserts, changed, touchIds, clears: diff.clears }
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

/** Same helper evaluate() receives — exported for the settings preview route. */
export const businessDaysAgoForPreview = businessDaysAgo

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
          .select('id', 'row_key', 'first_seen', 'payload', 'group_key')) as OpenRow[]
        const diff = diffSnapshot(open, r.rows, now)
        const plan = planSnapshotWrite(open, diff)

        // Multi-row INSERT, ≤ 50 rows/chunk (6 columns × 50 = 300 bound params).
        for (const chunk of chunkArray(plan.inserts, 50)) {
          await db('nivaro_integration_signal_rows').insert(
            chunk.map((ins) => ({
              signal: r.signal,
              row_key: ins.row_key,
              group_key: ins.group_key,
              payload: ins.payload,
              first_seen: ins.first_seen,
              last_seen: now
            }))
          )
        }
        newKeys.push(...plan.inserts.map((ins) => ins.key))

        // A real payload/group_key change still gets its own UPDATE.
        for (const ch of plan.changed) {
          await db('nivaro_integration_signal_rows')
            .where({ id: ch.id })
            .update({ payload: ch.payload, group_key: ch.group_key, last_seen: now })
        }

        // Everything else just advances last_seen — bulk, chunked at 1000
        // ids (MSSQL's ~2100 bound-param cap).
        for (const chunk of chunkArray(plan.touchIds, 1000)) {
          await db('nivaro_integration_signal_rows').whereIn('id', chunk).update({ last_seen: now })
        }

        for (const chunk of chunkArray(plan.clears, 1000)) {
          await db('nivaro_integration_signal_rows')
            .whereIn('id', chunk)
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
  await pruneStaleDismissals(now).catch(() => undefined)
  return summary
}

/**
 * Dismiss-snoozes (`until_occurrence` set) whose row hasn't been seen at all
 * in 30 days are dead weight — see `planStaleDismissalPrune`'s own comment.
 * Scoped to only the signals that actually have a dismissal on file, so a
 * quiet instance never pays for scanning every open/cleared row.
 */
async function pruneStaleDismissals(now: Date): Promise<void> {
  const snoozes = (await db('nivaro_integration_signal_snoozes')
    .whereNotNull('until_occurrence')
    .select('id', 'signal', 'row_key', 'until_occurrence')) as Array<{
    id: number
    signal: string
    row_key: string | null
    until_occurrence: string | null
  }>
  if (snoozes.length === 0) return
  const signals = [...new Set(snoozes.map((s) => s.signal))]
  const rows = (await db('nivaro_integration_signal_rows')
    .whereIn('signal', signals)
    .select('signal', 'row_key', 'last_seen')) as Array<{
    signal: string
    row_key: string
    last_seen: Date
  }>
  const staleIds = planStaleDismissalPrune(snoozes, rows, now)
  for (const chunk of chunkArray(staleIds, 1000)) {
    await db('nivaro_integration_signal_snoozes').whereIn('id', chunk).del()
  }
}

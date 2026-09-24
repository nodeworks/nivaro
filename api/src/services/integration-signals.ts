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

import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { chunkArray } from './db-batch.js'
import {
  planChangedSnoozePrune,
  planStaleDismissalPrune,
  resolveThresholds,
  rowOccurrence,
  type SnoozeRow,
  storedKey
} from './integration-signal-settings.js'

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
  /**
   * What the console can open in place under this row (Task 15d): the
   * failed push behind it, or the import run that errored. Extensions reuse
   * these kinds for rows that are really one of them (a partner's failed
   * order IS a submission); a kind the console does not know renders nothing.
   */
  drill?: SignalDrill
}

/** A typed "Details" reference on a signal row — see `SignalRow.drill`. */
export interface SignalDrill {
  kind: 'submission' | 'import_run'
  id: string
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
  // Keyed by the STORED (300-character) key, so a longer key still finds its
  // open row instead of inserting a duplicate every cycle.
  const byKey = new Map<string, SignalRow>()
  for (const r of fresh) byKey.set(storedKey(r.key), r)
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
  /**
   * Subset of `changed`, by key — rows whose OCCURRENCE moved on since the
   * stored payload, not merely some other field. "The same problem
   * happened again," which the caller treats like a fresh insert for
   * alerting purposes (Task 16 reads `CycleSummary.results[].new_keys`),
   * while the DB write stays a plain UPDATE — the row was never cleared, so
   * `first_seen` is untouched. See `isReoccurrence` for what counts.
   */
  reoccurredKeys: string[]
  /** Open rows whose payload AND group_key are unchanged — last_seen only. */
  touchIds: number[]
  clears: number[]
}

/**
 * True when `freshRow`'s occurrence differs from what the STORED payload
 * (the last-written JSON of the SAME key) held — a genuinely new instance
 * of the problem, not merely "some other field drifted" (a payload string
 * change alone already routes the row into `changed`; this decides whether
 * THAT change also counts as a re-occurrence).
 *
 * One case is deliberately excluded: a stored payload with NO explicit
 * `occurrence` at all (a row written before this signal ever set one — the
 * common shape for anything predating this concept, "pre-349 rows" in the
 * spec's own words) compared against a fresh row that now sets one for the
 * FIRST time. Comparing via `rowOccurrence`'s fallback there would almost
 * always report a difference (the fallback compares `since`/hash for the
 * stored side against a real occurrence id for the fresh side, which have
 * nothing to do with each other), which would flag EVERY already-open row
 * as having "just happened again" on the very first cycle after a signal's
 * evaluate() gains explicit occurrence tracking. That is the signal
 * reporting richer identity, not a new instance of the problem it already
 * had open — so it is excluded here, not merely as an edge case but as the
 * one guard that keeps a code change from masquerading as new incidents.
 * Once both sides have gone through the SAME fallback (neither side ever
 * set an explicit occurrence), the comparison is exactly the since/hash
 * compare `rowOccurrence` already does for a signal that never sets one.
 */
export function isReoccurrence(storedPayload: string, freshRow: SignalRow): boolean {
  let stored: SignalRow
  try {
    stored = JSON.parse(storedPayload) as SignalRow
  } catch {
    return false
  }
  if (!stored || typeof stored !== 'object') return false
  if (stored.occurrence == null && freshRow.occurrence != null) return false
  return rowOccurrence(freshRow) !== rowOccurrence(stored)
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
    row_key: storedKey(ins.row.key),
    group_key: ins.row.group != null ? storedKey(ins.row.group) : null,
    payload: JSON.stringify(ins.row),
    first_seen: ins.first_seen
  }))
  const changed: PlannedChange[] = []
  const reoccurredKeys: string[] = []
  const touchIds: number[] = []
  for (const up of diff.updates) {
    const payload = JSON.stringify(up.row)
    const group_key = up.row.group != null ? storedKey(up.row.group) : null
    const stored = openById.get(up.id)
    if (stored && stored.payload === payload && stored.group_key === group_key) {
      touchIds.push(up.id)
    } else {
      changed.push({ id: up.id, payload, group_key })
      if (stored && isReoccurrence(stored.payload, up.row)) reoccurredKeys.push(up.row.key)
    }
  }
  return { inserts, changed, reoccurredKeys, touchIds, clears: diff.clears }
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
  results: Array<{
    signal: string
    count: number
    error: string | null
    /** Brand-new keys AND keys whose occurrence moved on — what alerts (Task
     *  16) treat as "this needs a fresh look". */
    new_keys: string[]
    /** Subset of `new_keys` that were already open under this same key —
     *  distinguished so wording can say "happened again" rather than "new". */
    reoccurred_keys: string[]
  }>
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
    const reoccurredKeys: string[] = []
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
        // A re-occurring row (same key, occurrence moved on) counts as new
        // for alerting even though its DB row is only ever UPDATEd, never
        // cleared+reinserted — first_seen stays put.
        newKeys.push(...plan.reoccurredKeys)
        reoccurredKeys.push(...plan.reoccurredKeys)

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
        new_keys: [],
        reoccurred_keys: []
      })
      continue
    }
    summary.results.push({
      signal: r.signal,
      count: r.count,
      error: r.error,
      new_keys: newKeys,
      reoccurred_keys: reoccurredKeys
    })
  }
  await db('nivaro_integration_signal_runs')
    .where('ran_at', '<', new Date(now.getTime() - 7 * 86_400_000))
    .del()
    .catch(() => undefined)
  await pruneClearedSignalRows(now).catch(() => undefined)
  await pruneStaleDismissals(now).catch(() => undefined)
  await pruneChangedSnoozes().catch(() => undefined)
  // Opt-in alerts (Task 16). Lazy import: the alerts module reads this
  // registry, so a static import would be circular. Never fails the cycle.
  try {
    const { deliverSignalAlerts } = await import('./integration-signal-alerts.js')
    await deliverSignalAlerts(summary)
  } catch (err) {
    console.warn('[integration-signals] alert delivery failed:', err)
  }
  return summary
}

/** How long a cleared row, and a dismissal nobody has seen the row of, is kept. */
const HOUSEKEEPING_MS = 30 * 86_400_000

/**
 * Cleared rows older than 30 days — the board never shows them and alerts
 * never read them; without this the table only ever grows. Deletes in chunks
 * of 1000 ids (MSSQL's bound-parameter cap), at most 100 chunks per cycle.
 */
export async function pruneClearedSignalRows(now: Date, database: Knex = db): Promise<number> {
  const cutoff = new Date(now.getTime() - HOUSEKEEPING_MS)
  let deleted = 0
  for (let i = 0; i < 100; i++) {
    const ids = (await database('nivaro_integration_signal_rows')
      .whereNotNull('cleared_at')
      .where('cleared_at', '<', cutoff)
      .orderBy('id')
      .limit(1000)
      .pluck('id')) as number[]
    if (ids.length === 0) break
    await database('nivaro_integration_signal_rows').whereIn('id', ids).del()
    deleted += ids.length
    if (ids.length < 1000) break
  }
  return deleted
}

/**
 * Dismiss-snoozes (`until_occurrence` set) whose row hasn't been seen at all
 * in 30 days are dead weight — see `planStaleDismissalPrune`'s own comment.
 * Reads only the rows those dismissals name, and only ones seen within the
 * window (a row older than that counts as unseen, so its dismissal goes) —
 * never every row of every signal that has a dismissal on file.
 */
export async function pruneStaleDismissals(now: Date, database: Knex = db): Promise<void> {
  const snoozes = (await database('nivaro_integration_signal_snoozes')
    .whereNotNull('until_occurrence')
    .select('id', 'signal', 'row_key', 'until_occurrence')) as Array<{
    id: number
    signal: string
    row_key: string | null
    until_occurrence: string | null
  }>
  if (snoozes.length === 0) return
  const signals = [...new Set(snoozes.map((s) => s.signal))]
  const keys = [...new Set(snoozes.map((s) => s.row_key).filter((k): k is string => !!k))]
  const seenSince = new Date(now.getTime() - HOUSEKEEPING_MS)
  const rows: Array<{ signal: string; row_key: string; last_seen: Date }> = []
  for (const chunk of chunkArray(keys, 1000)) {
    rows.push(
      ...((await database('nivaro_integration_signal_rows')
        .whereIn('signal', signals)
        .whereIn('row_key', chunk)
        .where('last_seen', '>=', seenSince)
        .select('signal', 'row_key', 'last_seen')) as typeof rows)
    )
  }
  const staleIds = planStaleDismissalPrune(snoozes, rows, now, HOUSEKEEPING_MS)
  for (const chunk of chunkArray(staleIds, 1000)) {
    await database('nivaro_integration_signal_snoozes').whereIn('id', chunk).del()
  }
}

/** Drop "until it changes" snoozes whose open row has changed — see
 *  `planChangedSnoozePrune`. Reads only the rows those snoozes name. */
export async function pruneChangedSnoozes(database: Knex = db): Promise<void> {
  const snoozes = (await database('nivaro_integration_signal_snoozes')
    .whereNotNull('until_change_hash')
    .whereNotNull('row_key')
    .select(
      'id',
      'signal',
      'row_key',
      'group_key',
      'until',
      'until_change_hash',
      'until_occurrence'
    )) as SnoozeRow[]
  if (snoozes.length === 0) return
  const signals = [...new Set(snoozes.map((s) => s.signal))]
  const keys = [...new Set(snoozes.map((s) => s.row_key).filter((k): k is string => !!k))]
  const open: Array<{ signal: string; row: SignalRow }> = []
  for (const chunk of chunkArray(keys, 1000)) {
    const rows = (await database('nivaro_integration_signal_rows')
      .whereIn('signal', signals)
      .whereIn('row_key', chunk)
      .whereNull('cleared_at')
      .select('signal', 'payload')) as Array<{ signal: string; payload: string }>
    for (const r of rows) {
      try {
        open.push({ signal: r.signal, row: JSON.parse(r.payload) as SignalRow })
      } catch {
        // An unreadable payload can't be compared — leave its snooze alone.
      }
    }
  }
  const ids = planChangedSnoozePrune(snoozes, open)
  for (const chunk of chunkArray(ids, 1000)) {
    await database('nivaro_integration_signal_snoozes').whereIn('id', chunk).del()
  }
}

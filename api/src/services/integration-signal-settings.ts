/**
 * Integration signal settings + snoozes (spec §3.3–3.4).
 * Settings rows are strings (key/value); thresholds parse to numbers with the
 * signal's own default. Snoozes match a row, a group or the whole signal and
 * expire by time or when the row's STABLE hash changes (numbers in the detail
 * and `since` never count as a change).
 */
import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import type { IntegrationSignal, SignalRow } from './integration-signals.js'

export interface ResolvedSettings {
  enabled: boolean
  severity: 'critical' | 'warn'
  thresholds: Record<string, number>
}

let cache: { at: number; rows: Array<{ signal: string; key: string; value: string }> } | null = null

export function bustSignalSettings(): void {
  cache = null
}

async function allSettings() {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows
  const rows = (await db('nivaro_integration_signal_settings')
    .select('signal', 'key', 'value')
    .catch(() => [])) as Array<{ signal: string; key: string; value: string }>
  cache = { at: Date.now(), rows }
  return rows
}

export async function resolveThresholds(s: IntegrationSignal): Promise<ResolvedSettings> {
  const rows = (await allSettings()).filter((r) => r.signal === s.id)
  const get = (k: string) => rows.find((r) => r.key === k)?.value
  const thresholds: Record<string, number> = {}
  for (const t of s.thresholds) {
    const n = Number(get(t.key))
    thresholds[t.key] = Number.isFinite(n) && get(t.key) != null ? n : t.default
  }
  // Extra free-form numeric keys (e.g. per-import cadence 'cadence_hours:<key>').
  for (const r of rows) {
    if (r.key.includes(':') && Number.isFinite(Number(r.value))) thresholds[r.key] = Number(r.value)
  }
  const sev = get('severity')
  return {
    enabled: get('enabled') !== 'false',
    severity: sev === 'critical' || sev === 'warn' ? sev : s.severity,
    thresholds
  }
}

/** Per-import cadence overrides live under this dynamic-key prefix. */
export const CADENCE_PREFIX = 'cadence_hours:'
const CADENCE_MAX_HOURS = 2160
/** An import with no run attempt of any kind in this many days is dormant —
 *  not watched, not stale — unless `dormant_days` is overridden in settings. */
const DEFAULT_DORMANT_DAYS = 90

/**
 * Validate a settings PATCH. `null` on a threshold or dynamic key means
 * "remove the stored value" (back to the default); `0` on a
 * `cadence_hours:<key>` override means "exclude this import".
 */
export function validateSettingPatch(
  s: IntegrationSignal,
  patch: Record<string, unknown>
): { ok: true; values: Record<string, string | null> } | { ok: false; error: string } {
  const values: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'enabled') {
      if (typeof v !== 'boolean') return { ok: false, error: 'enabled must be true or false' }
      values[k] = v ? 'true' : 'false'
      continue
    }
    if (k === 'severity') {
      if (v !== 'critical' && v !== 'warn')
        return { ok: false, error: 'severity must be critical or warn' }
      values[k] = v
      continue
    }
    const t = s.thresholds.find((x) => x.key === k)
    const dynamic = /^[a-z_]+:[A-Za-z0-9_.-]+$/.test(k)
    if (!t && !dynamic) return { ok: false, error: `Unknown setting "${k}"` }
    if (v === null) {
      values[k] = null
      continue
    }
    const n = typeof v === 'string' && v.trim() === '' ? Number.NaN : Number(v)
    if (!Number.isFinite(n)) return { ok: false, error: `"${k}" must be a number` }
    if (t?.min != null && n < t.min)
      return { ok: false, error: `"${t.label}" must be at least ${t.min}` }
    if (t?.max != null && n > t.max)
      return { ok: false, error: `"${t.label}" must be at most ${t.max}` }
    if (!t && k.startsWith(CADENCE_PREFIX)) {
      if (n < 0) return { ok: false, error: `"${k}" must be 0 (not monitored) or more` }
      if (n > CADENCE_MAX_HOURS)
        return { ok: false, error: `"${k}" must be at most ${CADENCE_MAX_HOURS}` }
    } else if (!t && n <= 0) return { ok: false, error: `"${k}" must be positive` }
    values[k] = String(n)
  }
  return { ok: true, values }
}

/** A validated patch as the writes it becomes: null = delete that key's row. */
export function splitSettingValues(values: Record<string, string | null>): {
  upserts: Array<[string, string]>
  deletes: string[]
} {
  const upserts: Array<[string, string]> = []
  const deletes: string[] = []
  for (const [k, v] of Object.entries(values)) {
    if (v === null) deletes.push(k)
    else upserts.push([k, v])
  }
  return { upserts, deletes }
}

export interface ImportCadence {
  /** Expected hours between successful runs; 0 when excluded or dormant. */
  hours: number
  source: 'default' | 'override' | 'excluded' | 'dormant'
}

/**
 * How often an import is expected to succeed, from the stale signal's
 * thresholds. `lastAttempt` is the newest run of ANY status (not just
 * success) — an import nobody has even tried to run in `dormant_days` has
 * gone quiet on purpose, not fallen behind, so it stops being watched until
 * either it runs again or an explicit override is set. An override always
 * wins: it is a person choosing this import's cadence regardless of history.
 */
export function importCadence(
  key: string,
  thresholds: Record<string, number>,
  lastAttempt?: Date | string | null,
  now: Date = new Date()
): ImportCadence {
  const override = thresholds[`${CADENCE_PREFIX}${key}`]
  if (override === 0) return { hours: 0, source: 'excluded' }
  if (override != null && Number.isFinite(override) && override > 0)
    return { hours: override, source: 'override' }
  const dormantDays = thresholds.dormant_days ?? DEFAULT_DORMANT_DAYS
  if (lastAttempt && now.getTime() - new Date(lastAttempt).getTime() > dormantDays * 86_400_000) {
    return { hours: 0, source: 'dormant' }
  }
  return { hours: thresholds.default_hours ?? 48, source: 'default' }
}

/** Only an import that has succeeded before, and is monitored, can go stale. */
export function isImportStale(
  lastOk: Date | string | null,
  cadence: ImportCadence,
  now: Date = new Date()
): boolean {
  if (!lastOk || cadence.source === 'excluded' || cadence.hours <= 0) return false
  return now.getTime() - new Date(lastOk).getTime() > cadence.hours * 3600_000
}

/** `row_key` / `group_key` are 300-character columns (migration 348) — a
 *  longer key is stored truncated, so every comparison against a STORED key
 *  compares this prefix, never the full key. */
export const STORED_KEY_LENGTH = 300
export function storedKey(key: string): string {
  return key.slice(0, STORED_KEY_LENGTH)
}

export function stableRowHash(row: SignalRow): string {
  const detail = (row.detail ?? '').replace(/\d+/g, '#')
  return createHash('sha256')
    .update(`${row.title}|${row.group ?? ''}|${detail}`)
    .digest('hex')
}

/**
 * The identity of THIS occurrence — never the row's own `key` (which
 * identifies the PROBLEM, e.g. "forecasts import failing", and stays the
 * same across every failing run). `occurrence` identifies WHICH instance of
 * that problem this is: the run id, the submission attempt, the obligation.
 * A signal that hasn't been updated to set one still gets a stable value to
 * dismiss against — `since` (when THIS instance started), then the same
 * masked hash "Until it changes" uses — so Dismiss always has something to
 * key on, it just falls back to coarser identity than a signal that sets
 * `occurrence` explicitly.
 */
export function rowOccurrence(row: SignalRow): string {
  return row.occurrence ?? row.since ?? stableRowHash(row)
}

export interface SnoozeRow {
  id: number
  signal: string
  row_key: string | null
  group_key: string | null
  until: Date | null
  until_change_hash: string | null
  /** Set only by a Dismiss — never alongside a group/signal scope. Compared
   *  against the row's CURRENT `rowOccurrence()` on every read, so a row
   *  whose occurrence has moved on (a new run, a new attempt...) shows again
   *  even though this snooze row is never touched. */
  until_occurrence: string | null
  /** Optional — only `loadActiveSnoozes` populates it (the matching logic
   *  above never reads it, so a caller that doesn't select it stays valid). */
  note?: string | null
}

export function isSnoozed(
  row: SignalRow,
  signal: string,
  snoozes: SnoozeRow[],
  now: Date
): SnoozeRow | null {
  for (const s of snoozes) {
    if (s.signal !== signal) continue
    const scoped = s.row_key
      ? s.row_key === storedKey(row.key)
      : s.group_key
        ? row.group != null && s.group_key === storedKey(row.group)
        : true
    if (!scoped) continue
    if (s.until && new Date(s.until) <= now) continue
    if (s.until_change_hash && s.until_change_hash !== stableRowHash(row)) continue
    if (s.until_occurrence != null && s.until_occurrence !== rowOccurrence(row)) continue
    if (!s.until && !s.until_change_hash && s.until_occurrence == null) continue
    return s
  }
  return null
}

export async function loadActiveSnoozes(): Promise<SnoozeRow[]> {
  return (await db('nivaro_integration_signal_snoozes')
    .where((q) => q.whereNull('until').orWhere('until', '>', new Date()))
    .select(
      'id',
      'signal',
      'row_key',
      'group_key',
      'until',
      'until_change_hash',
      'until_occurrence',
      'note'
    )
    .catch(() => [])) as SnoozeRow[]
}

export interface DismissableSnooze {
  id: number
  signal: string
  row_key: string | null
  until_occurrence: string | null
}

export interface RowLastSeen {
  signal: string
  row_key: string
  last_seen: Date | string
}

/**
 * Dismissals (`until_occurrence` set) whose row hasn't been seen AT ALL in
 * `staleAfterMs` (default 30 days) are dead weight — the problem never came
 * back, so remembering exactly which instance was dismissed gains nothing.
 * `rows` is every (signal, row_key)'s last_seen, open or long since cleared
 * — a dismissal with no matching row at all (should not normally happen) is
 * pruned too, same as one whose row is simply gone.
 *
 * Deliberately NOT about the occurrence going stale while the row stays
 * active: a still-recurring row keeps advancing `last_seen` on every cycle
 * regardless of which occurrence is current, so a dismissal for an OLDER
 * occurrence of a still-open row is left alone here — it is already inert
 * (isSnoozed no longer matches it), just not yet worth a dedicated cleanup.
 */
export function planStaleDismissalPrune(
  snoozes: DismissableSnooze[],
  rows: RowLastSeen[],
  now: Date,
  staleAfterMs = 30 * 86_400_000
): number[] {
  const lastSeen = new Map<string, number>()
  for (const r of rows) {
    const k = `${r.signal}\u0000${r.row_key}`
    const t = new Date(r.last_seen).getTime()
    if (Number.isNaN(t)) continue
    const prev = lastSeen.get(k)
    if (prev == null || t > prev) lastSeen.set(k, t)
  }
  const out: number[] = []
  for (const s of snoozes) {
    if (s.until_occurrence == null || s.row_key == null) continue
    const seen = lastSeen.get(`${s.signal}\u0000${s.row_key}`)
    if (seen == null || now.getTime() - seen > staleAfterMs) out.push(s.id)
  }
  return out
}

/**
 * "Until it changes" snoozes whose OPEN row has changed since — they already
 * stopped hiding it (isSnoozed compares the hash), but left in place an old
 * wording coming back would silently hide the row again. A snooze whose row
 * is not open right now is left alone: it may come back unchanged.
 */
export function planChangedSnoozePrune(
  snoozes: SnoozeRow[],
  open: Array<{ signal: string; row: SignalRow }>
): number[] {
  const byKey = new Map<string, SignalRow>()
  for (const o of open) byKey.set(`${o.signal}\u0000${storedKey(o.row.key)}`, o.row)
  const out: number[] = []
  for (const s of snoozes) {
    if (!s.until_change_hash || s.row_key == null) continue
    const row = byKey.get(`${s.signal}\u0000${s.row_key}`)
    if (row && stableRowHash(row) !== s.until_change_hash) out.push(s.id)
  }
  return out
}

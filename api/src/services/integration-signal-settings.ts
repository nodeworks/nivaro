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
  /** Expected hours between successful runs; 0 when excluded. */
  hours: number
  source: 'default' | 'override' | 'excluded'
}

/** How often an import is expected to succeed, from the stale signal's thresholds. */
export function importCadence(key: string, thresholds: Record<string, number>): ImportCadence {
  const override = thresholds[`${CADENCE_PREFIX}${key}`]
  if (override === 0) return { hours: 0, source: 'excluded' }
  if (override != null && Number.isFinite(override) && override > 0)
    return { hours: override, source: 'override' }
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

export function stableRowHash(row: SignalRow): string {
  const detail = (row.detail ?? '').replace(/\d+/g, '#')
  return createHash('sha256')
    .update(`${row.title}|${row.group ?? ''}|${detail}`)
    .digest('hex')
}

export interface SnoozeRow {
  id: number
  signal: string
  row_key: string | null
  group_key: string | null
  until: Date | null
  until_change_hash: string | null
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
      ? s.row_key === row.key
      : s.group_key
        ? s.group_key === row.group
        : true
    if (!scoped) continue
    if (s.until && new Date(s.until) <= now) continue
    if (s.until_change_hash && s.until_change_hash !== stableRowHash(row)) continue
    if (!s.until && !s.until_change_hash) continue
    return s
  }
  return null
}

export async function loadActiveSnoozes(): Promise<SnoozeRow[]> {
  return (await db('nivaro_integration_signal_snoozes')
    .where((q) => q.whereNull('until').orWhere('until', '>', new Date()))
    .select('id', 'signal', 'row_key', 'group_key', 'until', 'until_change_hash', 'note')
    .catch(() => [])) as SnoozeRow[]
}

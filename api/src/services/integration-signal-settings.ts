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

export function validateSettingPatch(
  s: IntegrationSignal,
  patch: Record<string, unknown>
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'enabled') {
      values[k] = v ? 'true' : 'false'
      continue
    }
    if (k === 'severity') {
      if (v !== 'critical' && v !== 'warn') return { ok: false, error: 'severity must be critical or warn' }
      values[k] = v
      continue
    }
    const t = s.thresholds.find((x) => x.key === k)
    const dynamic = /^[a-z_]+:[A-Za-z0-9_.-]+$/.test(k)
    if (!t && !dynamic) return { ok: false, error: `Unknown setting "${k}"` }
    const n = Number(v)
    if (!Number.isFinite(n)) return { ok: false, error: `"${k}" must be a number` }
    if (t?.min != null && n < t.min) return { ok: false, error: `"${t.label}" must be at least ${t.min}` }
    if (t?.max != null && n > t.max) return { ok: false, error: `"${t.label}" must be at most ${t.max}` }
    if (!t && n <= 0) return { ok: false, error: `"${k}" must be positive` }
    values[k] = String(n)
  }
  return { ok: true, values }
}

export function stableRowHash(row: SignalRow): string {
  const detail = (row.detail ?? '').replace(/\d+/g, '#')
  return createHash('sha256').update(`${row.title}|${row.group ?? ''}|${detail}`).digest('hex')
}

export interface SnoozeRow {
  id: number
  signal: string
  row_key: string | null
  group_key: string | null
  until: Date | null
  until_change_hash: string | null
}

export function isSnoozed(row: SignalRow, signal: string, snoozes: SnoozeRow[], now: Date): SnoozeRow | null {
  for (const s of snoozes) {
    if (s.signal !== signal) continue
    const scoped = s.row_key ? s.row_key === row.key : s.group_key ? s.group_key === row.group : true
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
    .select('id', 'signal', 'row_key', 'group_key', 'until', 'until_change_hash')
    .catch(() => [])) as SnoozeRow[]
}

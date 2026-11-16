/**
 * Environment refresh — the dry-run plan: exactly what a refresh would copy, keep (target values,
 * credentials masked) and switch off, plus the preflight checks. Pure: the facts are gathered by
 * inspect.ts (read-only) and this module only judges and words them, so the API route, the host
 * runner's dry run and the tests all produce the same plan.
 */
import type { EnvRefreshEnvironment } from '@nivaro/extension-kit'
import { isRedactedColumn, SECRET_NAME_RE } from '../secret-columns.js'
import type { SavedEntry, SavedKeepSet } from './keep-set.js'
import type { EnvKeepEntry } from './registry.js'
import type { SafetyAction } from './safety.js'

export type CheckState = 'ok' | 'warn' | 'fail'

export interface PreflightCheck {
  id: string
  state: CheckState
  label: string
  detail?: string
}

export interface PreflightFacts {
  sourceOnline: boolean
  targetOnline: boolean
  sourceLedger: string[]
  targetLedger: string[]
  /** MB used by data in the source / target. */
  sourceUsedMb: number | null
  targetUsedMb: number | null
  /** Allocated MB of the source's data and log files (what a restore lays out). */
  sourceAllocatedMb: number | null
  targetAllocatedMb: number | null
  /** Free MB on the volume of the backup folder; null = unknown. */
  backupFreeMb: number | null
  /** Free MB on the volume holding the target's data files; null = unknown. */
  dataFreeMb: number | null
  /** Size of the last compressed backup of the source, if the server remembers one. */
  lastSourceBackupMb: number | null
  /** A run of the refresh or of another job already holds the target. */
  busy: string | null
}

/** Rough compressed-backup ratio (EFP 2026-11-13: 46 GB used → 12 GB backup). */
export const BACKUP_RATIO = 0.3

export function judgePreflight(f: PreflightFacts): PreflightCheck[] {
  const out: PreflightCheck[] = []
  out.push({
    id: 'online',
    state: f.sourceOnline && f.targetOnline ? 'ok' : 'fail',
    label: 'Both databases are online',
    detail:
      f.sourceOnline && f.targetOnline
        ? undefined
        : `${f.sourceOnline ? '' : 'source offline '}${f.targetOnline ? '' : 'target offline'}`.trim()
  })
  const target = new Set(f.targetLedger)
  const unknown = f.sourceLedger.filter((m) => !target.has(m))
  const newer = f.targetLedger.filter((m) => !f.sourceLedger.includes(m))
  out.push(
    unknown.length
      ? {
          id: 'version',
          state: 'fail',
          label: "The target's app is older than the source's database",
          detail: `It has never run ${unknown.length} of the source's migrations (${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', …' : ''}). Deploy the source's version to the target first.`
        }
      : {
          id: 'version',
          state: 'ok',
          label: "The target's app knows every migration of the source",
          detail: newer.length
            ? `${newer.length} newer migration(s) of the target run after the copy (${newer.slice(0, 3).join(', ')}${newer.length > 3 ? ', …' : ''}).`
            : 'Both are on the same migrations.'
        }
  )
  const backupNeed = Math.round(
    (f.lastSourceBackupMb ?? (f.sourceUsedMb ?? 0) * BACKUP_RATIO) +
      (f.targetUsedMb ?? 0) * BACKUP_RATIO
  )
  out.push(
    f.backupFreeMb == null
      ? {
          id: 'backup-space',
          state: 'warn',
          label: 'Free space for the two backups could not be read',
          detail: `About ${fmtMb(backupNeed)} is needed (the source's copy and the target's pre-refresh backup).`
        }
      : {
          id: 'backup-space',
          state: f.backupFreeMb >= backupNeed * 1.2 ? 'ok' : 'fail',
          label: 'Space for the source copy and the pre-refresh backup',
          detail: `${fmtMb(f.backupFreeMb)} free, about ${fmtMb(backupNeed)} needed.`
        }
  )
  const grow = Math.max(0, (f.sourceAllocatedMb ?? 0) - (f.targetAllocatedMb ?? 0))
  out.push(
    f.dataFreeMb == null
      ? {
          id: 'data-space',
          state: 'warn',
          label: "Free space for the target's larger files could not be read",
          detail: grow ? `The restore grows the target by about ${fmtMb(grow)}.` : undefined
        }
      : {
          id: 'data-space',
          state: f.dataFreeMb >= grow * 1.1 ? 'ok' : 'fail',
          label: "Space for the target's database files",
          detail: `${fmtMb(f.dataFreeMb)} free, the restore grows the target by about ${fmtMb(grow)}.`
        }
  )
  out.push({
    id: 'busy',
    state: f.busy ? 'fail' : 'ok',
    label: f.busy
      ? 'Something else is running against the target'
      : 'Nothing else is running against the target',
    detail: f.busy ?? undefined
  })
  return out
}

export function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

// ─── Plan ───────────────────────────────────────────────────────────────────

export interface KeptValueRow {
  /** The natural key ("Fusion", "#1"). */
  key: string
  /** column → shown value (credentials masked). */
  values: Record<string, string>
}

export interface PlanKept {
  id: string
  label: string
  reason: string
  table: string
  kind: EnvKeepEntry['kind']
  /** Rows the target has now (that will be put back). */
  rows: number
  columns: string[]
  sample: KeptValueRow[]
  note?: string
}

export interface RefreshPlan {
  direction: string
  source: Pick<EnvRefreshEnvironment, 'key' | 'label' | 'database'>
  target: Pick<EnvRefreshEnvironment, 'key' | 'label' | 'database'>
  ready: boolean
  preflight: PreflightCheck[]
  copied: { tables: number; rows: number; used_mb: number | null }
  kept: PlanKept[]
  switched_off: SafetyAction[]
  files: string
  steps: Array<{ key: string; label: string }>
  rollback_hours: number
  generated_at: string
}

export const REFRESH_PHASES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'preflight', label: 'Preflight checks' },
  { key: 'save', label: 'Save what the target keeps' },
  { key: 'backup', label: 'Back up the target, copy the source' },
  { key: 'restore', label: 'Restore the copy over the target' },
  { key: 'migrate', label: "Run the target's newer migrations" },
  { key: 'keep', label: 'Put back what the target keeps' },
  { key: 'safety', label: 'Safety pass' },
  { key: 'verify', label: 'Verify' }
]

export const ROLLBACK_PHASES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'preflight', label: 'Find the pre-refresh backup' },
  { key: 'restore', label: 'Put the target back' },
  { key: 'verify', label: 'Verify' }
]

const SHOWN_VALUE = 80

/** A kept value as the plan shows it: credentials say only set / empty. */
export function showValue(v: unknown, secret: boolean): string {
  const empty = v == null || (typeof v === 'string' && !v.trim())
  if (secret) return empty ? 'empty' : 'set'
  if (empty) return 'empty'
  if (v && typeof v === 'object' && '$date' in (v as object)) return String((v as any).$date)
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > SHOWN_VALUE ? `${s.slice(0, SHOWN_VALUE - 1)}…` : s
}

/**
 * Whether the plan shows a column only as set / empty: the entry says so, the config-snapshot rule
 * calls it a credential, or its name looks like one (the allow-list of that rule does not apply
 * here — a plan never needs to show a token URL either).
 */
export function isSecretColumn(
  table: string,
  column: string,
  declared: Iterable<string> = []
): boolean {
  for (const c of declared) if (c === column) return true
  return isRedactedColumn(table, column) || SECRET_NAME_RE.test(column)
}

function sampleRows(e: SavedEntry, entry: EnvKeepEntry | undefined, max = 25): KeptValueRow[] {
  const declared = entry?.secret_columns ?? []
  const secret = { has: (c: string) => isSecretColumn(e.table, c, declared) }
  const keyCols = e.key.length ? e.key : ['id']
  const cols =
    e.kind === 'columns'
      ? e.columns
      : Object.keys(e.rows[0] ?? {})
          .filter((c) => !keyCols.includes(c))
          .slice(0, 8)
  return e.rows.slice(0, max).map((r) => ({
    key: keyCols.map((k) => showValue(r[k], secret.has(k))).join(' / '),
    values: Object.fromEntries(cols.map((c) => [c, showValue(r[c], secret.has(c))]))
  }))
}

export function buildRefreshPlan(o: {
  direction: string
  source: EnvRefreshEnvironment
  target: EnvRefreshEnvironment
  entries: EnvKeepEntry[]
  captured: SavedKeepSet
  safety: SafetyAction[]
  preflight: PreflightCheck[]
  sourceTables: { tables: number; rows: number; used_mb: number | null }
  filesFallback: string | null
  rollbackHours: number
}): RefreshPlan {
  const byId = new Map(o.entries.map((e) => [e.id, e]))
  const kept: PlanKept[] = []
  for (const e of o.entries) {
    if (e.kind === 'delegate') {
      kept.push({
        id: e.id,
        label: e.label,
        reason: e.reason,
        table: [e.table, ...(e.tables ?? [])].join(', '),
        kind: e.kind,
        rows: 0,
        columns: [],
        sample: [],
        note: e.handled_by ? `kept by ${e.handled_by}` : undefined
      })
      continue
    }
    const s = o.captured.entries.find((x) => x.id === e.id)
    if (!s) continue
    kept.push({
      id: e.id,
      label: e.label,
      reason: e.reason,
      table: e.table,
      kind: e.kind,
      rows: s.total ?? s.rows.length,
      columns: s.kind === 'columns' ? s.columns : [],
      sample: sampleRows(s, byId.get(e.id)),
      note: s.missing
    })
  }
  return {
    direction: o.direction,
    source: { key: o.source.key, label: o.source.label, database: o.source.database },
    target: { key: o.target.key, label: o.target.label, database: o.target.database },
    ready: !o.preflight.some((c) => c.state === 'fail'),
    preflight: o.preflight,
    copied: o.sourceTables,
    kept,
    switched_off: o.safety,
    files: o.filesFallback
      ? `Files are not copied. When ${o.target.label} has no copy of a file it reads ${o.source.label}'s (${o.filesFallback}) — read-only.`
      : `Files are not copied. Set FILES_FALLBACK_DIR on ${o.target.label} to read ${o.source.label}'s uploads read-only.`,
    steps: [...REFRESH_PHASES],
    rollback_hours: o.rollbackHours,
    generated_at: new Date().toISOString()
  }
}

/** The plan in plain words (the runner's dry-run log, a copyable summary). */
export function planLines(p: RefreshPlan): string[] {
  const L: string[] = []
  L.push(
    `Refresh ${p.target.label} (${p.target.database}) from ${p.source.label} (${p.source.database})`
  )
  L.push(p.ready ? 'Preflight: ready.' : 'Preflight: NOT ready — fix the failed checks first.')
  for (const c of p.preflight)
    L.push(
      `  ${c.state === 'ok' ? '✓' : c.state === 'warn' ? '⚠' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`
    )
  L.push('')
  L.push(
    `Copied: everything in ${p.source.database} — ${p.copied.tables} tables, about ${p.copied.rows.toLocaleString('en-US')} rows${p.copied.used_mb != null ? ` (${fmtMb(p.copied.used_mb)})` : ''}, people and their data as they are.`
  )
  L.push('')
  L.push(`Kept from ${p.target.label} (put back after the copy):`)
  for (const k of p.kept) {
    const what =
      k.kind === 'table'
        ? `whole table, ${k.rows} row(s)`
        : k.kind === 'columns'
          ? k.table === 'nivaro_flow_operations'
            ? `${k.rows} flow step(s) with their own addresses or secrets, matched by flow name + step key`
            : `${k.columns.length} column(s) on ${k.rows} row(s), matched by ${k.table === 'nivaro_settings' ? 'the settings row' : 'name'}`
          : k.kind === 'rows'
            ? `${k.rows} row(s)`
            : (k.note ?? 'kept by its own step')
    L.push(`  • ${k.label} — ${what}${k.note && k.kind !== 'delegate' ? ` (${k.note})` : ''}`)
    for (const r of k.sample.slice(0, 6)) {
      const vals = Object.entries(r.values)
        .slice(0, 6)
        .map(([c, v]) => `${c}=${v}`)
        .join(', ')
      L.push(`      ${r.key}: ${vals}`)
    }
  }
  L.push('')
  L.push('Switched off or held on the target (safety pass, always):')
  for (const s of p.switched_off)
    L.push(
      `  • ${s.label}: ${s.error ? `could not check (${s.error})` : s.count}${s.names?.length ? ` — ${s.names.slice(0, 8).join(', ')}${s.names.length > 8 ? ', …' : ''}` : ''}`
    )
  L.push('')
  L.push(p.files)
  L.push(
    `${p.target.label} is backed up first; "Roll back" puts it back within ${p.rollback_hours} hours.`
  )
  return L
}

/** Shared types for the Import Console (`/api/staged-imports`). */

export type ImportRunStatus = 'queued' | 'running' | 'completed' | 'error' | 'canceled'

/** A row of `nivaro_import_queue`, joined with its definition, file and queuer. */
export interface ImportRun {
  id: number
  definition: number | null
  import_key: string
  status: ImportRunStatus
  sort: number
  file: string | null
  row_count: number | null
  duration: number | null
  logs: string | null
  started_at: string | null
  finished_at: string | null
  created_by: string | null
  created_at: string | null
  updated_at: string | null
  legacy_id: number | null
  /** What executed: 'procedure:<name>', 'service', 'load' or a processor key.
   *  Null on runs from before it was recorded. */
  ran_via?: string | null
  reverted_at?: string | null
  /** Detail route only. */
  report?: ImportRunReport | null
  definition_label: string | null
  staging_table: string | null
  procedure: string | null
  /** null / 'proc' = stored procedure, 'service', or a registered processor key. */
  processor?: string | null
  loader: 'bulk' | 'bulk_only' | 'insert' | null
  definition_active: boolean | null
  file_name: string | null
  file_size: string | number | null
  created_by_first_name: string | null
  created_by_last_name: string | null
  created_by_email: string | null
}

export interface ImportDefinition {
  id: number
  key: string
  label: string | null
  description: string | null
  staging_table: string | null
  procedure: string | null
  loader: 'bulk' | 'bulk_only' | 'insert' | null
  file_types: string | null
  is_active: boolean
  sort: number
  /** Declared staging schema (JSON) — see the definitions editor. */
  staging_columns?: string | null
  /** App-managed procedure body; null = managed outside the app. */
  procedure_body?: string | null
  procedure_hash?: string | null
  procedure_deployed_at?: string | null
  /** Pre-flight validation config (JSON). */
  validation?: string | null
  /** null = stored-procedure path; 'service' = items-service diff-writes. */
  processor?: string | null
  service_config?: string | null
  /** JSON array of flow ids run in order after a successful run (migration 294). */
  post_run_flows?: string | null
  receipt?: string | null
  /** #802 — runs sharing a group never overlap; null = the staging table. */
  lock_group?: string | null
  /** #719 — JSON string[] of collections the procedure writes (rollups recomputed). */
  recalc_rollups?: string | null
  /** #846 — days after the last completed run the staging table is emptied; opt-in, null/0 = keep. */
  staging_purge_days?: number | null
  staging_purged_at?: string | null
}

/** GET /staged-imports/staging-tables (#846). */
export interface StagingTableInfo {
  table: string
  exists: boolean
  rows: number
  size_kb: number
  definitions: Array<{ id: number; key: string; label: string | null }>
  purge_days: number
  last_completed_at: string | null
  purge_due_at: string | null
  purged_at: string | null
  busy: boolean
  reason: string
}

export interface ImportValidationIssue {
  code: string
  message: string
  rows?: number[]
  count?: number
}

export interface ImportValidationReport {
  errors: ImportValidationIssue[]
  warnings: ImportValidationIssue[]
  stats: Record<string, number | boolean | null>
  truncated: boolean
}

/** Live queue depth is never windowed; the rest respects `window_days`. */
export interface ImportStats {
  window_days: number
  by_status: Partial<Record<ImportRunStatus, number>>
  total: number
  /** Unwindowed — distinguishes "nothing has ever run" from "nothing recently". */
  all_time_total: number
  /** Unwindowed run count per import key — a property of the definition. */
  by_key: Record<string, number>
  rows_imported: number
  median_duration: number | null
  success_rate: number | null
  runs_today: number
  active: Array<{
    id: number
    import_key: string
    status: 'queued' | 'running'
    started_at: string | null
    created_at: string | null
    row_count: number | null
  }>
}

/** Result of `POST /staged-imports/preview` — the worker's own parse, run
 *  against the file before anything is queued. */
export interface ImportPreview {
  row_count: number
  columns: string[]
  rows: Array<Record<string, string>>
  file_name: string
  staging_table: string | null
  staging_columns: string[] | null
  unknown_columns: string[]
  missing_columns: string[]
  /** Pre-flight report — errors here block queueing server-side too. */
  validation?: ImportValidationReport
  /** Service-mode definitions only: what a run would do, nothing written. */
  dry_run?: ImportDryRun | null
}

export interface ImportDryRun {
  created: number
  updated: number
  unchanged: number
  skipped: Record<string, number>
  failed: number
  log: string
  samples?: {
    creates: Array<{ key: string; values: Record<string, unknown> }>
    updates: Array<{
      key: string
      id: unknown
      changes: Array<{ field: string; from: unknown; to: unknown }>
    }>
    skipped_rows: Array<{ row: number; key: string | null; reason: string }>
    would_create_lookups: Array<{ column: string; collection: string; values: string[] }>
  }
}

/** Emitted by the worker on the `import:progress` socket event. */
export interface ImportProgressEvent {
  id: number
  stage: 'row_count' | 'preparing' | 'importing' | 'completed' | 'error'
  row_count?: number
  duration?: number
  error?: string
}

/**
 * Hosts own the socket (the shared package has no transport of its own — the
 * same contract `QueueWorklist` uses for `collection:update`). Without an
 * adapter the console still stays current on its 5s poll.
 */
export interface ImportRealtimeAdapter {
  subscribe: (onProgress: (event: ImportProgressEvent) => void) => () => void
}

export const RUN_STATUSES: ImportRunStatus[] = [
  'queued',
  'running',
  'completed',
  'error',
  'canceled'
]

export function runnerName(run: {
  created_by_first_name?: string | null
  created_by_last_name?: string | null
  created_by_email?: string | null
}): string | null {
  const name = [run.created_by_first_name, run.created_by_last_name]
    .filter(Boolean)
    .join(' ')
    .trim()
  return name || run.created_by_email || null
}

export function definitionTitle(d: { label?: string | null; key: string }): string {
  return d.label?.trim() || d.key
}

export interface ImportRunPhase {
  key: string
  label: string
  ms: number
  count?: number
  failed?: number
}

export interface ImportRunUnmatched {
  column: string
  label: string
  values: string[]
  distinct: number
  rows: number
  effect: string
}

/** What a run did — counts, timings, values in the file that matched nothing. */
export interface ImportRunReport {
  counts: {
    created: number
    updated: number
    unchanged: number
    skipped: number
    failed: number
    other?: Array<{ label: string; count: number }>
  }
  skipped: Record<string, number>
  phases: ImportRunPhase[]
  unmatched: ImportRunUnmatched[]
  notes: string[]
  collections?: Record<string, { created: number; updated: number }>
  items_stored?: number
  items_truncated?: boolean
}

export type ImportRunItemKind = 'created' | 'updated' | 'removed' | 'skipped' | 'failed'

export interface ImportRunItemChange {
  field: string
  label: string
  from: string | null
  to: string
  /** False when the value before the change was not kept. */
  from_known: boolean
}

export interface ImportRunItem {
  id: number
  kind: ImportRunItemKind
  collection: string | null
  item_id: string | null
  label: string
  row: number | null
  message: string | null
  reverted_at: string | null
  revert_note: string | null
  changes: ImportRunItemChange[]
}

export interface ImportRevertPreview {
  run: number
  total: number
  remove: number
  restore: number
  partly: number
  left_alone: number
  already_reverted: number
  not_applicable: number
  left: Array<{
    id: number
    label: string | null
    collection: string | null
    item_id: string | null
    note: string
  }>
}

/** What a FINISHED run executed. The definition may have changed since, so a
 *  run answers from what it recorded; older runs predate processors. */
export function runMode(run: {
  status?: string
  ran_via?: string | null
  processor?: string | null
  procedure?: string | null
}): { mode: ImportMode; name: string | null } {
  const via = (run.ran_via ?? '').trim()
  if (via) {
    if (via.startsWith('procedure:')) return { mode: 'procedure', name: via.slice(10) }
    if (via === 'service') return { mode: 'service', name: null }
    if (via === 'load') return { mode: 'load', name: null }
    return { mode: 'processor', name: via }
  }
  if (run.status === 'queued' || run.status === 'running') {
    const mode = importMode(run)
    return { mode, name: mode === 'processor' ? (run.processor ?? null) : (run.procedure ?? null) }
  }
  return { mode: run.procedure ? 'procedure' : 'load', name: run.procedure ?? null }
}

/**
 * What a run of this import executes.
 *   procedure — rows go to the staging table, the stored procedure merges them
 *   processor — a registered processor compares the file with live records and
 *               writes the differences through the items service
 *   service   — the single-collection items-service import
 *   load      — staging table only
 */
export type ImportMode = 'procedure' | 'processor' | 'service' | 'load'

export function importMode(d: {
  processor?: string | null
  procedure?: string | null
}): ImportMode {
  const p = (d.processor ?? '').trim()
  if (p === 'service') return 'service'
  if (p && p !== 'proc') return 'processor'
  return d.procedure ? 'procedure' : 'load'
}

/** `1m 12s` / `2h 04m` — durations here are whole seconds by contract. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// ─── Collection imports (`/api/imports`) ────────────────────────────────────
//
// A separate system from staged imports: a CSV's columns are mapped onto a
// collection's fields and each row goes through the item API. Same operator,
// same page, different machinery — never conflate the two tables.

export type ImportJobStatus = 'pending' | 'processing' | 'complete' | 'failed'

export interface ImportJob {
  id: string
  collection: string
  file_name: string
  column_map: Record<string, string> | null
  duplicate_strategy: string
  id_field: string | null
  status: ImportJobStatus
  total_rows: number | null
  processed_rows: number | null
  created_rows: number | null
  updated_rows: number | null
  skipped_rows: number | null
  error_rows: number | null
  errors: Array<{ row: number; error: string }> | null
  created_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  rolled_back_at?: string | null
  /** #748 — rows were written through the items service. */
  through_items?: boolean
}

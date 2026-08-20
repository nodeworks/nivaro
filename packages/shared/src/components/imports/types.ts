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
  definition_label: string | null
  staging_table: string | null
  procedure: string | null
  loader: 'bulk' | 'insert' | null
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
  loader: 'bulk' | 'insert' | null
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
  const name = [run.created_by_first_name, run.created_by_last_name].filter(Boolean).join(' ').trim()
  return name || run.created_by_email || null
}

export function definitionTitle(d: { label?: string | null; key: string }): string {
  return d.label?.trim() || d.key
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
}

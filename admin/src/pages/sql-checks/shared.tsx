import { cn } from '@/lib/utils'

/** SQL checks (#2562) — types and labels shared by the page's tabs. */

export type Severity = 'critical' | 'warning' | 'info'
export type FindingStatus = 'open' | 'resolved' | 'accepted'
export type ObjectType =
  | 'procedure'
  | 'function'
  | 'view'
  | 'trigger'
  | 'custom_query'
  | 'import_definition'

export interface SqlCheckSettings {
  enabled: boolean
  row_cap: number
  data_timeout_s: number
  data_checks: boolean
  include_custom_queries: boolean
  include_import_definitions: boolean
}

export interface RunRow {
  id: number
  started_at: string
  finished_at: string | null
  status: 'running' | 'ok' | 'failed'
  trigger: 'cron' | 'manual'
  objects_scanned: number
  findings_total: number
  findings_new: number
  findings_resolved: number
  critical_open: number
  warning_open: number
  info_open: number
  duration_ms: number | null
  error: string | null
  sqlfluff: 'on' | 'off' | 'unavailable'
  stats: {
    skipped_tables?: string[]
    data_queries?: number
    data_errors?: number
    by_check?: Record<string, number>
    objects_by_type?: Record<string, number>
    sqlfluff?: { linted: number; timeouts: number; parse_errors: number; reason?: string }
    fixes_recorded?: number
  } | null
}

export interface Summary {
  ready: boolean
  settings: SqlCheckSettings
  nightly?: { enabled: boolean; forced_by_env: boolean | null }
  sqlfluff_configured?: boolean
  counts?: Record<string, Partial<Record<Severity, number>>>
  by_check?: Record<string, number>
  top_objects?: Array<{
    object_type: ObjectType
    object_schema: string | null
    object_name: string
    object_ref: string | null
    n: number
  }>
  last_run?: RunRow | null
  trend?: Array<
    Pick<
      RunRow,
      | 'id'
      | 'started_at'
      | 'critical_open'
      | 'warning_open'
      | 'info_open'
      | 'findings_new'
      | 'findings_resolved'
    >
  >
  fixes_30d?: number
  is_running?: boolean
}

export interface FindingRow {
  id: number
  check_key: string
  severity: Severity
  status: FindingStatus
  object_schema: string | null
  object_name: string
  object_type: ObjectType
  object_ref: string | null
  line: number | null
  message: string
  first_seen_at: string
  first_seen_run: number
  last_seen_run: number
  seen_count: number
  resolved_at: string | null
}

export interface FindingDetail extends FindingRow {
  snippet: string | null
  detail: Record<string, unknown> | null
  suggested_fix: string | null
  accepted_by: string | null
  accepted_at: string | null
  accepted_note: string | null
  events: Array<{
    id: number
    run_id: number | null
    event: 'opened' | 'resolved' | 'reopened' | 'accepted' | 'unaccepted'
    at: string
    by: string | null
    note: string | null
  }>
}

export interface FixRow {
  id: number
  check_key: string | null
  target_table: string | null
  target_object: string | null
  action: 'cleanup' | 'proc_fix' | 'guard_index' | 'other'
  rows_affected: number | null
  backup_table: string | null
  detail: Record<string, unknown> | null
  run_by: string | null
  created_at: string
}

export const CHECK_LABEL: Record<string, string> = {
  'merge-null-key': 'MERGE on a nullable key',
  'merge-source-dupes': 'MERGE source may repeat a key',
  'write-without-where': 'Write without WHERE',
  'tran-without-xact-abort': 'Transaction without XACT_ABORT',
  'local-time': 'Local-time clock',
  'not-in-subquery': 'NOT IN over a nullable column',
  'select-star-wide': 'SELECT * on a wide table',
  'import-body-drift': 'Import body differs from deployed',
  sqlfluff: 'SQLFluff rule'
}

export const CHECK_WHY: Record<string, string> = {
  'merge-null-key':
    'NULL never equals NULL. A source row whose key is NULL never matches the row it already stored, so the MERGE inserts it again on every run, and totals that read the table count it twice.',
  'merge-source-dupes':
    'When two source rows carry the same key, SQL Server stops the whole MERGE and nothing imports that run.',
  'write-without-where':
    'The statement changes every row of the table, not just the ones it means to.',
  'tran-without-xact-abort':
    'If a statement inside the transaction fails, the transaction can stay open on a pooled connection; the next request to borrow it inherits its locks and its rollback.',
  'local-time':
    "GETDATE() is the server's local time. Next to timestamps stored in UTC, cut-offs and windows shift by the time-zone offset.",
  'not-in-subquery':
    'One NULL in the subquery makes NOT IN false for every row, so rows silently drop out of the result.',
  'select-star-wide':
    'Every row carries the table’s large text or binary columns over the wire, even when nothing reads them.',
  'import-body-drift':
    'The import runs the procedure deployed in the database, not the body stored on its definition. When they differ, editing the definition changes nothing until it is deployed.',
  sqlfluff: 'A correctness rule from SQLFluff (ambiguous references, unused CTEs and similar).'
}

export const TYPE_LABEL: Record<ObjectType, string> = {
  procedure: 'Procedure',
  function: 'Function',
  view: 'View',
  trigger: 'Trigger',
  custom_query: 'Custom query',
  import_definition: 'Import definition'
}

export const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info']

const PILL: Record<Severity, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  info: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
}

/** Severity colours for charts (same hue family in both themes). */
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#ef4444',
  warning: '#f59e0b',
  info: '#94a3b8'
}

export function SeverityPill({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10.5px] font-semibold capitalize',
        PILL[severity],
        className
      )}
    >
      {severity}
    </span>
  )
}

const STATUS_PILL: Record<FindingStatus, string> = {
  open: 'text-foreground',
  resolved: 'text-emerald-700 dark:text-emerald-400',
  accepted: 'text-slate-500 dark:text-muted-foreground'
}
export const STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'Open',
  resolved: 'Resolved',
  accepted: 'Expected'
}
export function StatusText({ status }: { status: FindingStatus }) {
  return (
    <span className={cn('text-[11.5px] font-medium', STATUS_PILL[status])}>
      {STATUS_LABEL[status]}
    </span>
  )
}

/** `schema.name` (or the name alone for stored bodies). */
export function objectLabel(f: {
  object_schema: string | null
  object_name: string
  object_type: ObjectType
}) {
  if (f.object_type === 'custom_query' || f.object_type === 'import_definition')
    return f.object_name
  return f.object_schema ? `${f.object_schema}.${f.object_name}` : f.object_name
}

/** Where the object is edited: /procedures for procedures, the editor for stored bodies. */
export function objectHref(f: {
  object_schema: string | null
  object_name: string
  object_type: ObjectType
  object_ref: string | null
}): string | null {
  if (f.object_type === 'procedure') return `/procedures?name=${encodeURIComponent(f.object_name)}`
  if (f.object_type === 'custom_query' && f.object_ref) return `/custom-queries/${f.object_ref}`
  if (f.object_type === 'import_definition')
    return `/imports?definition=${encodeURIComponent(f.object_name)}`
  return null
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

export function errorText(err: unknown, fallback: string): string {
  return (
    (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ?? fallback
  )
}

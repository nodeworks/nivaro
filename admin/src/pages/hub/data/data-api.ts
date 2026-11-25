import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Nivaro Hub — the Data tab (migration 569): backups, restore drills, environment refreshes and
 * move rehearsals. Types, query keys and fetchers for /api/hub/data/* and
 * /api/hub/environments/:id/data/*. Secrets on a read are the mask '••••••'.
 */

export type DataRunKind =
  | 'db_backup'
  | 'backup_seen'
  | 'files_backup'
  | 'restore_drill'
  | 'refresh'
  | 'refresh_rollback'
  | 'rehearsal'

export type DataRunStatus =
  | 'running'
  | 'waiting'
  | 'interrupted'
  | 'done'
  | 'failed'
  | 'refused'
  | 'cancelled'

export interface DataStep {
  key: string
  label: string
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'warn'
  started_at: string | null
  ms: number | null
  note: string | null
}

export interface DataRun {
  id: number
  kind: DataRunKind
  environment_id: number
  source_environment_id: number | null
  status: DataRunStatus
  step: string | null
  started_via: 'person' | 'schedule'
  steps: DataStep[]
  result: Record<string, unknown> | null
  artifact: Record<string, unknown> | null
  error: string | null
  started_at: string | null
  finished_at: string | null
  expires_at: string | null
  holds_keep_set: boolean
  /** Runs list only: what to type to abandon it. */
  abandon_confirm?: string
}

export type FilesTarget =
  | { kind: 'dir'; path: string }
  | { kind: 's3'; bucket: string; prefix: string; region: string | null; endpoint: string | null }

export interface BackupPolicy {
  environment_id: number
  db_enabled: boolean
  db_schedule: string | null
  db_path: string | null
  db_keep_days: number | null
  db_keep_count: number | null
  db_verify: boolean
  files_enabled: boolean
  files_schedule: string | null
  files_target: FilesTarget | null
  target_secret: string | null
  files_keep_count: number | null
  drill_enabled: boolean
  drill_schedule: string | null
  drill_checkdb: boolean
  notes: string | null
  updated_at: string | null
}

export interface DataEnvRow {
  env_id: number
  env_key: string
  position: number
  status: string
  app_key: string
  app_name: string
  policy: { db: boolean; files: boolean; drill: boolean }
  last: {
    db_backup: string | null
    backup_seen: string | null
    files_backup: string | null
    restore_drill: string | null
  }
  /** The newest drill whatever it ended as (absent from older Hubs). */
  drill?: { status: DataRunStatus; at: string | null } | null
  /** The run open on this environment now (absent from older Hubs). */
  open?: { kind: DataRunKind; status: DataRunStatus } | null
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * A cron expression in words for the common shapes ("Every day at 02:00 UTC"); anything else
 * reads "Custom schedule (UTC)". The server checks the expression itself.
 */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return 'Five fields: minute hour day month weekday'
  const [m, h, dom, mon, dow] = parts
  const num = (x: string, max: number) => /^\d+$/.test(x) && Number(x) <= max
  if (!num(m, 59)) return 'Custom schedule (UTC)'
  const mm = m.padStart(2, '0')
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at :${mm} (UTC)`
  if (!num(h, 23) || mon !== '*') return 'Custom schedule (UTC)'
  const at = `${h.padStart(2, '0')}:${mm} UTC`
  if (dom === '*' && dow === '*') return `Every day at ${at}`
  if (dom === '*' && num(dow, 7)) return `Every ${DAYS[Number(dow) % 7]} at ${at}`
  if (dom === '*' && dow === '1-5') return `Every weekday at ${at}`
  if (num(dom, 31) && dow === '*') return `On day ${dom} of every month at ${at}`
  return 'Custom schedule (UTC)'
}

/** "until 8:29 PM tomorrow · 23 h left" for an ISO expiry. */
export function untilWords(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const left = t - now
  if (left <= 0) return 'expired'
  const at = new Date(t)
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const tomorrow = new Date(now + 86_400_000).toDateString()
  const day =
    at.toDateString() === new Date(now).toDateString()
      ? 'today'
      : at.toDateString() === tomorrow
        ? 'tomorrow'
        : at.toLocaleDateString()
  const h = Math.floor(left / 3_600_000)
  return `until ${time} ${day} · ${h ? `${h} h` : `${Math.ceil(left / 60_000)} min`} left`
}

export interface LastBackupSeen {
  engine: string | null
  source: 'msdb' | 'pg_archiver' | 'none'
  full_at: string | null
  diff_at: string | null
  log_at: string | null
  archived_at: string | null
  hub_at: string | null
  recorded: { at: string; by: string | null; note: string | null } | null
  newest_at: string | null
  error: string | null
}

export interface EnvDataView {
  environment: {
    id: number
    key: string
    position: number
    status: string
    production: boolean
    production_reasons: string[]
    refresh_target: boolean
  }
  gate: DataGate
  gate_warning: string
  app: { id: number; key: string; name: string }
  database: { id: number; engine: string; database_name: string; status: string } | null
  server: {
    id: number
    name: string
    provision_mode: 'automatic' | 'manual'
    engine: string
  } | null
  native: boolean
  reason: string | null
  policy: BackupPolicy
  last_seen: LastBackupSeen | null
  checklist: Array<{ label: string; value: string }>
  latest: Partial<Record<DataRunKind, DataRun>>
  refresh_rollback: {
    run_id: number
    refusal: string | null
    expires_at: string | null
    /** The database the refresh replaced (pinned when it was planned). */
    database: string | null
  } | null
  refresh_sources: Array<{ env_id: number; env_key: string }>
  shared_deployments: Array<{ id: number; key: string; name: string }>
}

export interface DataGate {
  refresh_enabled: boolean
  drill_enabled: boolean
  rehearsal_enabled: boolean
}

export interface RefreshCheck {
  id: string
  state: 'ok' | 'warn' | 'fail'
  text: string
}

export interface RefreshPlan {
  source: {
    env_id: number
    env_key: string
    database: string | null
    server: string | null
    version: string | null
  }
  target: {
    env_id: number
    env_key: string
    database: string | null
    server: string | null
    version: string | null
  }
  same_server: boolean
  transfer_path: string | null
  kept: Array<{
    id: string
    label: string
    table: string
    kind: string
    rows: number | null
    note: string | null
  }>
  left_out: Array<{ id: string; label: string; why: string }>
  overwritten: string
  notes: string[]
  checks: RefreshCheck[]
  blocked: boolean
  rollback_hours: number
  confirm: string | null
  plan_hash: string
}

export const dataKeys = {
  envs: () => ['hub', 'data', 'envs'] as const,
  env: (id: number) => ['hub', 'data', 'env', id] as const,
  runs: (id: number) => ['hub', 'data', 'runs', id] as const
}

export const KIND_LABEL: Record<DataRunKind, string> = {
  db_backup: 'Database backup',
  backup_seen: 'Backup recorded',
  files_backup: 'Files backup',
  restore_drill: 'Restore drill',
  refresh: 'Refresh',
  refresh_rollback: 'Refresh rollback',
  rehearsal: 'Move rehearsal'
}

export const STATUS_LABEL: Record<DataRunStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  interrupted: 'Interrupted',
  done: 'Done',
  failed: 'Failed',
  refused: 'Refused',
  cancelled: 'Cancelled'
}

const isOpen = (s: DataRunStatus) => s === 'running' || s === 'waiting'

export function useDataEnvs() {
  return useQuery({
    queryKey: dataKeys.envs(),
    queryFn: () =>
      api.get<{ data: DataEnvRow[] }>('/hub/data/environments').then((r) => r.data.data)
  })
}

export function useEnvData(id: number | null) {
  return useQuery({
    queryKey: dataKeys.env(id ?? 0),
    enabled: id != null,
    queryFn: () =>
      api.get<{ data: EnvDataView }>(`/hub/environments/${id}/data`).then((r) => r.data.data),
    refetchInterval: (q) =>
      Object.values(q.state.data?.latest ?? {}).some((r) => r && isOpen(r.status)) ? 4000 : false
  })
}

export function useEnvRuns(id: number | null) {
  return useQuery({
    queryKey: dataKeys.runs(id ?? 0),
    enabled: id != null,
    queryFn: () =>
      api
        .get<{ data: DataRun[] }>(`/hub/environments/${id}/data/runs?limit=30`)
        .then((r) => r.data.data),
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => isOpen(r.status)) ? 4000 : false)
  })
}

/** "3 h ago" for an ISO time, "never" for none. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return 'unknown'
  if (ms < 60_000) return 'just now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

/** How fresh a backup is: fine under 26 h, late under 72 h, else stale. */
export function backupAge(
  iso: string | null | undefined,
  now = Date.now()
): 'fresh' | 'late' | 'stale' | 'none' {
  if (!iso) return 'none'
  const h = (now - Date.parse(iso)) / 3_600_000
  if (h < 26) return 'fresh'
  if (h < 72) return 'late'
  return 'stale'
}

export function fmtMs(ms: unknown): string {
  if (ms === null || ms === undefined || ms === '') return '—'
  const n = Number(ms)
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return `${Math.round(n)} ms`
  if (n < 120_000) return `${Math.round(n / 1000)} s`
  return `${Math.round(n / 60_000)} min`
}

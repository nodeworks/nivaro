import { api } from '@/lib/api'
import type { BeforeAfter } from '../costs/cost-api'

/**
 * Nivaro Hub Scaling tab: types, query keys and calls for /api/hub/scale* (routes/hub-scale.ts).
 * A "target" is one Docker stack: an environment's dedicated stack (kind environment) or a
 * shared deployment (kind shared).
 */

export type TargetKind = 'environment' | 'shared'
export type RoleName = 'all' | 'web' | 'worker' | 'realtime' | 'importer' | 'exporter'
export type Metric =
  | 'cpu_pct'
  | 'memory_pct'
  | 'requests_per_min'
  | 'p95_ms'
  | 'heavy_queue'
  | 'import_queue'
  | 'export_queue'

export interface MetricRule {
  metric: Metric
  out_above: number
  in_below: number
}

export interface ScaleSchedule {
  days: number[]
  from: string
  to: string
  zone: string
  min: number
}

export interface AutoRule {
  enabled: boolean
  min: number
  max: number
  metrics: MetricRule[]
  sustain: number
  sustain_in: number
  cooldown_out_min: number
  cooldown_in_min: number
  step_every_min: number
  step: number
  schedules: ScaleSchedule[]
}

export interface RoleView {
  role: RoleName
  replicas: number
  cpus: number | null
  memory_mb: number | null
  template: { replicas: number; cpus: number | null; memory_mb: number | null }
  scalable: boolean
  min: number
  pinned: boolean
  auto: AutoRule | null
  metrics: Metric[]
  max_hits: number
  last_change_at: string | null
  /** The rule paused itself after repeated failed runs; Resume rule lifts it. */
  paused_at: string | null
  paused_reason: string | null
  running?: { desired: number; running: number } | null
}

export interface RunSummary {
  id: number
  source: 'manual' | 'auto' | 'schedule'
  status: RunStatus
  reason: string | null
  created_at: string | null
  error_code: string | null
}

export interface TargetView {
  kind: TargetKind
  id: number
  key: string
  label: string
  production: boolean
  stack: string | null
  size: string
  version: string | null
  sqlite: boolean
  unusable: { code: string; text: string } | null
  roles: RoleView[]
  autoscaling: boolean
  maxed: boolean
  open_run: { id: number; source: string; reason: string | null } | null
  last_run: RunSummary | null
}

export interface Pause {
  code: string
  text: string
}

export interface ServerMath {
  id: number
  name: string
  max_connections: number | null
  others: number
  from: number
  to: number
  after: number
  fits: boolean | null
}

export interface ConnMath {
  kind: TargetKind
  processes: { from: number; to: number }
  per_process: number
  pools?: { main: number; background: number; probe: number }
  budget?: { per_process: number; used: number }
  total: { from: number; to: number }
  servers: ServerMath[]
  unknown: string[]
  /** A server limit (or the database record) is unknown. */
  limit_unknown: boolean
}

export interface RoleFigures {
  role: RoleName
  replicas: number
  cpus: number | null
  memory_mb: number | null
}

export interface Caps {
  max_replicas: number
  max_total_replicas: number
  cpus: [number, number]
  memory_mb: [number, number]
}

export type RunStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'interrupted'

export interface ScaleRun {
  id: number
  target_kind: TargetKind
  target_id: number
  stack: string | null
  source: 'manual' | 'auto' | 'schedule'
  status: RunStatus
  reason: string | null
  figures: Record<string, unknown> | null
  from: RoleFigures[]
  to: RoleFigures[]
  steps: { to: RoleFigures[]; status: 'pending' | 'applying' | 'done' | 'failed' }[]
  step_index: number
  error_code: string | null
  error: string | null
  started_by: string | null
  created_at: string | null
  finished_at: string | null
}

export interface TargetDetail extends TargetView {
  status: { state: string; spec_hash: string | null } | null
  now: {
    connections: ConnMath
    blockers: Pause[]
    warnings: Pause[]
    agent: { version: string | null; ok: boolean }
    caps: Caps
    confirm: string | null
  }
  runs: ScaleRun[]
}

export interface ScalePlan {
  kind: TargetKind
  id: number
  from: RoleFigures[]
  to: RoleFigures[]
  changes: { role: RoleName; replicas?: number; cpus?: number; memory_mb?: number }[]
  steps: RoleFigures[][]
  connections: ConnMath
  blockers: Pause[]
  warnings: Pause[]
  confirm: string | null
  plan_hash: string
  /** Task 44a: the shape's cost before → after at the Hub's rates (never in plan_hash). */
  cost?: BeforeAfter | null
}

export interface DbServer {
  id: number
  name: string
  engine: string
  host: string
  max_connections: number | null
}

export type RoleChange = { role: RoleName; replicas?: number; cpus?: number; memory_mb?: number }

export const scaleKeys = {
  all: ['hub', 'scale'] as const,
  overview: () => ['hub', 'scale', 'overview'] as const,
  detail: (kind: TargetKind, id: number) => ['hub', 'scale', 'detail', kind, id] as const,
  servers: () => ['hub', 'scale', 'servers'] as const
}

export const fetchScaleOverview = () =>
  api.get<{ data: { targets: TargetView[] } }>('/hub/scale').then((r) => r.data.data)

export const fetchScaleDetail = (kind: TargetKind, id: number) =>
  api.get<{ data: TargetDetail }>(`/hub/scale/targets/${kind}/${id}`).then((r) => r.data.data)

export const planScale = (kind: TargetKind, id: number, roles: RoleChange[]) =>
  api
    .post<{ data: ScalePlan }>(`/hub/scale/targets/${kind}/${id}/plan`, { roles })
    .then((r) => r.data.data)

export const startScale = (
  kind: TargetKind,
  id: number,
  body: { roles: RoleChange[]; plan_hash: string; confirm?: string }
) =>
  api
    .post<{ data: { run_id: number } }>(`/hub/scale/targets/${kind}/${id}/runs`, body)
    .then((r) => r.data.data)

export const saveRole = (
  kind: TargetKind,
  id: number,
  role: RoleName,
  body: { pinned?: boolean; auto?: AutoRule | null; resume?: boolean }
) =>
  api
    .put<{ data: TargetDetail }>(`/hub/scale/targets/${kind}/${id}/roles/${role}`, body)
    .then((r) => r.data.data)

export const cancelScaleRun = (id: number) =>
  api.post(`/hub/scale/runs/${id}/cancel`).then(() => undefined)

export const fetchDbServers = () =>
  api.get<{ data: DbServer[] }>('/hub/scale/db-servers').then((r) => r.data.data)

export const saveDbServerLimit = (id: number, max: number | null) =>
  api.put(`/hub/scale/db-servers/${id}`, { max_connections: max }).then(() => undefined)

/** `environment:3` ⇄ {kind, id} (the page's ?target=, the Hub notices link here). */
export function parseTargetParam(v: string | null): { kind: TargetKind; id: number } | null {
  const m = /^(environment|shared):(\d{1,10})$/.exec(v ?? '')
  return m ? { kind: m[1] as TargetKind, id: Number(m[2]) } : null
}
export const targetParam = (t: { kind: TargetKind; id: number }) => `${t.kind}:${t.id}`

export const ROLE_WORDS: Record<RoleName, string> = {
  all: 'All in one',
  web: 'Web',
  worker: 'Worker',
  realtime: 'Realtime',
  importer: 'Importer',
  exporter: 'Exporter'
}

export const ROLE_HINT: Record<RoleName, string> = {
  all: 'One process runs everything (size small). Change the stack’s size to split it.',
  web: 'Answers every request. Never below one.',
  worker: 'Ticks every scheduled job through one leader: it stays at one.',
  realtime: 'Holds the live connections. A scale-in stops one process at a time.',
  importer: 'Drains staged imports.',
  exporter: 'Runs background exports.'
}

export const METRIC_WORDS: Record<Metric, { label: string; unit: string }> = {
  cpu_pct: { label: 'CPU', unit: '% of limit' },
  memory_pct: { label: 'Memory', unit: '% of limit' },
  requests_per_min: { label: 'Requests', unit: '/min per replica' },
  p95_ms: { label: 'p95 answer time', unit: 'ms' },
  heavy_queue: { label: 'Heavy reads waiting', unit: 'reads' },
  import_queue: { label: 'Imports waiting', unit: 'imports' },
  export_queue: { label: 'Exports waiting', unit: 'exports' }
}

export const METRIC_DEFAULTS: Record<Metric, { out_above: number; in_below: number }> = {
  cpu_pct: { out_above: 70, in_below: 30 },
  memory_pct: { out_above: 80, in_below: 40 },
  requests_per_min: { out_above: 600, in_below: 150 },
  p95_ms: { out_above: 1500, in_below: 300 },
  heavy_queue: { out_above: 5, in_below: 1 },
  import_queue: { out_above: 5, in_below: 1 },
  export_queue: { out_above: 5, in_below: 1 }
}

export const SOURCE_WORDS: Record<ScaleRun['source'], string> = {
  manual: 'By hand',
  auto: 'Autoscaling',
  schedule: 'Schedule'
}

export const RUN_STATUS_WORDS: Record<RunStatus, string> = {
  running: 'Running',
  success: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Not run',
  interrupted: 'Interrupted'
}

/** "web 3 → 5, realtime memory 1024 → 2048 MB" (the server's run text, client side). */
export function changeText(from: RoleFigures[], to: RoleFigures[]): string {
  const parts: string[] = []
  for (const t of to) {
    const f = from.find((x) => x.role === t.role)
    if (!f) continue
    const bits: string[] = []
    if (f.replicas !== t.replicas) bits.push(`${f.replicas} → ${t.replicas}`)
    if (f.cpus !== t.cpus) bits.push(`CPU ${f.cpus ?? '—'} → ${t.cpus ?? '—'}`)
    if (f.memory_mb !== t.memory_mb) bits.push(`${f.memory_mb ?? '—'} → ${t.memory_mb ?? '—'} MB`)
    if (bits.length) parts.push(`${ROLE_WORDS[t.role]} ${bits.join(', ')}`)
  }
  return parts.join(' · ')
}

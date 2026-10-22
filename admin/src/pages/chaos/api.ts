import { api } from '@/lib/api'

/**
 * The chaos console's client (#2827): types mirroring api/src/services/chaos/* and the fetchers
 * every tab shares. Query keys are namespaced `['chaos', …]`.
 */

export type FaultTarget =
  | { kind: 'all' }
  | { kind: 'route'; pattern: string }
  | { kind: 'table'; table: string }
  | { kind: 'user'; user_id: string; name?: string | null }
  | { kind: 'share'; share_pct: number }
  | { kind: 'node'; node: string }
  | { kind: 'room'; room: string }

export type ParamSpec =
  | {
      type: 'number'
      label: string
      min: number
      max: number
      default: number
      unit?: string
      step?: number
    }
  | { type: 'boolean'; label: string; default: boolean }
  | { type: 'string'; label: string; default?: string; max_length?: number; pattern?: string }
  | { type: 'enum'; label: string; options: string[]; default: string }

export interface HypothesisRule {
  sampler: string
  op: '<' | '<=' | '>' | '>='
  limit: number
  tolerance?: number
}

export interface ArmedFault {
  id: string
  fault_key: string
  label: string
  target: FaultTarget
  params: Record<string, number | string | boolean>
  started_at: number
  ends_at: number
  started_by: string | null
  started_by_name: string | null
  run_id: string | null
  node: string
}

export interface ChaosStatus {
  allowed: boolean
  reason: string | null
  armed: ArmedFault[]
  nodes: string[]
}

export type Verdict = 'held' | 'broke' | 'aborted'
export type RunStatus =
  | 'planned'
  | 'preflight'
  | 'running'
  | 'aborted'
  | 'stopped'
  | 'completed'
  | 'refused'

export interface CatalogFault {
  key: string
  label: string
  area: string | null
  proves: string
  claim_keys: string[]
  targets: FaultTarget['kind'][]
  params: Record<string, ParamSpec>
  max_seconds: number
  default_seconds: number
  points: string[]
  danger: 'low' | 'medium' | 'high'
  hypothesis_defaults: HypothesisRule[]
  console_href: string | null
  last_run: {
    id: string
    status: RunStatus
    verdict: Verdict | null
    started_at: string | null
    ended_at: string | null
  } | null
}

export interface Catalog {
  refusal: string | null
  store: 'db' | 'redis' | 'memory'
  faults: CatalogFault[]
}

export interface ChaosRun {
  id: string
  kind: 'drill' | 'monkey' | 'gameday' | 'ci'
  status: RunStatus
  fault_key: string | null
  label: string
  target: FaultTarget | null
  params: Record<string, number | string | boolean>
  hypothesis: HypothesisRule[]
  verdict: Verdict | null
  verdict_detail: Record<string, unknown> | null
  baseline: Record<string, unknown> | null
  started_by: string | null
  started_at: string | null
  ends_at: string | null
  ended_at: string | null
  preset_id: string | null
  gameday_id: string | null
  meta: Record<string, unknown>
  created_at: string
}

export interface ChaosRunEvent {
  id: number
  run_id: string
  at: string
  kind: 'armed' | 'disarmed' | 'sample' | 'alert' | 'readiness' | 'note' | 'abort' | 'stop' | 'step'
  actor: string | null
  data: Record<string, unknown>
}

export interface PreflightCheck {
  key: string
  label: string
  ok: boolean
  why: string | null
  /** The check an admin may override on the start form (working hours only). */
  overridable?: boolean
}

export interface Preflight {
  ok: boolean
  checks: PreflightCheck[]
}

export const chaosKeys = {
  status: ['chaos', 'status'] as const,
  catalog: ['chaos', 'catalog'] as const,
  runs: (filter?: string) => ['chaos', 'runs', filter ?? 'all'] as const,
  run: (id: string) => ['chaos', 'run', id] as const,
  preflight: ['chaos', 'preflight'] as const
}

export const fetchStatus = () => api.get('/chaos/status').then((r) => r.data.data as ChaosStatus)
export const fetchCatalog = () => api.get('/chaos/catalog').then((r) => r.data.data as Catalog)
export const fetchRuns = (params?: Record<string, string | number>) =>
  api.get('/chaos/runs', { params }).then((r) => r.data.data as ChaosRun[])
export const fetchRun = (id: string, after = 0) =>
  api
    .get(`/chaos/runs/${id}`, { params: after ? { after } : undefined })
    .then((r) => r.data.data as { run: ChaosRun; events: ChaosRunEvent[] })
export const fetchPreflight = () =>
  api.get('/chaos/preflight').then((r) => r.data.data as Preflight)

export interface StartRunBody {
  fault_key: string
  target?: FaultTarget
  params?: Record<string, number | string | boolean>
  seconds?: number
  hypothesis?: HypothesisRule[] | null
  override?: { working_hours?: boolean } | null
  note?: string | null
}

export const startRun = (body: StartRunBody) =>
  api.post('/chaos/runs', body).then((r) => r.data.data as { run: ChaosRun; fault: ArmedFault })
export const stopRun = (id: string) =>
  api.post(`/chaos/runs/${id}/stop`, {}).then((r) => r.data.data as ChaosRun)
export const stopAll = () =>
  api
    .post('/chaos/stop-all', {})
    .then((r) => r.data.data as { stopped: Array<{ id: string }>; runs: string[] })

export const errText = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

/** The server's refusal details on a 409 pre-flight failure, when present. */
export const preflightOf = (e: unknown): PreflightCheck[] | null => {
  const d = (
    e as { response?: { data?: { code?: string; details?: { checks?: PreflightCheck[] } } } }
  )?.response?.data
  return d?.code === 'CHAOS_PREFLIGHT' && Array.isArray(d.details?.checks) ? d.details.checks : null
}

export const VERDICT_TONE: Record<Verdict, string> = {
  held: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  broke: 'bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300',
  aborted: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  planned: 'Planned',
  preflight: 'Pre-flight',
  running: 'Running',
  aborted: 'Aborted',
  stopped: 'Stopped',
  completed: 'Completed',
  refused: 'Refused'
}

export function describeTarget(t: FaultTarget | null | undefined): string {
  if (!t) return 'everything'
  switch (t.kind) {
    case 'all':
      return 'everything'
    case 'route':
      return `routes ${t.pattern}`
    case 'table':
      return `table ${t.table}`
    case 'user':
      return t.name ? `${t.name}` : 'one person'
    case 'share':
      return `${t.share_pct}% of traffic`
    case 'node':
      return `replica ${t.node}`
    case 'room':
      return `room ${t.room}`
  }
}

/** mm:ss left until `endsAt` (never negative). */
export function countdown(endsAt: number | string, now = Date.now()): string {
  const ms = Math.max(0, new Date(endsAt).getTime() - now)
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

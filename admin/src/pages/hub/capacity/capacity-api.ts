import { api } from '@/lib/api'

/**
 * Nivaro Hub capacity tab: types, query keys and calls for /api/hub/capacity* (routes/
 * hub-capacity.ts). Figures only: counts, timings and bytes the Hub stored every 15 minutes.
 */

export interface AppLimits {
  requests_per_minute?: number
  jobs?: number
  storage_mb?: number
}

export const LIMIT_FIELDS: {
  key: keyof AppLimits
  label: string
  unit: string
  min: number
  max: number
  hint: string
}[] = [
  {
    key: 'requests_per_minute',
    label: 'Requests per minute',
    unit: '/min',
    min: 10,
    max: 1_000_000,
    hint: 'Past it the app answers 429 until the next minute.'
  },
  {
    key: 'jobs',
    label: 'Background jobs at once',
    unit: 'jobs',
    min: 1,
    max: 16,
    hint: 'More wait their turn (up to 5 minutes, then run at their next time).'
  },
  {
    key: 'storage_mb',
    label: 'File storage',
    unit: 'MB',
    min: 1,
    max: 100_000_000,
    hint: 'An upload past it is refused (413).'
  }
]

export interface Figures {
  sampled_at: string
  cpu_pct: number | null
  memory_mb: number | null
  requests_per_min: number | null
  busy_ms_per_min: number | null
  errors_per_min: number | null
  db_in_use: number | null
  db_waiting: number | null
  db_pool_max: number | null
  jobs_running: number | null
  jobs_waiting: number | null
  storage_bytes: number | null
  processes: number | null
  error: string | null
}

export interface TrendPoint {
  at: string
  requests_per_min: number | null
  busy_ms_per_min: number | null
  cpu_pct: number | null
  memory_mb: number | null
  db_in_use: number | null
  storage_bytes: number | null
  samples: number
}

export interface Share {
  requests: number | null
  busy: number | null
  db: number | null
}

export interface AppCapacity {
  env_id: number
  app_id: number | null
  app_key: string
  app_name: string
  env_key: string
  tenant_id: string | null
  latest: Figures | null
  share: Share | null
  uses_most: boolean
  limits: AppLimits
  trend: TrendPoint[]
}

export interface SharedCapacity {
  id: number
  key: string
  name: string
  status: string
  pool_budget: number
  latest: Figures | null
  trend: TrendPoint[]
  apps: AppCapacity[]
}

export interface CapacityOverview {
  generated_at: string
  settings: {
    most_share: number
    min_samples: number
    fits: { max_rpm: number; max_memory_mb: number; max_db_in_use: number; max_storage_gb: number }
    outgrew: { share: number; sustained: number; max_rpm: number }
  }
  shared: SharedCapacity[]
  dedicated: AppCapacity[]
}

export interface Advice {
  env_id: number
  app_id: number | null
  app_key: string
  env_key: string
  kind: 'fits_shared' | 'outgrew_shared'
  reasons: { code: string; text: string }[]
  target: { kind: 'shared'; shared_id: number; key: string } | { kind: 'dedicated' }
  plan_path: string
}

export interface RebalanceMovePlan {
  env_id: number
  label: string
  from_shared_id: number
  to_shared_id: number
  load: number
  pool: number
  plan_hash: string | null
  checklist: { id: string; text: string; required: boolean }[]
  blockers: { code: string; text: string }[]
  routing: 'automatic' | 'manual' | null
  cannot_run: string | null
}

export interface RebalanceProposal {
  shared: { id: number; key: string; load_before: number; load_after: number }[]
  moves: RebalanceMovePlan[]
  held: { env_id: number; label: string; why: string }[]
}

export type RebalanceStatus = 'running' | 'cancelling' | 'success' | 'failed' | 'cancelled'

export interface RebalanceRun {
  id: number
  status: RebalanceStatus
  shared_ids: number[]
  moves: {
    env_id: number
    label: string
    from_shared_id: number
    to_shared_id: number
    move_id: number | null
    result: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  }[]
  window_start: string
  window_end: string
  window_tz: string
  current_index: number
  current_move_id: number | null
  note: string | null
  error: string | null
  created_at: string | null
  finished_at: string | null
}

export const capacityKeys = {
  all: ['hub', 'capacity'] as const,
  overview: () => ['hub', 'capacity', 'overview'] as const,
  advice: () => ['hub', 'capacity', 'advice'] as const,
  rebalances: () => ['hub', 'capacity', 'rebalances'] as const
}

export const fetchCapacity = () =>
  api.get<{ data: CapacityOverview }>('/hub/capacity').then((r) => r.data.data)

export const fetchAdvice = () =>
  api.get<{ data: Advice[] }>('/hub/capacity/advice').then((r) => r.data.data)

export const sampleNow = () =>
  api
    .post<{ data: { shared: number; environments: number; failed: number } }>(
      '/hub/capacity/sample',
      {}
    )
    .then((r) => r.data.data)

/** null for a limit = no limit. */
export const saveLimits = (envId: number, limits: Record<keyof AppLimits, number | null>) =>
  api
    .put<{ data: AppLimits; changed: boolean }>(`/hub/capacity/limits/${envId}`, limits)
    .then((r) => r.data)

export const planRebalance = (sharedIds: number[], maxMoves: number) =>
  api
    .post<{ data: RebalanceProposal }>('/hub/capacity/rebalance/plan', {
      shared_ids: sharedIds,
      max_moves: maxMoves
    })
    .then((r) => r.data.data)

export const startRebalance = (body: {
  shared_ids: number[]
  moves: {
    env_id: number
    to_shared_id: number
    pool_max: number
    plan_hash: string
    checklist: Record<string, boolean>
  }[]
  window: { start: string; end: string; tz: string }
  confirm: string
}) => api.post<{ data: { id: number } }>('/hub/capacity/rebalances', body).then((r) => r.data.data)

export const fetchRebalances = () =>
  api.get<{ data: RebalanceRun[] }>('/hub/capacity/rebalances').then((r) => r.data.data)

export const cancelRebalance = (id: number) =>
  api
    .post<{ data: RebalanceRun }>(`/hub/capacity/rebalances/${id}/cancel`, {})
    .then((r) => r.data.data)

/** The largest of an app's shares, or null. */
export function topShare(s: Share | null): number | null {
  if (!s) return null
  const xs = [s.requests, s.busy, s.db].filter((x): x is number => typeof x === 'number')
  return xs.length ? Math.max(...xs) : null
}

export const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`

export const num = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: digits })

/** Words for a sample's error code (the link's codes, never raw text). */
export const SAMPLE_ERRORS: Record<string, string> = {
  LINK_REFUSED: 'The link refused the Hub (token)',
  UNREACHABLE: 'Not answering',
  TIMEOUT: 'Took too long to answer',
  NO_USAGE_ROUTE: 'Runs a version without capacity figures (before 0.3.215)',
  NO_TOKEN: 'The Hub holds no token for it',
  BAD_LINK_URL: 'Its link address is not one the Hub may call',
  BAD_BASE_URL: 'Its address is not one the Hub may call',
  HUB_SECRET_UNREADABLE: 'The Hub cannot read its stored token',
  BAD_ANSWER: 'Answered something the Hub could not read',
  TOO_LARGE: 'Answered too much',
  NOT_LISTED: 'Not in the deployment’s list yet',
  PARTIAL: 'Only one process answered (its Redis could not be read)'
}

export const sampleError = (code: string | null) =>
  code
    ? (SAMPLE_ERRORS[code] ?? (code.startsWith('HTTP_') ? `Answered ${code.slice(5)}` : code))
    : null

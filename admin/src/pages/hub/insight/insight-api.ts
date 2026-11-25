import { api } from '@/lib/api'

/**
 * Hub insight (Apps → Health, Usage, Dependencies, Ask the Hub): types, query keys and fetchers
 * for /api/hub/insight/*. Every read comes from the Hub's own tables (the collect and score jobs
 * fill them); a page view never makes the Hub call an app. Scoped like every Hub read: admins see
 * every app, owners their own.
 */

export const HEALTH_PARTS = [
  'uptime',
  'errors',
  'drift',
  'issues',
  'readiness',
  'backups',
  'secrets'
] as const
export type HealthPart = (typeof HEALTH_PARTS)[number]
export type HealthBand = 'good' | 'fair' | 'poor'

export const PART_LABEL: Record<HealthPart, string> = {
  uptime: 'Uptime',
  errors: 'Errors',
  drift: 'Drift',
  issues: 'Issues',
  readiness: 'Readiness',
  backups: 'Backups',
  secrets: 'Secrets'
}

export const PART_HINT: Record<HealthPart, string> = {
  uptime: 'Uptime over 30 days (Fleet). 99.9 % or better scores 100; 95 % or less scores 0.',
  errors:
    'Failed requests over the last 24 hours (Capacity). 0.1 % or less scores 100; 5 % scores 0.',
  drift: 'Open drift alerts (Fleet): none 100, one 60, two 30, more 0.',
  issues: 'Open issues the app reported: 100, less 5 for each.',
  readiness: 'The readiness score the app reported.',
  backups:
    'Age of the newest backup (Backups & data). A day or less scores 100, a week 0. Counted on production and wherever a backup policy is on.',
  secrets: 'Secret rotation (Secrets): overdue 0, due soon 60, on time 100.'
}

export interface PartScore {
  part: HealthPart
  score: number | null
  weight: number
  figure: string | null
}

export interface EnvHealth {
  app_id: number
  app_key: string
  app_name: string
  environment_id: number
  env_key: string
  production: boolean
  score: number | null
  band: HealthBand | null
  parts: PartScore[]
  trend: Array<{ day: string; score: number | null }>
}

export interface HealthAnswer {
  weights: Record<HealthPart, number>
  parts: HealthPart[]
  environments: EnvHealth[]
}

export interface InsightSettings {
  weights: Record<HealthPart, number>
  usage: { floor: number; days: number }
  digest: { enabled: boolean }
}

export interface UsageDay {
  day: string
  people: number | null
  views: number | null
  under_floor: boolean
}

export interface EnvUsage {
  environment_id: number
  env_key: string
  production: boolean
  state: string | null
  collected_at: string | null
  people_7d: number | null
  people_window: number | null
  accounts: number | null
  adoption: number | null
  daily: UsageDay[]
  weekly: Array<{ week: string; avg_people: number | null; days: number }>
  screens: Array<{ route: string; people: number; views: number }>
  screens_hidden: number | null
  period_days: number | null
}

export interface AppUsage {
  app_id: number
  app_key: string
  app_name: string
  environments: EnvUsage[]
}

export interface UsageAnswer {
  floor: number
  apps: AppUsage[]
}

export type DepKind =
  | 'app'
  | 'partner_api'
  | 'webhook'
  | 'mail'
  | 'signin'
  | 'tracker'
  | 'extension'
  | 'database'
  | 'shared'
  | 'driver'

export const DEP_KIND_LABEL: Record<DepKind, string> = {
  app: 'App',
  partner_api: 'Partner APIs',
  webhook: 'Webhooks',
  mail: 'Mail relay',
  signin: 'Sign-in',
  tracker: 'Issue trackers',
  extension: 'Extensions',
  database: 'Database servers',
  shared: 'Shared deployments',
  driver: 'Drivers'
}

export interface DepNode {
  id: string
  kind: DepKind
  target: string
  label: string
  environments: number
}

export interface DepUse {
  node: string
  app_id: number
  app_name: string
  environment_id: number
  env_key: string
  production: boolean
  label: string | null
  detail: string | null
  source: 'app' | 'hub'
}

export interface DependencyMap {
  nodes: DepNode[]
  edges: Array<{ from: string; to: string; envs: string[]; detail: string | null }>
  uses: DepUse[]
  states: Array<{ environment_id: number; state: string | null; at: string | null }>
}

export interface ImpactAnswer {
  node: DepNode | null
  affected: DepUse[]
  apps: number
  production: number
}

export interface CollectState {
  status: 'none' | 'running' | 'done' | 'failed'
  started_at?: string
  finished_at?: string
  summary?: { environments?: number; usage_ok?: number; deps_ok?: number; busy?: boolean }
}

export interface DigestMe {
  enabled: boolean
  delivered: boolean
  owns_apps: boolean
}

export interface AskAnswer {
  answer: string
  citations: Array<{ label: string; path: string }>
  tools: string[]
  partial: boolean
}

export const insightKeys = {
  all: ['hub', 'insight'] as const,
  health: () => ['hub', 'insight', 'health'] as const,
  usage: () => ['hub', 'insight', 'usage'] as const,
  deps: () => ['hub', 'insight', 'dependencies'] as const,
  impact: (node: string) => ['hub', 'insight', 'impact', node] as const,
  settings: () => ['hub', 'insight', 'settings'] as const,
  collect: () => ['hub', 'insight', 'collect'] as const,
  digest: () => ['hub', 'insight', 'digest-me'] as const
}

const data = <T>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data)

export const fetchHealth = () => data(api.get<{ data: HealthAnswer }>('/hub/insight/health'))
export const fetchUsage = () =>
  data(api.get<{ data: UsageAnswer }>('/hub/insight/usage', { params: { days: 90 } }))
export const fetchDependencies = () =>
  data(api.get<{ data: DependencyMap }>('/hub/insight/dependencies'))
export const fetchImpact = (node: string) =>
  data(api.get<{ data: ImpactAnswer }>('/hub/insight/impact', { params: { node } }))
export const fetchInsightSettings = () =>
  data(api.get<{ data: InsightSettings }>('/hub/insight/settings'))
export const saveInsightSettings = (s: Partial<InsightSettings>) =>
  data(api.put<{ data: InsightSettings }>('/hub/insight/settings', s))
export const fetchCollect = () => data(api.get<{ data: CollectState }>('/hub/insight/collect'))
export const startCollect = () => data(api.post<{ data: CollectState }>('/hub/insight/collect'))
export const fetchDigestMe = () => data(api.get<{ data: DigestMe }>('/hub/insight/digest/me'))
export const saveDigestMe = (enabled: boolean) =>
  data(api.put<{ data: { enabled: boolean } }>('/hub/insight/digest/me', { enabled }))
export const askHub = (messages: Array<{ role: 'user' | 'assistant'; content: string }>) =>
  data(api.post<{ data: AskAnswer }>('/hub/insight/ask', { messages }))

/** The score tone, never colour alone: the band word rides beside it. */
export const BAND_TONE: Record<HealthBand, string> = {
  good: 'text-emerald-700 dark:text-emerald-300',
  fair: 'text-amber-700 dark:text-amber-300',
  poor: 'text-red-700 dark:text-red-300'
}

export const BAND_LABEL: Record<HealthBand, string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor'
}

/** The change over the stored trend (first stored day → now), or null. */
export function trendChange(h: Pick<EnvHealth, 'score' | 'trend'>): number | null {
  const first = h.trend.find((t) => t.score != null)?.score ?? null
  return h.score != null && first != null ? h.score - first : null
}

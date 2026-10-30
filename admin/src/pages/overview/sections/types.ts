/** Response shapes of /api/overview/* (api/src/routes/overview.ts, services/overview/*). */

export type Tone = 'critical' | 'warn' | 'info'

export interface NeedsYouItem {
  key: string
  tone: Tone
  count: number
  sentence: string
  action: { label: string; href: string }
}

export type HealthStatus = 'ok' | 'slow' | 'down' | 'attention'

export interface OverviewHealth {
  status: HealthStatus
  headline: string
  /** Administrators only. */
  version?: string
  deployed_at?: string | null
  readiness?: {
    fail: number
    warn: number
    error: number
    score: number | null
    computed_at: string | null
    refreshing: boolean
  } | null
}

export interface FollowedThing {
  key: string
  kind: 'record' | 'collection' | 'queue' | 'field'
  label: string
  detail: string | null
  href: string
  unread: number
  collection: string | null
  item: string | null
}

export type ProblemSource = 'jobs' | 'sql' | 'readiness' | 'integrations'

export interface ProblemCandidate {
  key: string
  source: ProblemSource
  severity: 'critical' | 'warn'
  since: string | null
  sentence: string
  href: string
}

export type MarkKind = 'job' | 'deploy' | 'import' | 'config'

export interface TimelineMark {
  at: string
  kind: MarkKind
  failed: boolean
  sentence: string
  href: string
}

export interface TimelineBucket {
  start: string
  end: string
  total: number
  failed: number
  kinds: Record<MarkKind, number>
  sample: TimelineMark[]
}

export interface OverviewTimeline {
  start: string
  end: string
  buckets: TimelineBucket[]
  notable: TimelineMark[]
  routine_jobs: number
}

export interface WaitingPerson {
  id: string
  name: string
  email: string
  role: string | null
  role_name: string | null
  requested: boolean
  waiting_since: string | null
  reason: string | null
  requested_role: string | null
}

export interface PeopleWaiting {
  people: WaitingPerson[]
  total: number
  grantable_roles: Array<{ id: string; name: string }>
  configured: boolean
}

export interface OverviewUsage {
  busiest_collections: Array<{ collection: string; label: string | null; changes: number }>
  screens: Array<{ route: string; views: number; people: number | null }>
  screens_source: 'page_views' | 'rum' | null
  slowest_page: { route: string; p75_ms: number; samples: number } | null
}

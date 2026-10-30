/**
 * Command Center contract — every response shape the board reads, in one place, so the API
 * (api/src/routes/command-center*.ts) and the panels agree. All GETs live under /command-center
 * and accept the two lenses `region` (region row id) and `at` (ISO instant, rewind) unless noted;
 * a read that cannot rewind answers live with `live_only: true`.
 */

// ── /snapshot (existing; region + at aware where possible) ────────────────────────────────────
export interface FlowState {
  key: string
  label: string
  color: string | null
  count: number
}

export interface Snapshot {
  flow: Array<{ collection: string; template_name: string; states: FlowState[] }>
  risk: {
    at_risk: number
    tracked: number
    open_issues: number
    /** Open records whose SLA is in warning / breached (materialized queues). */
    sla_warning?: number
    sla_breached?: number
  }
  people: {
    online_count: number
    idle_count: number
    names: string[]
    by_region: Array<{ region_id: number | string; count: number }>
    offices?: Array<{ lat: number; lng: number; label: string; count: number; names: string[] }>
    regions: Array<{
      region_id: number | string | null
      label: string
      count: number
      names: string[]
      lat?: number
      lng?: number
      /** Per person in this group (same order as names) — what they are on right now. */
      people?: PersonOn[]
    }>
  }
  throughput: { transitions_today: number; transitions_yesterday_same_time: number }
  health: SystemHealth | null
  activity: FeedEntry[]
}

export interface PersonOn {
  user_id: string
  name: string
  idle: boolean
  /** Readable label of the page they are on (never a raw path for pages the viewer can't open). */
  page_label: string | null
  record: { collection: string; id: string; label: string } | null
}

export interface SystemHealth {
  db_ok: boolean
  redis_ok: boolean
  errors_1h: number
  requests_1h: number
  jobs_running: number
  jobs_failed_1h: number
  runtime: { rss_mb: number; event_loop_lag_ms: { max_1m: number } }
  instances: number
}

// ── /config ───────────────────────────────────────────────────────────────────────────────────
export interface CcPublicConfig {
  /** Map collections the caller may read, first = default (configured or auto-detected). */
  geo_collections: Array<{ key: string; label: string }>
  /** Regions the caller may read, for the region picker; [] = this instance has no regions. */
  regions: Array<{ id: string; label: string; lat: number | null; lng: number | null }>
  region_label: string | null
  stuck_days: number
}

// ── /geo, /layers, /peek (map & place) ────────────────────────────────────────────────────────
export interface GeoPin {
  id: string
  lat: number
  lng: number
  label: string
  state: string | null
  state_key?: string | null
  state_color: string | null
  sla: 'ok' | 'warning' | 'breached' | null
  owner?: string | null
}

export interface MapLayerPoint {
  id: string
  lat: number
  lng: number
  label: string
  /** 0..1 — drives size/opacity for heat-like layers. */
  weight?: number
  href?: string | null
}

export type MapLayerKind = 'sla_heat' | 'activity' | 'out_today'

export interface PeekRecord {
  collection: string
  collection_label: string
  id: string
  title: string
  state: { key: string; label: string; color: string | null } | null
  sla: 'ok' | 'warning' | 'breached' | null
  owners: Array<{ id: string; name: string }>
  facts: Array<{ label: string; value: string }>
  /** Manual transitions the caller may run from here (pipeline outline). */
  transitions: Array<{ key: string; label: string }>
  href: string
}

// ── /flow, /attention, /workload, /forecast (work) ────────────────────────────────────────────
export interface FlowDetail {
  collection: string
  collection_label: string
  template_name: string
  states: Array<
    FlowState & {
      oldest_age_s: number | null
      median_age_s: number | null
      stuck: number
    }
  >
  open: number
  /** Open count change over 7 days (positive = growing). */
  wip_7d_delta: number | null
  completed_7d: number
  /** Days to clear today's open count at the 7-day completion pace; null = not clearing. */
  clears_in_days: number | null
  live_only?: boolean
}

export type AttentionKind =
  | 'sla_breached'
  | 'sla_warning'
  | 'stuck'
  | 'integration'
  | 'coverage_gap'
  | 'approval_blocked'
  | 'alert'

export interface AttentionAction {
  kind: 'open' | 'nudge' | 'reassign' | 'transition' | 'alert'
  label: string
  href?: string
  /** For nudge / transition: the record the action applies to. */
  target?: { collection: string; id: string; transition?: string }
}

export interface AttentionItem {
  id: string
  kind: AttentionKind
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string | null
  count: number | null
  href: string | null
  record?: { collection: string; id: string } | null
  actions: AttentionAction[]
}

export interface WorkloadRow {
  user_id: string
  name: string
  open: number
  usual: number
  status: 'over' | 'normal' | 'idle'
  out: boolean
}

export interface ForecastToday {
  arrivals_so_far: number
  arrivals_expected: number
  completions_so_far: number
  completions_expected: number
  behind: boolean
  by_hour: Array<{
    hour: number
    arrivals: number
    completions: number
    expected_arrivals: number
    expected_completions: number
  }>
}

// ── /throughput, /activity, /partners, /brief (time & system) ─────────────────────────────────
export interface ThroughputSeries {
  hours: Array<{ hour: number; today: number | null; yesterday: number; avg7: number }>
  markers: Array<{
    at: string
    kind: 'deploy' | 'config' | 'incident'
    label: string
    href?: string | null
  }>
  live_only?: boolean
}

export interface FeedEntry {
  id: number
  action: string
  collection: string | null
  item: string | null
  comment: string | null
  timestamp: string
  user_name: string | null
  /** Readable one-line sentence (shared activity-sentence twin), when the server built one. */
  sentence?: string | null
  lat?: number | null
  lng?: number | null
}

export interface PartnerHealth {
  key: string
  label: string
  status: 'ok' | 'degraded' | 'down' | 'unknown'
  open_problems: number
  last_ok_at: string | null
  href: string | null
}

export interface BoardBrief {
  text: string
  generated_at: string
}

// ── /prefs, /role-defaults, /kiosk-links (shell) ──────────────────────────────────────────────
export interface CcLayout {
  order: string[]
  hidden: string[]
}

export interface CcSavedView {
  id: string
  name: string
  region: string | null
  map_collection: string | null
  filters: CcFilters
}

export interface CcPrefs {
  layout: CcLayout | null
  /** 'app' = follow the app theme; 'dark' = always dark (wall screens). */
  theme: 'app' | 'dark'
  saved_views: CcSavedView[]
  role_default?: CcLayout | null
}

export interface CcFilters {
  states: string[]
  sla: Array<'ok' | 'warning' | 'breached'>
  owner: string | null
}

export interface KioskLink {
  id: string
  label: string
  url: string
  created_at: string
  expires_at: string | null
  created_by_name: string | null
}

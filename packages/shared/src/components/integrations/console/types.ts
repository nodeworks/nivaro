/**
 * HTTP shapes served by GET /integration-signals and /integration-partners —
 * copied from the core routes so the shared package never imports api code.
 */

export interface SignalAction {
  kind: 'retry_submission' | 'resend' | 'open' | 'explain' | 'extension'
  label: string
  /** Extension action id (kind 'extension'), submission id (retry). */
  id?: string
  payload?: Record<string, unknown>
}

export interface RowSnooze {
  id: number
  until: string | null
  until_change: boolean
  /** true = this snooze is a Dismiss — "seen this one, tell me when it
   *  happens again" — never a group/signal scope, always row-only. */
  until_occurrence: boolean
  note: string | null
}

export interface RowView {
  key: string
  group?: string
  group_label?: string
  title: string
  detail?: string
  since?: string
  /** Identity of THIS occurrence (a run id, a submission attempt...) — what
   *  Dismiss keys on, distinct from `key` (the problem itself). */
  occurrence?: string
  api?: string
  record?: { collection: string; id: string; label?: string }
  actions: SignalAction[]
  /** When the snapshot first saw this problem. */
  first_seen: string
  /** Present only on rows in `snoozed`. */
  snooze?: RowSnooze
}

export interface SignalThreshold {
  key: string
  label: string
  default: number
  unit: string
  min?: number
  max?: number
}

export interface SignalView {
  id: string
  label: string
  description: string
  tab: string
  severity: 'critical' | 'warn'
  count: number
  error: string | null
  last_run: string | null
  thresholds: SignalThreshold[]
  settings: {
    enabled: boolean
    severity: 'critical' | 'warn'
    thresholds: Record<string, number>
  }
  rows: RowView[]
  snoozed: RowView[]
  /** Rows actually returned (the evaluator may count more than it lists). */
  shown: number
}

export interface SignalsSnapshot {
  checked_at: string | null
  stale: boolean
  signals: SignalView[]
}

export type PartnerHealth = 'healthy' | 'degraded' | 'failing' | 'idle'

export interface PartnerCard {
  id: number
  name: string
  enabled: boolean
  health: PartnerHealth
  calls24: number
  success_pct24: number | null
  success_pct7d: number | null
  p50_ms: number | null
  p95_ms: number | null
  last_ok_at: string | null
  last_fail_at: string | null
  last_fail_reason: string | null
  hourly: Array<{ hour: string; ok: number; failed: number }>
  flags: { test_endpoint: boolean; mock: boolean; auth_failing: boolean }
  owner: { id: string; name: string } | null
  obligations: { sent: number; pending: number; failed: number; missing: number; overdue: number }
}

export interface PartnersSummary {
  calls24: number
  success_pct24: number | null
  not_healthy: number
}

export interface PartnerCall {
  id: number
  created_at: string
  method: string | null
  path: string | null
  status: number | null
  ok: boolean | number
  duration_ms: number | null
  error: string | null
}

export interface PartnerContract {
  endpoint_id: number
  name: string
  last_run: string | null
  ok: boolean | number | null
  detail: string | null
}

export interface PartnerDetailData {
  card: PartnerCard
  calls: PartnerCall[]
  contracts: PartnerContract[]
}

export type { ImportHealthRow } from '../../imports/ImportStalenessControl'

/** GET /integration-events — a notes source that can list or replay (#20). */
export interface EventProvider {
  id: string
  collection: string
  label: string
  can_list: boolean
  can_replay: boolean
}

export type EventStatus = 'ok' | 'error' | 'info'

/** One entry of the cross-record integration events feed. */
export interface IntegrationEvent {
  id: string | number
  label: string
  text: string
  user?: string | null
  created_at: string
  context?: string | null
  collection: string
  item_id: string
  item_label?: string | null
  provider: string
  replayable?: boolean
  status?: EventStatus | null
}

export type ActionResult = { key: string; ok: boolean; message: string }

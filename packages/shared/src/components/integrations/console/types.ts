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
  /** What opens in place under this row — the failed push, the import run. */
  drill?: SignalDrill
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

/** One user recorded on a call — via nivaro_users, batch-resolved server-side. */
export interface PartnerCallUser {
  id: string
  name: string
  email: string | null
}

/**
 * One row of Partner detail's Recent calls list (GET /integration-partners/:id).
 * `source: 'log'` carries a real body to open (GET .../calls/:callId);
 * `'outbound'` is the always-on counter row for a call that never landed one
 * (before Task 15's extension-call fix, or any caller still passing no
 * `_log`) — it opens to "nothing recorded", never a fetch.
 */
export interface PartnerCall {
  key: string
  id: number
  source: 'log' | 'outbound'
  created_at: string
  method: string | null
  path: string | null
  status: number | null
  ok: boolean | number
  duration_ms: number | null
  error: string | null
  triggered_by: string | null
  has_body: boolean
  user: PartnerCallUser | null
}

/** GET /integration-partners/:id/calls/:callId — one call's full request and
 *  response. Headers are re-masked on the way out regardless of what the row
 *  stores. */
export interface PartnerCallDetail {
  id: number
  created_at: string
  method: string | null
  url: string | null
  request_headers: Record<string, string> | null
  request_body: string | null
  response_status: number | null
  response_headers: Record<string, string> | null
  response_body: string | null
  duration_ms: number | null
  error: string | null
  triggered_by: string | null
  user: PartnerCallUser | null
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

/** A typed "Details" reference on a signal row (GET /integration-signals). */
export interface SignalDrill {
  kind: 'submission' | 'import_run' | (string & {})
  id: string
}

/** A user named on a push — a person, or a machine account (`account_kind`). */
export interface DrillUser {
  id: string
  name: string
  email: string | null
  /** 'suspended' / 'inactive' / 'redacted' / 'deleted' — can no longer act. */
  inactive: string | null
  account_kind: string | null
}

/** Who started a push (or one attempt of it) — GET /erp-submissions/:id. */
export interface Requester {
  kind: 'person' | 'machine' | 'automatic' | 'scheduled' | 'flow' | 'unknown'
  basis: 'recorded' | 'inferred' | 'none'
  label: string
  user: DrillUser | null
  via: string | null
  how: string | null
}

export interface SubmissionDetail {
  submission: {
    id: number
    collection: string
    item: string
    external_api: number | null
    external_api_name: string | null
    external_ref: string | null
    status: string
    attempts: number
    last_error: string | null
    endpoint_path: string | null
    payload: unknown
    response: unknown
    created_at: string
    updated_at: string
    record_label: string
    error_class: string | null
    requested_by: string | null
    requested_via: string | null
  }
  partner: { id: number | null; name: string | null; owner: { id: string; name: string } | null }
  endpoint: { method: string; path: string | null }
  obligation: {
    id: number
    kind: string
    outcome: string
    reason: string | null
    due_at: string | null
    resolved_at: string | null
    trigger: string
    trigger_ref: string | null
    open: boolean
  } | null
  trigger: { kind: string; label: string; link: string | null; source: string }
  triggered_by: Requester
  attempt_requesters: Array<{ attempt: number; requester: Requester }>
  call_logs: Array<{
    id: number
    created_at: string
    method: string | null
    url: string | null
    status: number | null
    duration_ms: number | null
    error: string | null
    triggered_by: string | null
    user: DrillUser | null
  }>
  retry: { eligible: boolean; reason: string | null; warning: string | null }
}

/** One attempt of a submission — GET /erp-submissions/:id/attempts. */
export interface SubmissionAttempt {
  attempt: number
  status: string
  http_status: number | null
  error: string | null
  source: string
  at: string
  endpoint_path: string | null
  payload: unknown
  response: unknown
}

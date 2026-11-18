/**
 * Delivery analytics — the shapes GET /api/delivery-analytics/* answers
 * (api/src/services/delivery-analytics/summary.ts). Every number is a Cell:
 * `n` is the figure and `s` + `w` name exactly the rows behind it.
 */

export type DaSource = 'n' | 'm' | 'x'
export type DaCond = [dim: string, values: string[]]

export interface DaCell {
  n: number
  s: DaSource
  w: DaCond[]
  win?: 'prev'
}

export type DaChannel = 'inapp' | 'push' | 'email' | 'sms' | 'teams'
export type DaOutcome =
  | 'delivered'
  | 'deferred'
  | 'skipped'
  | 'failed'
  | 'dropped'
  | 'not_requested'
  | 'not_recorded'
  | 'other'
export type DaMailOutcome =
  | 'delivered'
  | 'deferred'
  | 'skipped'
  | 'suppressed'
  | 'test'
  | 'dropped'
  | 'failed'
  | 'other'

export interface DaBreakdownRow {
  key: string
  label: string
  sent: DaCell
  read: DaCell
  unread: DaCell
  timed: DaCell
  acted: DaCell
  eligible: DaCell
  read_ignored: DaCell
  p50: number | null
  p90: number | null
}

export interface DaBreakdown {
  by: string
  label: string
  rows: DaBreakdownRow[]
  more: boolean
}

export interface DaRelay {
  status: 'ok' | 'failing' | 'quiet'
  attempted: number
  failed: number
  error: string | null
  since: string | null
  last_attempt_at: string | null
}

export interface DaPerson {
  id: string
  name: string
  sent: DaCell
  unread: DaCell
}

export interface DaSummary {
  window: {
    from: string
    to: string
    prev_from: string
    prev_to: string
    bucket: 'day' | 'hour'
    preset: string
  }
  asof: string
  acted_hours: number
  filters: Record<string, string | undefined>
  ignored_filters: { m: string[]; x: string[] }
  features: { resend: boolean; mutes: boolean }
  headline: {
    sent: DaCell
    sent_prev: DaCell
    read: DaCell
    read_prev: DaCell
    unread: DaCell
    timed: DaCell
    timed_prev: DaCell
    ttr: { p50: number | null; p90: number | null }
    ttr_prev: { p50: number | null; p90: number | null }
    acted: DaCell
    acted_prev: DaCell
    eligible: DaCell
    eligible_prev: DaCell
    read_ignored: DaCell
    email_total: DaCell
    email_total_prev: DaCell
    email_delivered: DaCell
    email_delivered_prev: DaCell
    email_failed: DaCell
    email_failed_prev: DaCell
  }
  series: Array<{
    bucket: string
    sent: DaCell
    read: DaCell
    email_delivered: DaCell
    email_failed: DaCell
  }>
  channels: Array<{
    channel: DaChannel
    label: string
    attempted: DaCell
    outcomes: Record<DaOutcome, DaCell>
    statuses: Array<{
      status: string
      label: string
      outcome: DaOutcome
      known: boolean
      cell: DaCell
    }>
  }>
  email: {
    total: DaCell
    outcomes: Array<{ key: DaMailOutcome; label: string; cell: DaCell }>
    reasons: Array<{
      key: string
      label: string
      hint: string
      outcome: DaMailOutcome
      cell: DaCell
    }>
    templates: Array<{
      key: string
      label: string
      total: DaCell
      outcomes: Record<DaMailOutcome, DaCell>
    }>
    resends: DaCell | null
    relay: DaRelay | null
    ignored_filters: string[]
  }
  breakdown: DaBreakdown
  people: {
    unread: DaPerson[]
    never_read: DaPerson[]
    never_read_count: number
    floods: Array<{ id: string; name: string; hour: string; cell: DaCell }>
    flood_per_hour: number
  }
  health: Array<{ id: string; tone: 'bad' | 'warn'; title: string; detail: string; cell?: DaCell }>
  mutes: {
    total: DaCell
    by_collection: Array<{ key: string; mutes: DaCell; sent: DaCell }>
  } | null
  options: {
    categories: Array<{ value: string; label: string }>
    collections: Array<{ value: string; label: string; count: number }>
    senders: Array<{ value: string; label: string; count: number }>
  }
}

export interface DaChannelChip {
  channel: DaChannel
  status: string
  label: string
  outcome: DaOutcome
}

export interface DaNotificationRow {
  id: number
  timestamp: string
  recipient: string | null
  recipient_name: string | null
  sender: string | null
  sender_name: string | null
  subject: string | null
  category: string | null
  lane: string | null
  kind: string | null
  collection: string | null
  item: string | null
  status: string | null
  read_at: string | null
  ttr_min: number | null
  reason: string
  reason_label: string
  channels: DaChannelChip[]
}

export interface DaMailRow {
  id: number
  created_at: string
  to: string | null
  subject: string | null
  template: string | null
  status: string | null
  error: string | null
  collection: string | null
  item: string | null
  reason: string
  reason_label: string
  outcome: DaMailOutcome
  outcome_label: string
}

export interface DaMuteRow {
  id: number
  user: string | null
  user_name: string | null
  collection: string | null
  item: string | null
  created_at: string
}

export interface DaRowsPage {
  source: DaSource
  total: number
  rows: Array<DaNotificationRow | DaMailRow | DaMuteRow>
  next_cursor: string | null
}

export interface DaSplit {
  by: string
  label: string
  more: boolean
  rows: Array<{ key: string; label: string; cell: DaCell }>
}

export interface DaPersonRef {
  id: string
  name: string
  email: string | null
  status: string | null
  role: string | null
  account_kind: string | null
}

export interface DaNotificationLeaf {
  id: number
  timestamp: string
  subject: string | null
  message: string | null
  message_hidden: boolean
  category: string | null
  lane: string | null
  kind: string | null
  status: string | null
  read_at: string | null
  snoozed_until: string | null
  collection: string | null
  item: string | null
  recipient: DaPersonRef | null
  sender: DaPersonRef | null
  reason: {
    kind: string
    kind_label: string
    text: string
    label: string | null
    critical: boolean
    role: string | null
    rules: Array<{ code: string; channel: string; text: string; layer: string }>
  } | null
  channels: Array<{
    channel: DaChannel
    status: string | null
    label: string
    outcome: DaOutcome
    reason: string | null
    at: string | null
  }>
  escalation: Record<string, unknown> | null
  mail: {
    id: number
    to: string | null
    status: string | null
    created_at: string
    template: string | null
    reason: string
    reason_label: string
    hint: string | null
    error: string | null
  } | null
  read_state: 'read' | 'unread'
  asof: string
  acted: {
    hours: number
    eligible: boolean
    verdict: string
    actions: Array<{ kind: 'transition' | 'comment' | 'task'; at: string }>
    window_ends: string
  }
}

export interface DaMailLeaf {
  id: number
  created_at: string
  to: string | null
  subject: string | null
  template: string | null
  status: string | null
  error: string | null
  body: string | null
  /** The body quotes a private chat: shown only on the logged compliance view. */
  body_withheld: boolean
  private_chat: boolean
  collection: string | null
  item: string | null
  reason: string
  reason_label: string
  hint: string | null
  outcome: DaMailOutcome
  outcome_label: string
  recipients: Array<{ id: string; name: string; email: string }>
  resend_of: number | null
  resent_by: string | null
}

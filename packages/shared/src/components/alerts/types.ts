export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'change_pct'
export type AlertUnit = 'percent' | 'dollar' | 'count' | 'days'
export type CheckFrequency = 'hourly' | 'daily' | 'weekly'
export type DigestFrequency = 'immediate' | 'daily' | 'weekly'

export interface FilterOptionSpec {
  key: string
  label?: string
  collection?: string
  value_field?: string
  label_field?: string
  sort?: string
}

export interface MetricDefinition {
  id: number
  name: string
  description: string | null
  metric_key: string
  category: string
  unit: AlertUnit | string
  default_operator: AlertOperator | string
  default_threshold: number | null
  supported_filters: FilterOptionSpec[] | null
  status: string
  sort: number | null
}

export interface MetricAlertRule {
  id: number
  name: string
  definition_id: number
  operator: string
  threshold_value: number
  filters: Record<string, Array<string | number>> | null
  check_frequency: CheckFrequency | string
  is_shared: boolean
  status: string
  created_by: string | null
  created_at: string | null
  definition?: {
    id: number
    name: string
    description: string | null
    category: string
    unit: string
  }
}

export interface MetricAlertSubscription {
  id: number
  rule_id: number
  user: string
  delivery_in_app: boolean
  delivery_email: boolean
  digest_frequency: DigestFrequency | string
  last_notified: string | null
  status: string
  rule_name?: string
  rule_operator?: string
  rule_threshold?: number
  rule_status?: string
  definition_name?: string
  definition_unit?: string
}

export interface MetricAlertLogEntry {
  id: number
  rule_id: number
  fired_at: string
  resolved_at: string | null
  metric_value: number
  threshold_value: number
  status: 'firing' | 'resolved' | string
  rule_name?: string
  rule_operator?: string
  definition_name?: string
  definition_unit?: string
}

export interface AnomalyDefinition {
  id: number
  key: string
  name: string
  description: string | null
  category: string
  status: string
  scope_options: FilterOptionSpec[] | null
  sensitivity_hints: Record<string, string> | null
}

export interface AnomalyRule {
  id: number
  name: string
  definition_id: number
  sensitivity: 'low' | 'medium' | 'high' | string
  scopes: Record<string, Array<string | number>> | null
  check_frequency: 'daily' | 'weekly' | string
  delivery_in_app: boolean
  delivery_email: boolean
  status: string
  created_by: string | null
  definition?: { id: number; key: string; name: string; description: string | null }
}

export interface AnomalyLogEntry {
  id: number
  rule_id: number
  detected_at: string
  resolved_at: string | null
  subject_type: string
  subject_id: string
  stats_snapshot: Record<string, unknown> | null
  ai_explanation: string | null
  status: 'new' | 'acknowledged' | 'resolved' | string
  rule_name?: string
}

export interface ReportAlertRow {
  id: string
  report: string
  report_name: string | null
  widget: string
  name: string
  conditions: Array<{ field: string; op: string; value: number }> | null
  filters: Array<{ field: string; values: Array<string | number>; labels?: string[] }> | null
  delivery_email: boolean
  delivery_inapp: boolean
  is_active: boolean
  firing: boolean
  last_fired: string | null
}

export interface ReportAlertLogRow {
  id: number
  alert: string
  alert_name: string
  report_id: string
  report_name: string | null
  status: 'firing' | 'resolved' | string
  metric_snapshot: Record<string, unknown> | null
  fired_at: string
  resolved_at: string | null
}

export const OPERATOR_LABELS: Record<string, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  change_pct: '% Δ'
}

export const OPERATOR_OPTIONS = [
  { label: 'greater than (>)', value: 'gt' },
  { label: 'at least (≥)', value: 'gte' },
  { label: 'less than (<)', value: 'lt' },
  { label: 'at most (≤)', value: 'lte' },
  { label: 'equals (=)', value: 'eq' },
  { label: '% change', value: 'change_pct' }
]

export function fmtMetric(value: number | string | null | undefined, unit?: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value ?? '—')
  const num = Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (unit === 'dollar') return `$${num}`
  if (unit === 'percent') return `${num}%`
  if (unit === 'days') return `${num}d`
  return num
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

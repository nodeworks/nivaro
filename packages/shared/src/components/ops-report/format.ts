import type {
  OpsDelta,
  OpsDrillMetric,
  OpsKpiMeta,
  OpsReport,
  OpsRunStatus,
  OpsVerdict
} from '../../lib/ops-report-types'
import { OPS_KPI_META } from '../../lib/ops-report-types'

export type { OpsReportSettings } from '../../lib/ops-report-types'

export type OpsTab = 'report' | 'trends' | 'compare'
export const OPS_TABS: Array<{ key: OpsTab; label: string }> = [
  { key: 'report', label: 'Report' },
  { key: 'trends', label: 'Trends' },
  { key: 'compare', label: 'Compare' }
]

/** Missing arrays in an older report read as empty. */
export function arr<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : []
}

export function num(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(v)) return '–'
  return v.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function ms(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '–'
  if (v >= 10_000) return `${(v / 1000).toFixed(0)} s`
  if (v >= 1000) return `${(v / 1000).toFixed(1)} s`
  return `${Math.round(v)} ms`
}

export function formatKpi(v: number | null | undefined, unit?: OpsKpiMeta['unit']): string {
  if (v == null || Number.isNaN(v)) return '–'
  if (unit === 'ms') return ms(v)
  if (unit === 'usd') return `$${Math.round(v).toLocaleString('en-US')}`
  if (unit === 'pct') return `${num(v, 1)}%`
  return num(v, Number.isInteger(v) ? 0 : 1)
}

export function kpiLabel(key: string, meta?: OpsKpiMeta[]): string {
  const m = meta?.find((k) => k.key === key) ?? OPS_KPI_META.find((k) => k.key === key)
  if (m) return m.label
  const last = key.split('.').pop() ?? key
  const words = last.replace(/_/g, ' ')
  return words[0].toUpperCase() + words.slice(1)
}

export function kpiMeta(key: string, meta?: OpsKpiMeta[]): OpsKpiMeta {
  return (
    meta?.find((k) => k.key === key) ??
    OPS_KPI_META.find((k) => k.key === key) ?? {
      key,
      label: kpiLabel(key),
      unit: key.endsWith('_usd') ? 'usd' : key.endsWith('_ms') ? 'ms' : 'count',
      better: null,
      group: 'business'
    }
  )
}

/** good = moved the good way; null = neutral. Never colours by raw up/down. */
export function goodClass(good: boolean | null | undefined): string {
  if (good === true) return 'text-emerald-700 dark:text-emerald-400'
  if (good === false) return 'text-red-600 dark:text-red-400'
  return 'text-slate-500 dark:text-muted-foreground'
}

export function changeText(d: Pick<OpsDelta, 'change_pct' | 'today' | 'prev'>): string {
  if (d.prev == null) return 'no earlier day'
  if (d.today === d.prev) return 'no change'
  if (d.change_pct == null) return d.today > d.prev ? 'up from 0' : 'down'
  const p = d.change_pct
  const mag = Math.abs(p) >= 10 ? Math.round(Math.abs(p)) : Math.abs(p).toFixed(1)
  return `${p > 0 ? '+' : '−'}${mag}%`
}

export const VERDICT: Record<OpsVerdict, { label: string; dot: string; badge: string }> = {
  healthy: {
    label: 'Healthy',
    dot: 'bg-emerald-500',
    badge:
      'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
  },
  watch: {
    label: 'Watch',
    dot: 'bg-amber-500',
    badge:
      'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
  },
  bad: {
    label: 'Bad day',
    dot: 'bg-red-500',
    badge:
      'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
  }
}

export const NO_VERDICT_DOT = 'bg-slate-300 dark:bg-slate-600'

export function statusLabel(s: OpsRunStatus): string {
  return s === 'running'
    ? 'Building'
    : s === 'failed'
      ? 'Failed'
      : s === 'digest_only'
        ? 'Numbers only'
        : 'Ready'
}

function parts(day: string): Date | null {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/** Short day for lists and strips ("Nov 9"). */
export function shortDay(day: string): string {
  const d = parts(day)
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : day
}

export function weekday(day: string): string {
  const d = parts(day)
  return d ? d.toLocaleDateString('en-US', { weekday: 'short' }) : ''
}

export function cost(v: number | null | undefined): string {
  return v == null ? '–' : `$${v.toFixed(v < 1 ? 3 : 2)}`
}

export function reportTokens(r: Pick<OpsReport, 'tokens_in' | 'tokens_out'>): number | null {
  return r.tokens_in == null && r.tokens_out == null
    ? null
    : (r.tokens_in ?? 0) + (r.tokens_out ?? 0)
}

/** Keys worth a tile in the strip, in reading order. */
export const STRIP_KEYS = [
  'requests',
  'p95_ms',
  'server_errors',
  'deploys',
  'deadlocks',
  'integration_failures',
  'job_failures',
  'backlog_waiting',
  'open_bugs'
]

/** Which drill metric (and key) opens behind each KPI key. */
const KPI_DRILL: Record<string, OpsDrillMetric | [OpsDrillMetric, string]> = {
  active_people: 'active_people',
  signed_in_today: 'signed_in_today',
  sign_ins: 'signed_in_today',
  carried_sessions: 'carried_sessions',
  new_accounts: 'new_accounts',
  view_as_sessions: 'view_as_sessions',
  trouble_people: 'trouble_people',
  requests: 'requests',
  page_views: 'page_views',
  pages_viewed: 'page_views',
  avg_ms: 'latency',
  p95_ms: 'latency',
  p99_ms: 'latency',
  over5s: 'over5s',
  server_errors: 'server_errors',
  client_errors: 'client_errors',
  deadlocks: 'deadlocks',
  deploys: 'deploys',
  job_failures: 'job_failures',
  integration_failures: 'integration_failures',
  integration_calls_failed: 'integration_calls',
  open_alarms: 'open_alarms',
  mail_sent: ['mail', 'sent'],
  mail_failed: ['mail', 'failed'],
  mail_deferred: ['mail', 'deferred'],
  moves: 'moves',
  creates: 'creates',
  searches: 'searches',
  search_zero: 'search_zero',
  backlog_waiting: 'backlog',
  new_places: 'new_places',
  failed_sign_ins: 'failed_sign_ins',
  open_bugs: ['bugs', 'open'],
  browser_errors: 'browser_errors',
  support_opened: 'support',
  support_open: ['support', 'open'],
  ai_calls: 'ai_calls',
  ai_cost_usd: 'ai_calls',
  data_violations: 'data_quality',
  health_score: 'score'
}

export interface DrillRef {
  metric: OpsDrillMetric
  key?: string | null
  label?: string
}

export function drillForKpi(key: string): DrillRef | null {
  const m = KPI_DRILL[key]
  if (Array.isArray(m)) return { metric: m[0], key: m[1], label: kpiLabel(key) }
  if (m) return { metric: m, label: kpiLabel(key) }
  // Extension numbers are `<section>.<row key>`.
  if (key.includes('.')) return { metric: 'section', key, label: kpiLabel(key) }
  return null
}

export const dr = (
  metric: OpsDrillMetric,
  key?: string | number | null,
  label?: string
): DrillRef => ({
  metric,
  key: key == null ? null : String(key),
  label
})

import type { DataTag } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Hub fleet (Apps → Fleet, Apps → Audit): types, query keys and fetchers for /api/hub/fleet/* and
 * /api/hub/audit. The fleet answer is built from the Hub's own tables (the probe job keeps them),
 * so reading it never makes the Hub call an app.
 */

export interface FleetAlertChip {
  id: number
  rule_id: string
  kind: string
  message: string
  opened_at: string | null
}

export interface FleetRow {
  app_id: number
  app_key: string
  app_name: string
  environment_id: number
  env_key: string
  env_status: string
  position: number
  base_url: string
  placement: 'dedicated' | 'shared' | 'none'
  shared_key: string | null
  version: string | null
  version_since: string | null
  behind: number | null
  state: 'ok' | 'degraded' | 'unreachable' | 'link_refused' | null
  preflight: string | null
  readiness_score: number | null
  open_issues: number | null
  failing: string[]
  error: string | null
  checked_at: string | null
  up: boolean | null
  probed_at: string | null
  uptime_24h: number | null
  uptime_30d: number | null
  slo: {
    month: string
    target: number
    uptime: number | null
    met: boolean | null
    left_samples: number
  }
  last_deploy: {
    id: number
    kind: string
    version: string
    status: string
    at: string | null
    by: string | null
    by_name: string | null
  } | null
  deployed_at: string | null
  alerts: FleetAlertChip[]
}

export interface FleetAnswer {
  newest: string | null
  hub_version: string
  generated_at: string
  rows: FleetRow[]
  unprobed: number
}

export type FleetRuleKind = 'behind_newest' | 'pair_apart' | 'stale_deploy'

export interface FleetRule {
  id: string
  kind: FleetRuleKind
  enabled: boolean
  n: number
  env_keys: string[]
  from_key: string | null
  to_key: string | null
}

export interface FleetSettings {
  rules: FleetRule[]
  slo: { default_target: number; targets: Record<string, number> }
  report_enabled: boolean
}

export interface UptimeAnswer {
  environment_id: number
  days: number
  hours: Array<{ at: string; samples: number; up: number; ms: number | null }>
  incidents: Array<{ at: string; up: boolean; ms: number | null; code: string | null }>
  reports: Array<{
    month: string
    uptime: number | null
    target: number
    met: boolean | null
    samples: number
  }>
}

export type AuditCategory =
  | 'promote'
  | 'rollback'
  | 'move'
  | 'stack'
  | 'keys'
  | 'upgrade'
  | 'creation'
  | 'signin'
  | 'database'
  | 'config'

export interface AuditRow {
  id: string
  at: string | null
  action: string
  category: AuditCategory
  label: string
  app_id: number | null
  app_key: string | null
  environment_id: number | null
  env_key: string | null
  user_id: string | null
  user_name: string | null
  result: string | null
  note: string | null
  detail: string | null
}

export interface AuditAnswer {
  data: AuditRow[]
  meta: {
    total: number
    offset: number
    limit: number
    truncated: boolean
    people: Array<{ id: string; name: string }>
  }
}

export interface AuditQuery {
  app?: string
  environment?: string
  user?: string
  action?: string
  from?: string
  to?: string
  offset?: number
  limit?: number
}

export const CATEGORY_LABEL: Record<AuditCategory, string> = {
  promote: 'Promotions',
  rollback: 'Rollbacks',
  move: 'Moves',
  stack: 'Stack changes',
  keys: 'Keys and tokens',
  upgrade: 'Shared upgrades',
  creation: 'App creation',
  signin: 'Sign-in clients',
  database: 'Databases',
  config: 'Other settings'
}

export const RULE_KIND_LABEL: Record<FleetRuleKind, string> = {
  behind_newest: 'Releases behind the newest',
  pair_apart: 'Two environments apart',
  stale_deploy: 'Not deployed for days'
}

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export const fleetKeys: {
  fleet: () => Tagged<readonly ['hub-fleet'], FleetAnswer>
  settings: () => Tagged<readonly ['hub-fleet-settings'], FleetSettings>
  uptime: (
    envId: number,
    days: number
  ) => Tagged<readonly ['hub-fleet-uptime', number, number], UptimeAnswer>
  audit: (q: AuditQuery) => Tagged<readonly ['hub-audit', AuditQuery], AuditAnswer>
} = {
  fleet: () => tag<FleetAnswer, readonly ['hub-fleet']>(['hub-fleet'] as const),
  settings: () =>
    tag<FleetSettings, readonly ['hub-fleet-settings']>(['hub-fleet-settings'] as const),
  uptime: (envId, days) =>
    tag<UptimeAnswer, readonly ['hub-fleet-uptime', number, number]>([
      'hub-fleet-uptime',
      envId,
      days
    ] as const),
  audit: (q) => tag<AuditAnswer, readonly ['hub-audit', AuditQuery]>(['hub-audit', q] as const)
}

export const fetchFleet = () =>
  api.get<{ data: FleetAnswer }>('/hub/fleet').then((r) => r.data.data)

export const fetchFleetSettings = () =>
  api.get<{ data: FleetSettings }>('/hub/fleet/settings').then((r) => r.data.data)

export const saveFleetSettings = (s: FleetSettings) =>
  api.put<{ data: FleetSettings }>('/hub/fleet/settings', s).then((r) => r.data.data)

export const checkFleetNow = () =>
  api
    .post<{ data: { probe: { probed: number; down: number }; alerts: { opened: number } } }>(
      '/hub/fleet/check'
    )
    .then((r) => r.data.data)

export const fetchUptime = (envId: number, days: number) =>
  api
    .get<{ data: UptimeAnswer }>(`/hub/fleet/environments/${envId}/uptime`, { params: { days } })
    .then((r) => r.data.data)

function auditParams(q: AuditQuery): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') out[k] = v
  return out
}

export const fetchAudit = (q: AuditQuery) =>
  api.get<AuditAnswer>('/hub/audit', { params: auditParams(q) }).then((r) => r.data)

/** Downloads the audit CSV for the same filters (no paging). */
export async function downloadAuditCsv(q: AuditQuery): Promise<void> {
  const { offset: _o, limit: _l, ...rest } = q
  const res = await api.get<Blob>('/hub/audit.csv', {
    params: auditParams(rest),
    responseType: 'blob'
  })
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = 'hub-audit.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 99.987 → "99.987 %", null → "—". */
export function pct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${Number(v.toFixed(3))} %`
}

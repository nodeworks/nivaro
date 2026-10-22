import { COLOR_ROLES } from '@nivaro/shared'
import { useLayoutEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { ChaosRun, HypothesisRule, RunStatus, Verdict } from './api'

/**
 * Client for the chaos results (#2849 run report, #2830 claims, #2850 matrix, #2859 trends):
 * types mirroring api/src/services/chaos/{report,claims,matrix,trends}.ts and the fetchers.
 * Query keys stay under `['chaos', …]` so the console's socket invalidation refreshes them.
 */

export type Phase = 'before' | 'during' | 'after'

export interface SamplerSeries {
  key: string
  rule: HypothesisRule | null
  band: { lo: number; hi: number; mean: number | null } | null
  points: Array<{ t: number; v: number | null; phase: Phase }>
  breached: boolean
}

export type MarkerKind =
  | 'armed'
  | 'disarmed'
  | 'stop'
  | 'abort'
  | 'alert'
  | 'note'
  | 'declared'
  | 'readiness'
  | 'step'

export interface RunReport {
  run_id: string
  status: RunStatus
  verdict: Verdict | null
  broke_by: {
    sampler: string
    value: number | null
    op: string | null
    limit: number | null
  } | null
  armed_at: string | null
  disarmed_at: string | null
  series: SamplerSeries[]
  markers: Array<{ t: number; kind: MarkerKind; label: string }>
  alerts: Array<{
    at: string
    label: string
    source: string | null
    severity: string | null
    after_s: number | null
  }>
  notes: Array<{
    at: string
    actor: string | null
    mark: string | null
    text: string
    after_s: number | null
  }>
  readiness: Array<{ at: string; status: string; score: number | null; failing: string[] }>
  ttd_s: number | null
  ttd_source: 'alert' | 'noticed' | 'declared' | 'recorded' | null
  ttf_s: number | null
  ttr_s: number | null
  ttr_state: 'recovered' | 'not_recovered' | 'no_data'
}

export interface ErrorsSeen {
  server: Array<{ route: string; count: number }>
  server_total: number
  people: number
  client_errors: number
  rage_clicks: number
  dead_clicks: number
  available: boolean
}

export interface FullReport {
  run: ChaosRun
  report: RunReport
  errors: ErrorsSeen | null
  names: Record<string, string>
  link: string | null
}

export type ClaimStatus = 'proven' | 'broke' | 'stale' | 'never'

export interface ClaimView {
  key: string
  statement: string
  area: string
  proving: string[]
  faults: string[]
  provable: boolean
  max_age_days: number
  source?: string
  status: ClaimStatus
  last_run: {
    id: string
    fault_key: string | null
    kind: ChaosRun['kind']
    verdict: Verdict | null
    at: string
    age_days: number
  } | null
}

export type MatrixKind = 'down' | 'slow' | 'errors' | 'partitioned'

export interface MatrixCell {
  dependency: string
  kind: MatrixKind
  last: {
    run_id: string
    fault_key: string | null
    verdict: Verdict | null
    at: string
    age_days: number
  } | null
  runs: number
  rerun: { fault_key: string; params: Record<string, number | string | boolean> } | null
}

export interface Matrix {
  refusal: string | null
  kinds: MatrixKind[]
  rows: Array<{ id: string; label: string; partner?: string }>
  cells: MatrixCell[]
}

export interface PeriodTrend {
  period: string
  runs: number
  held: number
  broke: number
  aborted: number
  ttd_median_s: number | null
  ttd_n: number
  ttr_median_s: number | null
  ttr_n: number
}

export interface Trends {
  months: PeriodTrend[]
  quarters: PeriodTrend[]
  days: Array<{ date: string; runs: number; broke: number }>
  dependencies: Array<{
    dependency: string
    label: string
    months: Array<{ period: string; held: number; broke: number; aborted: number }>
  }>
  never_proven: Array<{ key: string; statement: string; area: string; provable: boolean }>
  recovery: {
    window_days: number
    ttr_median_s: number | null
    ttr_p90_s: number | null
    ttd_median_s: number | null
    not_recovered: number
    runs: number
  }
  pending: number
}

export const reportKeys = {
  report: (id: string) => ['chaos', 'report', id] as const,
  claims: ['chaos', 'claims'] as const,
  matrix: ['chaos', 'matrix'] as const,
  trends: (months: number) => ['chaos', 'trends', months] as const
}

export const fetchReport = (id: string) =>
  api.get(`/chaos/runs/${id}/report`).then((r) => r.data.data as FullReport)
export const fetchClaims = () =>
  api
    .get('/chaos/claims')
    .then((r) => r.data.data as { refusal: string | null; claims: ClaimView[] })
export const fetchMatrix = () => api.get('/chaos/matrix').then((r) => r.data.data as Matrix)
export const fetchTrends = (months: number) =>
  api.get('/chaos/trends', { params: { months } }).then((r) => r.data.data as Trends)

/** Download the postmortem Markdown through the signed-in client. */
export async function downloadPostmortem(id: string): Promise<void> {
  const res = await api.get(`/chaos/runs/${id}/postmortem`, { responseType: 'blob' })
  const cd = String(res.headers['content-disposition'] ?? '')
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? `chaos-${id}.md`
  const url = URL.createObjectURL(res.data as Blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 42s · 3m 05s · 2h 10m */
export function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return '—'
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`
}

export function fmtAge(days: number): string {
  if (days < 1) return 'today'
  if (days < 2) return '1 day ago'
  if (days < 60) return `${Math.round(days)} days ago`
  return `${Math.round(days / 30)} months ago`
}

export const VERDICT_WORD: Record<Verdict, string> = {
  held: 'Held',
  broke: 'Broke',
  aborted: 'Aborted'
}

/** Chart colours resolved for the current theme (SVG cannot read the role CSS variables). */
const ROLE = {
  line: 'accent',
  held: 'positive',
  broke: 'negative',
  aborted: 'warning',
  info: 'info',
  muted: 'muted',
  ink: 'ink'
} as const
export type ChaosColors = Record<keyof typeof ROLE, string>
const FALLBACK: ChaosColors = {
  line: '#0e7490',
  held: '#15803d',
  broke: '#dc2626',
  aborted: '#b45309',
  info: '#4f46e5',
  muted: '#64748b',
  ink: '#0f172a'
}

export function useChaosColors(): ChaosColors {
  const [colors, setColors] = useState<ChaosColors>(FALLBACK)
  useLayoutEffect(() => {
    const probeAll = () => {
      const dark = document.documentElement.classList.contains('dark')
      const probe = document.createElement('span')
      probe.style.display = 'none'
      document.body.appendChild(probe)
      const out = { ...FALLBACK }
      for (const [key, role] of Object.entries(ROLE) as Array<[keyof ChaosColors, string]>) {
        probe.style.color = ''
        probe.style.color = COLOR_ROLES[role][dark ? 1 : 0]
        if (probe.style.color) out[key] = getComputedStyle(probe).color
      }
      probe.remove()
      setColors(out)
    }
    probeAll()
    const mo = new MutationObserver(probeAll)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => mo.disconnect()
  }, [])
  return colors
}

export const CHART_TOOLTIP = {
  fontSize: 12,
  borderRadius: 6,
  background: 'hsl(var(--card))',
  color: 'hsl(var(--foreground))',
  border: '1px solid hsl(var(--border))'
}

export const CHART_TICK = { fontSize: 11, fill: 'currentColor' }

/**
 * Pure helpers for the partner and API-shape lenses (#2150 #2200 #2201 #2205 #2206): the
 * server's row types and the small wording / geometry decisions the panels make.
 */

export interface HourPoint {
  t: string
  req: number
  p95: number | null
  avail_pct: number | null
  breach: 'latency' | 'availability' | 'both' | null
  judged: boolean
}

export interface PartnerContract {
  api: { id: number; name: string }
  targets: { p95_ms: number | null; uptime_pct: number | null } | null
  calls?: number
  p95_ms?: number | null
  avail_pct?: number | null
  latency_met?: boolean | null
  uptime_met?: boolean | null
  hours_judged?: number
  hours_breached?: number
  attainment_pct?: number | null
  series?: HourPoint[]
  truncated?: boolean
}

export interface DriftFinding {
  path: string
  recent: number
  baseline_pct: number
  from?: string
  to?: string
}
export interface DriftReport {
  status: 'learning' | 'steady' | 'drifting'
  bodies: number
  needed: number
  recent_bodies: number
  new_fields: DriftFinding[]
  missing_fields: DriftFinding[]
  type_changes: DriftFinding[]
}
export interface ShapeGroup {
  endpoint: string
  side: 'request' | 'response'
  report: DriftReport
}
export interface PartnerShapes {
  api: { id: number; name: string }
  available: boolean
  bodies_hours: number
  rows?: number
  groups: ShapeGroup[]
}

/** Why an hour is marked, in words. */
export function breachText(b: HourPoint['breach']): string {
  if (b === 'both') return 'over the response time and under the availability agreed'
  if (b === 'latency') return 'over the response time agreed'
  if (b === 'availability') return 'under the availability agreed'
  return 'inside what was agreed'
}

/** Bar heights (0–1) for a 24-hour strip, scaled so the target line sits at 2/3 of the height. */
export function stripScale(
  series: readonly HourPoint[],
  targetMs: number | null
): { heights: number[]; targetAt: number | null } {
  const top = Math.max(targetMs ? targetMs * 1.5 : 0, ...series.map((p) => p.p95 ?? 0), 1)
  return {
    heights: series.map((p) => (p.p95 && p.p95 > 0 ? Math.min(1, p.p95 / top) : 0)),
    targetAt: targetMs ? Math.min(1, targetMs / top) : null
  }
}

/** The one-line verdict on a drift report. */
export function driftHeadline(r: DriftReport): string {
  if (r.status === 'learning')
    return `Learning — ${r.bodies} of ${r.needed} bodies needed before a usual shape is trusted`
  if (r.status === 'steady') return `Steady across ${r.bodies} bodies`
  const parts: string[] = []
  if (r.new_fields.length) parts.push(`${r.new_fields.length} new`)
  if (r.missing_fields.length) parts.push(`${r.missing_fields.length} missing`)
  if (r.type_changes.length) parts.push(`${r.type_changes.length} changed type`)
  return `Drifting — ${parts.join(', ')}`
}

export interface InboundOutcomes {
  window_s: number
  payloads: { accepted: number; partial: number; rejected: number }
  entries: number
  entries_rejected: number
  reasons: Array<{ reason: string; n: number }>
}

export interface GraphqlCost {
  window_s: number
  calls: number
  avg_selections: number
  max_depth: number
  avg_resolver_ms: number | null
  avg_wall_ms: number
  rank: number
  of: number
  callers: Array<{ key: string; n: number }>
}
export interface GraphqlCostRow {
  key: string
  operation: string
  calls: number
  avg_selections: number
  max_depth: number
  avg_resolver_ms: number | null
  avg_wall_ms: number
}

export interface RestFields {
  window_s: number
  reads: number
  star_reads: number
  fields: Array<{ field: string; n: number; callers: Array<{ key: string; n: number }> }>
}

/** Share of reads that asked for every column, as a whole percent (0 when there were none). */
export function starShare(d: Pick<RestFields, 'reads' | 'star_reads'>): number {
  return d.reads > 0 ? Math.round((100 * d.star_reads) / d.reads) : 0
}

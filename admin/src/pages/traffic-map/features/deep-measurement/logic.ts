/**
 * Pure helpers for the deep-measurement features (#1108 #1119 #1134 #1135 #1136 #1145 #1146
 * #1151): the wire shapes the server taps send and the arithmetic the panels show.
 */
import type { TrafficModel } from '../../model'

export const REQUEST_COST = 'request-cost'
export const READ_SHAPES = 'read-shapes'
export const GRAPHQL_FIELDS = 'graphql-fields'
export const FIELD_HEAT = 'field-heat'
export const HOT_RECORDS = 'hot-records'

// ── wire shapes (api/src/services/traffic-taps/*) ──
export interface CostFrame {
  trips: Record<string, number>
  n1: string[]
  threshold: number
}
export interface CostSummary {
  n: number
  avg_trips: number
  avg_sql_ms: number
  sql_share: number
  n_plus_one: boolean
}
export interface Breakdown {
  auth: number
  metadata: number
  sql: number
  hooks: number
  serialization: number
  other: number
}
export interface CostDetail extends CostSummary {
  window_s: number
  threshold: number
  min_requests: number
  avg_ms: number
  breakdown: Breakdown
  access: { avg_ms: number; share: number; checked: number }
  repeat: { requests: number; share: number; sql: string | null; n: number } | null
  amplification: {
    write_requests: number
    direct: number
    derived: Record<string, number>
    derived_total: number
    factor: number | null
  } | null
}
export interface ShapesDetail {
  window_s: number
  reads: number
  shapes: Array<{ shape: string; n: number }>
  columns: Array<{
    path: string
    filter: number
    sort: number
    ops: string[]
    indexed: boolean | null
  }>
}
export interface GraphqlFieldsDetail {
  window_s: number
  unused_window_s: number
  fields: Array<{ field: string; n: number; callers: Array<{ key: string; n: number }> }>
  types: Array<{ type: string; selected: number; total: number; unused: string[] }>
}
export interface FieldHeatDetail {
  window_s: number
  writes: number
  fields: Array<{
    field: string
    n: number
    share: number
    callers: Array<{ key: string; n: number }>
  }>
}
export interface HotRecordsDetail {
  window_s: number
  collection: string
  rows: Array<{
    id: string
    label: string | null
    writes: number
    conflicts: number
    lock_acquires: number
    locked_by: string | null
    queue: number
  }>
}
export type EntityDetail = Partial<{
  [REQUEST_COST]: CostDetail
  [READ_SHAPES]: ShapesDetail
  [GRAPHQL_FIELDS]: GraphqlFieldsDetail
  [FIELD_HEAT]: FieldHeatDetail
  [HOT_RECORDS]: HotRecordsDetail
}>

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** The newest frame's request-cost figures (null when the frame carried none). */
export function costFrame(model: Pick<TrafficModel, 'frameExt'>): CostFrame | null {
  const v = asObject(model.frameExt[REQUEST_COST])
  if (!v || !asObject(v.trips) || !Array.isArray(v.n1)) return null
  return v as unknown as CostFrame
}

/** Average round trips per request: live (last minute) first, else the snapshot window's. */
export function tripsFor(
  model: Pick<TrafficModel, 'frameExt' | 'entityMeta'>,
  key: string
): number | null {
  const live = costFrame(model)?.trips[key]
  if (typeof live === 'number') return live
  const snap = asObject(model.entityMeta(key)?.ext?.[REQUEST_COST])
  return typeof snap?.avg_trips === 'number' ? snap.avg_trips : null
}

/** The N+1 badge: the live frame decides while frames carry figures; the snapshot otherwise. */
export function nPlusOneBadge(
  nodeId: string,
  model: Pick<TrafficModel, 'frameExt' | 'entityMeta'>
): { text: string; tone: 'warn' } | null {
  const frame = costFrame(model)
  let over = false
  if (frame) over = frame.n1.includes(nodeId)
  else over = asObject(model.entityMeta(nodeId)?.ext?.[REQUEST_COST])?.n_plus_one === true
  if (!over) return null
  const trips = tripsFor(model, nodeId)
  return { text: trips != null ? `N+1 · ${Math.round(trips)}` : 'N+1', tone: 'warn' }
}

export interface Segment {
  id: keyof Breakdown
  label: string
  ms: number
  pct: number
  color: string
}

export const SEGMENTS: Array<{ id: keyof Breakdown; label: string; color: string }> = [
  { id: 'auth', label: 'Auth', color: 'var(--tm-dm-auth)' },
  { id: 'metadata', label: 'Metadata', color: 'var(--tm-read)' },
  { id: 'sql', label: 'Query SQL', color: 'var(--tm-update)' },
  { id: 'hooks', label: 'Hooks', color: 'var(--tm-create)' },
  { id: 'serialization', label: 'Serialization', color: 'var(--tm-dm-ser)' },
  { id: 'other', label: 'Handler & rest', color: 'var(--tm-dm-other)' }
]

/** The stacked-bar segments of a breakdown (shares of its total; empty ones kept for the legend). */
export function breakdownSegments(b: Breakdown): Segment[] {
  const total = SEGMENTS.reduce((s, x) => s + Math.max(0, b[x.id] ?? 0), 0)
  return SEGMENTS.map((x) => {
    const ms = Math.max(0, b[x.id] ?? 0)
    return { ...x, ms, pct: total > 0 ? (100 * ms) / total : 0 }
  })
}

/** `items/<collection>` → collection; null for other lanes. */
export function collectionOfKey(key: string): string | null {
  const cut = key.indexOf('/')
  if (cut <= 0) return null
  const lane = key.slice(0, cut)
  return lane === 'items' || lane === 'system' ? key.slice(cut + 1) : null
}

/** Where the admin opens a record. */
export function recordHref(collection: string, id: string): string {
  return `/collections/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`
}

/** A GraphQL type that is a collection (opens in the Table Editor); root / helper types are not. */
export function typeIsCollection(type: string): boolean {
  if (['Query', 'Mutation', 'Subscription'].includes(type)) return false
  if (/_(m2m|m2a|metadata|aggregated|filter|input)$/i.test(type)) return false
  return /^[A-Za-z0-9_]+$/.test(type)
}

export function fmtShare(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return '0%'
  const p = x * 100
  return p < 1 ? '<1%' : `${Math.round(p)}%`
}

/** Milliseconds for the small parts of a split: '<1 ms' rather than a rounded 0. */
export function fmtMsFine(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1) return '<1 ms'
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`
}

export function fmtTrips(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1)
}

/** The labels of the derived-write kinds, in display order. */
export const DERIVED_LABEL: Record<string, string> = {
  rollup: 'rollups',
  queue: 'queue cache rows',
  integrity: 'integrity checks',
  revision: 'revisions',
  activity: 'activity rows'
}

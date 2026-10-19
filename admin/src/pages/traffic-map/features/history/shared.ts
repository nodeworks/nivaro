/**
 * tm-history (long history, playback, history-derived analysis): the wire types of
 * /api/traffic-map/history/* and /capacity/what-if, node labels, and the panel's own little
 * store (which tab is open, which moment the time-lapse sits on) — also the `tl` view param, so a
 * link (a search answer, a shared view) opens the time-lapse paused on a moment.
 */
import { useSyncExternalStore } from 'react'
import { callerLabel, entityLabel } from '../../EventTicker'
import type { TrafficModel } from '../../model'
import { downLabel } from '../../nodeKinds'
import { register } from '../../registry/registry'
import { viewParams } from '../../registry/viewParams'
import type { TrafficCatalog } from '../../types'

export type HistoryTab = 'timelapse' | 'jobs' | 'search'
export type HistoryRange = '24h' | '7d' | '30d' | '90d' | '13mo'

export interface Marker {
  kind: string
  at: number
  until?: number
  label: string
}
export interface TimelapseBody {
  range: HistoryRange
  source: 'minutes' | 'log' | 'store' | 'rollups' | 'stack' | 'unavailable'
  from: number
  to: number
  step_s: number
  nodes: Array<{ key: string; n: number; e: number }>
  frames: Array<{
    t: number
    req: number
    err: number
    nodes: Array<[number, number, number, number]>
  }>
  people: { online: Array<number | null>; active: number[]; sampled: boolean }
  markers: Marker[]
  minutes: { enabled: boolean; first: string | null }
  /** The long-history store was wanted but did not answer (or is not set up). */
  note?: string
  /** Rollup ranges: when the rollups start (epoch ms); earlier steps are empty. */
  data_from?: number | null
}
/** GET /history/store — the long-history telemetry store (#2544). */
export interface StoreStatusBody {
  configured: boolean
  access_log: boolean
  env: string | null
  reachable: boolean | null
  latency_ms: number | null
  oldest: string | null
  error: string | null
}
export interface MinuteSettingsBody {
  settings: { enabled: boolean; retention_days: number; edges: boolean }
  coverage: { table: boolean; first: string | null; last: string | null }
  cloud: boolean
  /** The telemetry stack keeps traffic history (13 months). */
  stack?: boolean
  /** When the stack's history starts (ISO); null = no rollups yet. */
  stack_from?: string | null
}
export interface JobSlot {
  id: string
  heavy: boolean
  expression: string
  timezone: string | null
  runs: number
  per_day: number
  median_ms: number
  start_minute_utc: number | null
  traffic_during: number
  overlaps_peak: boolean
  suggest_minute_utc: number | null
  suggest_expression: string | null
  suggest_traffic: number | null
}
export interface JobsBody {
  curve: number[]
  peak_level: number
  jobs: JobSlot[]
  source: string
}
export interface WhatIfFigures {
  rps_per_replica: number
  headroom_pct: number | null
  pool_used: number
  pool_pct: number | null
  loop_p99_ms: number | null
  saturated: boolean
}
export interface WhatIfBody {
  now: WhatIfFigures
  projected: WhatIfFigures
  replicas: { now: number; projected: number }
  job?: {
    id: string
    from_before: WhatIfFigures
    from_after: WhatIfFigures
    to_before: WhatIfFigures
    to_after: WhatIfFigures
  }
  notes: string[]
}
export interface SearchHit {
  at: number
  until?: number
  route?: string
  status?: number
  latency_ms?: number
  caller?: string
  n?: number
}
export interface SearchAnswer {
  kind: 'last_hit' | 'first_error' | 'busiest_hour'
  hit: SearchHit | null
  more: SearchHit[]
  count: number
  note?: string
  /** `store` = the long-history telemetry store answered (#2544). */
  source?: 'store'
}

/** A history node key's label (`e:items/workflows`, `c:u…`, `d:ext:3`). */
export function nodeKeyLabel(
  key: string,
  cat: TrafficCatalog | null,
  model?: TrafficModel | null
): { label: string; kind: 'entity' | 'caller' | 'down'; id: string } {
  const body = key.slice(2)
  if (key.startsWith('c:')) return { label: callerLabel(cat, body), kind: 'caller', id: body }
  if (key.startsWith('d:'))
    return { label: model ? downLabel(model, cat, body) : body, kind: 'down', id: body }
  const cut = body.indexOf('/')
  const lane = body.slice(0, cut)
  const entity = body.slice(cut + 1)
  const label =
    entity === '__overflow__'
      ? 'everything else'
      : (lane === 'items' || lane === 'system') && cat?.collections[entity]
        ? cat.collections[entity].label
        : entityLabel(cat, lane, entity)
  return { label, kind: 'entity', id: body }
}

/** "Tue 14:05" — a moment in the viewer's own clock. */
export function fmtMoment(ms: number, withDay = true): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    ...(withDay ? { weekday: 'short' as const } : {}),
    hour: '2-digit',
    minute: '2-digit'
  })
}
/** A UTC minute of the day as the viewer's local clock time ("02:15"). */
export function fmtUtcMinute(m: number): string {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, m))
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} min`
  return `${(ms / 3600_000).toFixed(1)} h`
}

/** The Traffic Map's own rewind ring holds about this much; older moments open in the time-lapse. */
export const RING_MS = 14 * 60_000

// ── the panel's store ────────────────────────────────────────────────────────
interface HistoryState {
  tab: HistoryTab | null
  range: HistoryRange
  /** The moment (epoch ms) the time-lapse is paused on; null = from the start / playing. */
  at: number | null
  /** Bumped when a link or a search answer asks for a moment, so the player seeks to it. */
  seek: number
}
let state: HistoryState = { tab: null, range: '24h', at: null, seek: 0 }
const listeners = new Set<() => void>()
function emit(): void {
  for (const l of listeners) l()
}
export const historyStore = {
  get: (): HistoryState => state,
  set(patch: Partial<HistoryState>): void {
    state = { ...state, ...patch }
    emit()
  },
  /** Open the time-lapse paused on `ms` (picks the range that holds it) and scroll to it. */
  openAt(ms: number): void {
    const age = Date.now() - ms
    // Older than the longest range (13 months): nothing holds it.
    if (age > 395 * 86_400_000) return
    const range: HistoryRange =
      age < 24 * 3600_000
        ? '24h'
        : age < 7 * 86_400_000
          ? '7d'
          : age < 30 * 86_400_000
            ? '30d'
            : age < 90 * 86_400_000
              ? '90d'
              : '13mo'
    state = { ...state, tab: 'timelapse', range, at: ms, seek: state.seek + 1 }
    emit()
    if (typeof document !== 'undefined')
      setTimeout(
        () =>
          document
            .getElementById('tm-history')
            ?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
        50
      )
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }
}
export function useHistoryState(): HistoryState {
  return useSyncExternalStore(historyStore.subscribe, historyStore.get, historyStore.get)
}

/** The link to a moment: the map's own rewind for the last minutes, the time-lapse before. */
export function momentHref(ms: number): string {
  const sec = Math.floor(ms / 1000)
  return Date.now() - ms <= RING_MS ? `/traffic-map?at=${sec}` : `/traffic-map?tl=${sec}`
}

register(viewParams, {
  id: 'history-moment',
  param: 'tl',
  get: () =>
    state.tab === 'timelapse' && state.at != null ? String(Math.floor(state.at / 1000)) : null,
  set: (v) => {
    if (v && /^\d{9,11}$/.test(v)) historyStore.openAt(Number(v) * 1000)
    else if (state.tab === 'timelapse') historyStore.set({ at: null })
  },
  subscribe: (fn) => historyStore.subscribe(fn)
})

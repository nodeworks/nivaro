/**
 * Pure helpers of the "entities" investigation panels (caller, entity, query, widget, page,
 * down): breadcrumb titles, caller kinds, the recording-for and load-list answers, small stats.
 * No React, no fetches.
 */
import type { InspectRef } from '../../registry/inspectables'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CallerKind = 'key' | 'person' | 'source' | 'cron' | 'anon'

/** What kind of caller a key names (mirrors the server's parser); null when it names none. */
export function callerKindOf(key: string): CallerKind | null {
  if (key === 'cron' || key === 'anon') return key
  if (/^k\d{1,9}$/.test(key)) return 'key'
  if (key.startsWith('u') && UUID.test(key.slice(1))) return 'person'
  if (/^[a-z][a-z0-9_-]{0,30}:[A-Za-z0-9_.:@-]{1,160}$/.test(key)) return 'source'
  return null
}

const SOURCE_NAMES: Record<string, string> = {
  cron: 'Job',
  flow: 'Flow',
  import: 'Import',
  socket: 'Sockets'
}

/** Breadcrumb text for a caller ref when it carries no label. */
export function callerTitle(ref: InspectRef): string {
  if (ref.label) return ref.label
  const key = ref.id
  const kind = callerKindOf(key)
  if (kind === 'cron') return 'Crons & flows'
  if (kind === 'anon') return 'Unauthenticated'
  if (kind === 'key') return `API key ${key.slice(1)}`
  if (kind === 'person') return `Person ${key.slice(1, 9)}`
  if (kind === 'source') {
    const cut = key.indexOf(':')
    const name = SOURCE_NAMES[key.slice(0, cut)] ?? 'Source'
    return `${name} ${key.slice(cut + 1)}`
  }
  return `Caller ${key}`
}

/** `items/workflows` → `workflows · items`. */
export function entityTitle(ref: InspectRef): string {
  if (ref.label) return ref.label
  const cut = ref.id.indexOf('/')
  if (cut <= 0) return `Entity ${ref.id}`
  const entity = ref.id.slice(cut + 1)
  const name =
    entity === '__other__' ? 'other' : entity === '__background__' ? 'Background jobs' : entity
  return `${name} · ${ref.id.slice(0, cut)}`
}

export function queryTitle(ref: InspectRef): string {
  return ref.label ?? `Query ${ref.id}`
}

export function widgetTitle(ref: InspectRef): string {
  return ref.label ?? `Widget ${ref.id}`
}

/** `admin /collections/:id` → `Page /collections/:id (admin)`. */
export function pageTitle(ref: InspectRef): string {
  if (ref.label) return ref.label
  const sp = ref.id.indexOf(' ')
  return sp > 0 ? `Page ${ref.id.slice(sp + 1)} (${ref.id.slice(0, sp)})` : `Page ${ref.id}`
}

const DOWN_NAMES: Record<string, string> = {
  db: 'SQL Server',
  redis: 'Redis',
  store: 'File storage'
}

export function downTitle(ref: InspectRef): string {
  if (ref.label) return ref.label
  if (DOWN_NAMES[ref.id]) return DOWN_NAMES[ref.id]
  const m = ref.id.match(/^ext:(\d+)$/)
  if (m) return `Partner ${m[1]}`
  return ref.id
}

/** The partner id an `ext:<id>` down node names. */
export function partnerIdOf(id: string): number | null {
  const m = id.match(/^ext:(\d{1,9})$/)
  return m ? Number(m[1]) : null
}

/** The page ref (screen key) of an event's page facts. */
export function pageRefId(page: string, app?: string | null): string {
  return app ? `${app} ${page}` : page
}

/** The record ref of a collection + item. */
export function recordRef(collection: string, item: string | number): InspectRef {
  return { kind: 'record', id: `${collection}:${item}`, label: `${collection} ${item}` }
}

export type RecordingAnswer =
  | { kind: 'found'; id: string; at: number | null; clip: boolean }
  | { kind: 'none'; reason: string }

/**
 * The answer of GET /traffic-map/inspect/recording-for (Task 4) in whichever shape it arrives
 * (`{id}`, `{recording_id}`, `{recording: {id}}`, `{none, reason}`); null when unreadable.
 */
export function parseRecordingFor(data: unknown): RecordingAnswer | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.none === true) {
    return {
      kind: 'none',
      reason: typeof d.reason === 'string' && d.reason ? d.reason : 'No recording for that time.'
    }
  }
  const rec = (d.recording && typeof d.recording === 'object' ? d.recording : null) as Record<
    string,
    unknown
  > | null
  const id = rec?.id ?? d.recording_id ?? d.id
  if (typeof id !== 'string' && typeof id !== 'number') return null
  const offset = Number(d.offset_ms)
  const started = Date.parse(String(rec?.started_at ?? d.started_at ?? ''))
  const at = Number.isFinite(started) && Number.isFinite(offset) ? started + offset : null
  const app = String(rec?.app ?? d.app ?? '')
  return { kind: 'found', id: String(id), at, clip: app === 'error-clip' || d.clip === true }
}

export interface LoadRow {
  load: string
  at: number | string | null
  calls: number
  ms: number
  /** The person's display name (or their id when unnamed) — text, never a caller key. */
  user: string | null
  /** The caller key (`u<UUID>`, `k12`, `anon`) the load's requests ran as; links to the caller. */
  caller: string | null
}

/** Rows of GET /traffic-map/inspect/load-list (Task 7), cleaned; [] when unreadable. */
export function parseLoadList(data: unknown): LoadRow[] {
  if (!Array.isArray(data)) return []
  const out: LoadRow[] = []
  for (const r of data) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.load !== 'string' || !o.load) continue
    out.push({
      load: o.load,
      at: typeof o.at === 'number' || typeof o.at === 'string' ? o.at : null,
      calls: Number(o.calls) || 0,
      ms: Number(o.ms) || 0,
      user: typeof o.user === 'string' && o.user ? o.user : null,
      caller: typeof o.caller === 'string' && callerKindOf(o.caller) ? o.caller : null
    })
  }
  return out
}

export function p95(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x))
  if (!v.length) return 0
  const s = v.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

/** Calls per load and load time over the recent loads of a page. */
export function loadStats(rows: LoadRow[]): {
  n: number
  calls_avg: number
  calls_p95: number
  ms_p95: number
} {
  if (!rows.length) return { n: 0, calls_avg: 0, calls_p95: 0, ms_p95: 0 }
  const calls = rows.map((r) => r.calls)
  return {
    n: rows.length,
    calls_avg: Math.round((calls.reduce((a, b) => a + b, 0) / rows.length) * 10) / 10,
    calls_p95: p95(calls),
    ms_p95: p95(rows.map((r) => r.ms))
  }
}

/** "4.2%" for an error rate already in percent. */
export function fmtRate(pct: number): string {
  return Number.isFinite(pct) ? `${pct.toFixed(pct > 0 && pct < 10 ? 1 : 0)}%` : '—'
}

/** Epoch ms of an ISO / Date / epoch value; null when it is none. */
export function msOf(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(n) ? n : null
}

/** The request series of a history body, for the sparkline. */
export function seriesOf(
  history: { series?: Array<{ req?: number }> } | null | undefined
): number[] {
  return (history?.series ?? []).map((s) => Number(s.req) || 0)
}

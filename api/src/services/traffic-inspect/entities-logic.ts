// api/src/services/traffic-inspect/entities-logic.ts
/**
 * Pure helpers of the "entities" inspect group (caller, entity, query, widget, page, down):
 * id parsing and validation, the time window a level looks at, and the request-log summaries.
 * No database, no Fastify — every id a source sees has been accepted here first.
 */
import { normalizeApp, normalizeScreenPath } from '../traffic-client-facts.js'
import { LANES, routeTemplate, type TrafficLane } from '../traffic-entities.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── caller ────────────────────────────────────────────────────────────────────

export type CallerRef =
  | { kind: 'key'; key: string; apiKeyId: number }
  | { kind: 'person'; key: string; userId: string }
  /** A non-request source (`cron:<job>`, `flow:<id>`, `import:<run>`, `socket:browsers`…). */
  | { kind: 'source'; key: string; source: string; ref: string }
  /** The map's aggregate buckets: every cron/flow request, and requests with no caller. */
  | { kind: 'cron' | 'anon'; key: string }

const SOURCE_RE = /^([a-z][a-z0-9_-]{0,30}):([A-Za-z0-9_.:@-]{1,160})$/

/** A caller key as the map shows it (`k12`, `u<UUID>`, `cron`, `anon`, `cron:<job>`…), or null. */
export function parseCallerKey(raw: string): CallerRef | null {
  const key = String(raw ?? '').trim()
  if (!key || key.length > 200) return null
  if (key === 'cron' || key === 'anon') return { kind: key, key }
  const k = key.match(/^k(\d{1,9})$/)
  if (k) {
    const apiKeyId = Number(k[1])
    return apiKeyId > 0 ? { kind: 'key', key, apiKeyId } : null
  }
  if (key.startsWith('u') && UUID.test(key.slice(1))) {
    const userId = key.slice(1).toUpperCase()
    return { kind: 'person', key: `u${userId}`, userId }
  }
  const s = key.match(SOURCE_RE)
  if (s) return { kind: 'source', key, source: s[1], ref: s[2] }
  return null
}

/** The partner-dependency map's caller key (`key:12`, `user:<UUID>`), or null for other kinds. */
export function dependencyKeyOf(c: CallerRef): string | null {
  if (c.kind === 'key') return `key:${c.apiKeyId}`
  if (c.kind === 'person') return `user:${c.userId}`
  return null
}

// ── entity ────────────────────────────────────────────────────────────────────

const LANE_IDS = new Set<string>(LANES.map((l) => l.id))
/** Same rule as the map's own entity routes (routes/traffic-map.ts). */
export const ENTITY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/

/** `<lane>/<entity>` → its parts, or null when the lane is unknown or the entity malformed. */
export function parseEntityRef(raw: string): { lane: TrafficLane; entity: string } | null {
  const id = String(raw ?? '')
  const cut = id.indexOf('/')
  if (cut <= 0) return null
  const lane = id.slice(0, cut)
  const entity = id.slice(cut + 1)
  if (!LANE_IDS.has(lane) || !ENTITY_RE.test(entity)) return null
  return { lane: lane as TrafficLane, entity }
}

/** The next level an entity opens, beyond itself: a query for the queries lane, a widget for widgets. */
export function relatedRefOf(lane: string, entity: string): { kind: string; id: string } | null {
  if (lane === 'queries' && validQuerySlug(entity)) return { kind: 'query', id: entity }
  if (lane === 'widgets' && validWidgetId(entity)) return { kind: 'widget', id: entity }
  return null
}

// ── query / widget ────────────────────────────────────────────────────────────

/** A custom query slug (or a numeric id). */
export function validQuerySlug(raw: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(String(raw ?? ''))
}

export function validWidgetId(raw: string): boolean {
  return /^[1-9]\d{0,8}$/.test(String(raw ?? ''))
}

// ── page ──────────────────────────────────────────────────────────────────────

/**
 * A page as the screens tap records it: a route pattern (`/collections/workflows/:id`),
 * optionally preceded by the app (`admin /collections/:id`). Only an already-normalised pattern
 * is accepted, so the id can never smuggle a real record id or an email through.
 */
export function parsePageRef(raw: string): { app: string | null; path: string } | null {
  const id = String(raw ?? '').trim()
  if (!id || id.length > 200) return null
  const sp = id.indexOf(' ')
  const app = sp > 0 ? normalizeApp(id.slice(0, sp)) : null
  if (sp > 0 && !app) return null
  const path = sp > 0 ? id.slice(sp + 1) : id
  const norm = normalizeScreenPath(path)
  if (!norm || norm !== path) return null
  return { app, path }
}

/** The screens tap's key for a page (`app path`, or `path` when the app is unknown). */
export function screenKeyOf(p: { app: string | null; path: string }): string {
  return p.app ? `${p.app} ${p.path}` : p.path
}

// ── down ──────────────────────────────────────────────────────────────────────

/** A down node id: `db`, `redis`, `store`, `mail`, `ai`, `ext:<id>`, `x:<ext>.<id>`… */
export function validDownId(raw: string): boolean {
  const id = String(raw ?? '')
  if (/^ext:\d{1,9}$/.test(id)) return true
  return /^[a-z][a-z0-9_-]{0,40}(:[A-Za-z0-9_.-]{1,100})?$/.test(id)
}

/** The partner (nivaro_external_apis id) a down node names, or null. */
export function partnerIdOf(id: string): number | null {
  const m = String(id).match(/^ext:(\d{1,9})$/)
  return m ? Number(m[1]) : null
}

// ── window ────────────────────────────────────────────────────────────────────

export const MAP_WINDOWS = [60, 300, 900] as const
export type MapWindow = (typeof MAP_WINDOWS)[number]

/** The map's own ring window closest to (not below) the inspect window. */
export function mapWindowFor(windowSec: number): MapWindow {
  if (windowSec <= 60) return 60
  if (windowSec <= 300) return 300
  return 900
}

/** The history window (hours) covering the inspect window. */
export function historyHoursFor(windowSec: number): 1 | 6 | 24 {
  if (windowSec <= 3600) return 1
  if (windowSec <= 6 * 3600) return 6
  return 24
}

/**
 * The time range a level reads: around `at` (± window) when anchored, else the last `window`
 * seconds. Never beyond now.
 */
export function rangeFor(
  at: number | null,
  windowSec: number,
  now = Date.now()
): { from: number; to: number } {
  if (at == null) return { from: now - windowSec * 1000, to: now }
  return { from: at - windowSec * 1000, to: Math.min(now, at + windowSec * 1000) }
}

// ── request-log summaries ─────────────────────────────────────────────────────

export interface LogRow {
  method: string
  path: string
  status: number
  latency_ms: number
  created_at: Date | string
  graphql_operation?: string | null
  request_id?: string | null
  error?: string | null
}

export function p95Of(values: number[]): number {
  if (!values.length) return 0
  const s = values.slice().sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))])
}

/** Timestamps folded into `points` equal buckets over [from, to) (oldest first). */
export function bucketCounts(
  times: Array<Date | string | number>,
  from: number,
  to: number,
  points: number
): number[] {
  const out = new Array<number>(points).fill(0)
  const span = Math.max(1, to - from)
  for (const t of times) {
    const ms = typeof t === 'number' ? t : new Date(t).getTime()
    if (!Number.isFinite(ms) || ms < from || ms > to) continue
    out[Math.min(points - 1, Math.floor(((ms - from) / span) * points))]++
  }
  return out
}

export interface RouteStatusRow {
  route: string
  status: number
  n: number
  p95: number
}

/**
 * A caller's requests grouped by route template and status, busiest first (top `limit`), with
 * totals, error rate (status ≥ 400) and p95 over every row.
 */
export function summarizeRequests(
  rows: LogRow[],
  limit = 20
): {
  total: number
  errors: number
  error_rate: number
  p95: number
  routes: RouteStatusRow[]
} {
  const groups = new Map<string, { route: string; status: number; lat: number[] }>()
  let errors = 0
  const lat: number[] = []
  for (const r of rows) {
    const status = Number(r.status) || 0
    const route = routeTemplate(r.method, r.path, r.graphql_operation)
    const k = `${route}\u0000${status}`
    let g = groups.get(k)
    if (!g) {
      g = { route, status, lat: [] }
      groups.set(k, g)
    }
    const ms = Number(r.latency_ms) || 0
    g.lat.push(ms)
    lat.push(ms)
    if (status >= 400) errors++
  }
  const routes = [...groups.values()]
    .map((g) => ({ route: g.route, status: g.status, n: g.lat.length, p95: p95Of(g.lat) }))
    .sort((a, b) => b.n - a.n || a.route.localeCompare(b.route))
    .slice(0, limit)
  const total = rows.length
  return {
    total,
    errors,
    error_rate: total ? Math.round((errors / total) * 1000) / 10 : 0,
    p95: p95Of(lat),
    routes
  }
}

/** A JSON text column as an array (or null when absent / unparseable). */
export function jsonArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** A JSON text column as an object (or null). */
export function jsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A base URL without credentials, query string or fragment (shown, never secrets). */
export function safeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return null
  }
}

/**
 * A widget's config in a few readable lines (type-agnostic): the bound query, parameter
 * bindings, table columns, drill-down target. The raw config rides separately.
 */
export function widgetConfigSummary(config: Record<string, unknown> | null): {
  query_id: number | null
  lines: Array<{ label: string; value: string }>
} {
  const lines: Array<{ label: string; value: string }> = []
  if (!config) return { query_id: null, lines }
  const qid = Number(config.query_id)
  const query_id = Number.isInteger(qid) && qid > 0 ? qid : null
  const bindings = Array.isArray(config.param_bindings) ? config.param_bindings : []
  if (bindings.length) {
    lines.push({
      label: 'Parameters',
      value: bindings
        .map((b) => {
          const o = (b ?? {}) as Record<string, unknown>
          return `${String(o.param ?? '?')} ← ${String(o.input_key ?? o.value ?? '?')}`
        })
        .join(', ')
        .slice(0, 300)
    })
  }
  const table = (config.table ?? null) as Record<string, unknown> | null
  const cols = table && Array.isArray(table.columns) ? table.columns : null
  if (cols) lines.push({ label: 'Columns', value: String(cols.length) })
  if (table?.group_by) lines.push({ label: 'Grouped by', value: String(table.group_by) })
  const drill = (config.drilldown ?? null) as Record<string, unknown> | null
  if (drill?.collection) lines.push({ label: 'Drills into', value: String(drill.collection) })
  const other = Object.keys(config).filter(
    (k) => !['query_id', 'param_bindings', 'table', 'drilldown'].includes(k)
  )
  if (other.length) lines.push({ label: 'Other settings', value: other.slice(0, 10).join(', ') })
  return { query_id, lines }
}

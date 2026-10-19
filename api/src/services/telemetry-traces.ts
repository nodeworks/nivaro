// api/src/services/telemetry-traces.ts
/**
 * Request traces read back from the traces store (VictoriaTraces, #2544) — what trace-export.ts
 * sent. Spans are stored as LogsQL rows (`trace_id`, `span_id`, `parent_span_id`, `name`, `kind`,
 * `duration` in ns, `resource_attr:*`, `span_attr:*`), read through vmauth's `/traces` read path.
 *
 *  - loadStoredTrace  — one trace by trace id or request id, summarised like a slow-request trace
 *                       (phases, heaviest statement shapes, repeated statements)
 *  - listStoredTraces — the slowest or failed requests in a window
 *
 * Field names carrying `:` must be double-quoted in LogsQL, so every filter here goes through
 * `field()`. Values are quoted with `lq()`; nothing from a request becomes query text.
 */
import { logsQuery, lq, type StoreRow, storeTime } from './telemetry-store.js'
import { traceExportConfig, traceIdFor } from './trace-export.js'

const field = (name: string) => `"${name}"`
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** This instance's spans: its service name and environment. */
export function spanScope(): string {
  const cfg = traceExportConfig()
  const service = cfg?.service ?? process.env.TRACE_EXPORT_SERVICE?.trim() ?? 'nivaro-api'
  const env = cfg?.env ?? process.env.TELEMETRY_STORE_ENV?.trim() ?? null
  return `${field('resource_attr:service.name')}:=${lq(service)}${
    env ? ` ${field('resource_attr:deployment.environment.name')}:=${lq(env)}` : ''
  }`
}

/** Accepts a 32-hex trace id or a request id (UUID); null when it is neither. */
export function normaliseTraceId(raw: string): string | null {
  const s = String(raw ?? '').trim()
  if (/^[0-9a-fA-F]{32}$/.test(s)) return s.toLowerCase()
  return traceIdFor(s)
}

export interface StoredTraceSummary {
  trace_id: string
  request_id: string | null
  method: string
  route: string
  status: number
  total_ms: number
  at: string | null
  reason: string | null
  user: string | null
  round_trips: number
  sql_ms: number
  phases: Array<{ phase: string; ms: number; depth: number; queries: number | null }>
  heaviest_statements: Array<{ sql: string; calls: number; total_ms: number }>
  repeated_statements: Array<{ sql: string; calls: number; total_ms: number }>
  span_count: number
}

const msOf = (row: StoreRow) => Math.round((num(row.duration) / 1e6) * 10) / 10

/** Turn one trace's span rows into the summary the explainer and the assistant read. */
export function summariseSpans(traceId: string, rows: StoreRow[]): StoredTraceSummary | null {
  const root = rows.find((r) => String(r.kind) === '2') ?? null
  if (!root) return null
  const byId = new Map(rows.map((r) => [r.span_id, r]))
  const depthOf = (r: StoreRow): number => {
    let d = 0
    let p: string | undefined = r.parent_span_id
    while (p && byId.has(p) && d < 20) {
      d++
      p = byId.get(p)?.parent_span_id
    }
    return d
  }
  const phases = rows
    .filter((r) => String(r.kind) === '1')
    .sort((a, b) => num(a.start_time_unix_nano) - num(b.start_time_unix_nano))
    .map((r) => ({
      phase: r.name ?? '',
      ms: msOf(r),
      // 0 = directly under the request span.
      depth: Math.max(0, depthOf(r) - 1),
      queries: r['span_attr:nivaro.db_round_trips']
        ? num(r['span_attr:nivaro.db_round_trips'])
        : null
    }))
  const statements = rows.filter((r) => r.name === 'SQL')
  const shapes = new Map<string, { sql: string; calls: number; total_ms: number }>()
  for (const s of statements) {
    const sql = String(s['span_attr:db.query.text'] ?? '').slice(0, 500)
    const g = shapes.get(sql) ?? { sql, calls: 0, total_ms: 0 }
    g.calls++
    g.total_ms += msOf(s)
    shapes.set(sql, g)
  }
  const all = [...shapes.values()].map((g) => ({ ...g, total_ms: Math.round(g.total_ms) }))
  return {
    trace_id: traceId,
    request_id: root['span_attr:nivaro.request_id'] ?? null,
    method: root['span_attr:http.request.method'] ?? root.name?.split(' ')[0] ?? '',
    route: root['span_attr:http.route'] ?? root.name ?? '',
    status: num(root['span_attr:http.response.status_code']),
    total_ms: Math.round(msOf(root)),
    at: Number.isFinite(storeTime(root._time))
      ? new Date(storeTime(root._time)).toISOString()
      : null,
    reason: root['span_attr:nivaro.export_reason'] ?? null,
    user: root['span_attr:enduser.id'] ?? null,
    round_trips: num(root['span_attr:nivaro.db_round_trips']) || statements.length,
    sql_ms: Math.round(statements.reduce((t, s) => t + msOf(s), 0)),
    phases: phases.slice(0, 60),
    heaviest_statements: [...all].sort((a, b) => b.total_ms - a.total_ms).slice(0, 8),
    repeated_statements: all.filter((g) => g.calls >= 5).sort((a, b) => b.calls - a.calls),
    span_count: rows.length
  }
}

/** One trace from the store (searched over the last `days` days). Null when it is not there. */
export async function loadStoredTrace(
  idOrRequestId: string,
  days = 8,
  nowMs = Date.now()
): Promise<StoredTraceSummary | null> {
  const id = normaliseTraceId(idOrRequestId)
  if (!id) return null
  const rows = await logsQuery(
    `trace_id:=${lq(id)} | limit 3000`,
    nowMs - days * 86_400_000,
    nowMs + 60_000,
    { store: 'traces' }
  )
  return summariseSpans(id, rows)
}

export interface StoredTraceRow {
  trace_id: string
  route: string
  status: number
  total_ms: number
  at: string | null
  reason: string | null
}

/** The slowest (or failed) requests between `from` and `to`, newest-first among equals. */
export async function listStoredTraces(opts: {
  from: number
  to: number
  route?: string | null
  errorsOnly?: boolean
  limit?: number
}): Promise<StoredTraceRow[]> {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 15))
  const parts = [spanScope(), 'kind:=2']
  if (opts.route) parts.push(`${field('span_attr:http.route')}:=${lq(opts.route)}`)
  if (opts.errorsOnly) parts.push(`${field('span_attr:http.response.status_code')}:>=500`)
  const rows = await logsQuery(
    `${parts.join(' ')} | sort by (duration desc) limit ${limit}`,
    opts.from,
    opts.to,
    { store: 'traces' }
  )
  return rows.map((r) => ({
    trace_id: r.trace_id,
    route: r.name ?? '',
    status: num(r['span_attr:http.response.status_code']),
    total_ms: Math.round(msOf(r)),
    at: Number.isFinite(storeTime(r._time)) ? new Date(storeTime(r._time)).toISOString() : null,
    reason: r['span_attr:nivaro.export_reason'] ?? null
  }))
}

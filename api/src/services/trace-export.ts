// api/src/services/trace-export.ts
/**
 * Request traces out to the telemetry stack as OpenTelemetry spans (#690 / #2544).
 *
 * services/request-trace.ts already times every /api request's phases and statements; it keeps
 * only slow ones, in memory. This turns a finished request's trace into OTLP spans and sends
 * them to TRACE_EXPORT_URL (an OTLP/HTTP traces endpoint — on EFP, Alloy's receiver, which
 * forwards to VictoriaTraces) with TRACE_EXPORT_TOKEN as a bearer token.
 *
 * Which requests: every slow one (TRACE_SLOW_MS), every 5xx, everything the request-trace module
 * was asked to keep (follow-this-user, Trace next call), and TRACE_EXPORT_SAMPLE of the rest
 * (default 2%). The trace id is the request id without dashes, so the API log row, the Traffic
 * Map, the `x-nivaro-request-id` header and the access line's `tid` all point at the same trace.
 *
 * What a span carries: route template, method, status, path WITHOUT the query string, the user
 * id, phase names and timings, and each statement's SQL text — never its bound values.
 *
 * Sending never touches a response: traces queue in memory (bounded), go out in batches every few
 * seconds, and a failure is counted and dropped. Off in cloud mode (no tenant attribute).
 */
import { randomBytes } from 'node:crypto'

const DEFAULT_SAMPLE = 0.02
const QUEUE_MAX = 2000
const BATCH_MAX = 100
const FLUSH_MS = 5000
const MAX_STATEMENT_SPANS = 300
const SQL_TEXT_CAP = 2000

export interface TraceExportConfig {
  url: string
  token: string | null
  sample: number
  env: string | null
  service: string
}

export function traceExportConfig(): TraceExportConfig | null {
  if (process.env.CLOUD_META_DB_URL) return null
  const url = process.env.TRACE_EXPORT_URL?.trim()
  if (!url || !/^https?:\/\//i.test(url)) return null
  const raw = process.env.TRACE_EXPORT_SAMPLE
  const n = raw == null || raw.trim() === '' ? DEFAULT_SAMPLE : Number(raw)
  return {
    url,
    token: process.env.TRACE_EXPORT_TOKEN?.trim() || null,
    sample: Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_SAMPLE,
    env: process.env.TRACE_EXPORT_ENV?.trim() || process.env.TELEMETRY_STORE_ENV?.trim() || null,
    service: process.env.TRACE_EXPORT_SERVICE?.trim() || 'nivaro-api'
  }
}

export type ExportReason = 'slow' | 'error' | 'kept' | 'sampled'

/** Whether a finished request goes out, and why (null = it does not). */
export function exportReason(
  cfg: TraceExportConfig | null,
  totalMs: number,
  status: number,
  slowMs: number,
  kept: boolean,
  rand: () => number = Math.random
): ExportReason | null {
  if (!cfg) return null
  if (status >= 500) return 'error'
  if (totalMs >= slowMs) return 'slow'
  if (kept) return 'kept'
  return cfg.sample > 0 && rand() < cfg.sample ? 'sampled' : null
}

/** The W3C trace id for a request id (a UUID): its 32 hex digits. */
export function traceIdFor(requestId: string): string | null {
  const hex = String(requestId).replace(/-/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null
}

// ── OTLP building (pure) ─────────────────────────────────────────────────────

export interface ExportPhase {
  phase: string
  /** Offset from request start, ms. */
  at: number
  ms: number
  detail?: string
  queries?: number
}
export interface ExportStatement {
  sql: string
  /** When it started, ms from the request's start. */
  at: number
  ms: number
}
export interface ExportInput {
  requestId: string
  /** Epoch ms the request started. */
  startMs: number
  totalMs: number
  method: string
  route: string
  /** Path only — the query string is never sent. */
  path: string
  status: number
  user: string | null
  queries: number
  reason: ExportReason
  phases: ExportPhase[]
  statements: ExportStatement[]
}

type AttrValue = { stringValue: string } | { intValue: string } | { boolValue: boolean }
interface OtlpAttr {
  key: string
  value: AttrValue
}
export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttr[]
  status: { code: number }
}

const str = (key: string, v: string): OtlpAttr => ({ key, value: { stringValue: v } })
const int = (key: string, v: number): OtlpAttr => ({
  key,
  value: { intValue: String(Math.round(v)) }
})
/** Epoch ms (fractional) → OTLP nanoseconds as a decimal string. */
export const nanos = (ms: number): string => (BigInt(Math.round(ms * 1000)) * 1000n).toString()

const SPAN_INTERNAL = 1
const SPAN_SERVER = 2
const SPAN_CLIENT = 3

/**
 * One request → its spans: the request (server span), each phase nested inside the latest phase
 * that contains it, and each SQL statement under the innermost phase it ran in.
 */
export function buildSpans(
  input: ExportInput,
  newId: () => string = () => randomBytes(8).toString('hex')
): OtlpSpan[] {
  const traceId = traceIdFor(input.requestId)
  if (!traceId) return []
  const rootId = newId()
  const t0 = input.startMs
  const out: OtlpSpan[] = [
    {
      traceId,
      spanId: rootId,
      name: `${input.method} ${input.route}`,
      kind: SPAN_SERVER,
      startTimeUnixNano: nanos(t0),
      endTimeUnixNano: nanos(t0 + input.totalMs),
      attributes: [
        str('http.request.method', input.method),
        str('http.route', input.route),
        str('url.path', input.path.split('?')[0].slice(0, 500)),
        int('http.response.status_code', input.status),
        ...(input.user ? [str('enduser.id', input.user)] : []),
        str('nivaro.request_id', input.requestId),
        int('nivaro.db_round_trips', input.queries),
        str('nivaro.export_reason', input.reason)
      ],
      status: { code: input.status >= 500 ? 2 : 0 }
    }
  ]
  // Phases: sorted by start; a phase's parent is the latest open phase that contains it.
  const phases = [...input.phases]
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.ms))
    .sort((a, b) => a.at - b.at || b.ms - a.ms)
  const placed: Array<{ id: string; at: number; end: number }> = []
  const parentOf = (at: number, end: number): string => {
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i]
      if (p.at <= at && end <= p.end + 0.5) return p.id
    }
    return rootId
  }
  for (const p of phases) {
    const id = newId()
    const end = p.at + p.ms
    out.push({
      traceId,
      spanId: id,
      parentSpanId: parentOf(p.at, end),
      name: p.phase,
      kind: SPAN_INTERNAL,
      startTimeUnixNano: nanos(t0 + p.at),
      endTimeUnixNano: nanos(t0 + end),
      attributes: [
        ...(p.detail ? [str('nivaro.detail', p.detail.slice(0, 300))] : []),
        ...(p.queries != null ? [int('nivaro.db_round_trips', p.queries)] : [])
      ],
      status: { code: 0 }
    })
    placed.push({ id, at: p.at, end })
  }
  // Statements: SQL text only (bound values are never sent), under the innermost phase.
  for (const s of input.statements.slice(0, MAX_STATEMENT_SPANS)) {
    if (!Number.isFinite(s.at) || !Number.isFinite(s.ms)) continue
    // `at` is when the statement started (offset from the request's start).
    out.push({
      traceId,
      spanId: newId(),
      parentSpanId: parentOf(s.at, s.at + s.ms),
      name: 'SQL',
      kind: SPAN_CLIENT,
      startTimeUnixNano: nanos(t0 + s.at),
      endTimeUnixNano: nanos(t0 + s.at + s.ms),
      attributes: [str('db.system', 'mssql'), str('db.query.text', s.sql.slice(0, SQL_TEXT_CAP))],
      status: { code: 0 }
    })
  }
  return out
}

/** The OTLP/JSON request body for a batch of spans. */
export function otlpBody(spans: OtlpSpan[], cfg: TraceExportConfig, instance: string) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            str('service.name', cfg.service),
            str('service.instance.id', instance),
            ...(cfg.env ? [str('deployment.environment.name', cfg.env)] : []),
            ...(process.env.npm_package_version
              ? [str('service.version', process.env.npm_package_version)]
              : [])
          ]
        },
        scopeSpans: [{ scope: { name: 'nivaro.request-trace' }, spans }]
      }
    ]
  }
}

// ── Queue + sender ───────────────────────────────────────────────────────────

export interface TraceExportStats {
  enabled: boolean
  queued: number
  traces_sent: number
  spans_sent: number
  dropped: number
  failed_batches: number
  by_reason: Record<ExportReason, number>
  last_ok_at: string | null
  last_error: string | null
  last_error_at: string | null
}

const stats: Omit<TraceExportStats, 'enabled' | 'queued'> = {
  traces_sent: 0,
  spans_sent: 0,
  dropped: 0,
  failed_batches: 0,
  by_reason: { slow: 0, error: 0, kept: 0, sampled: 0 },
  last_ok_at: null,
  last_error: null,
  last_error_at: null
}

let queue: OtlpSpan[][] = []
let timer: NodeJS.Timeout | null = null
let sending = false
let instanceName = 'nivaro'

export function setTraceExportInstance(name: string): void {
  instanceName = name
}

export function traceExportStats(): TraceExportStats {
  return {
    enabled: traceExportConfig() !== null,
    queued: queue.length,
    ...stats,
    by_reason: { ...stats.by_reason }
  }
}

/** Queue one request's spans. Never throws; drops when the queue is full. */
export function queueTraceExport(input: ExportInput): boolean {
  try {
    if (!traceExportConfig()) return false
    const spans = buildSpans(input)
    if (!spans.length) return false
    if (queue.length >= QUEUE_MAX) {
      stats.dropped++
      return false
    }
    queue.push(spans)
    stats.by_reason[input.reason]++
    if (queue.length >= BATCH_MAX) void flushTraceExport()
    else if (!timer) {
      timer = setTimeout(() => {
        timer = null
        void flushTraceExport()
      }, FLUSH_MS)
      timer.unref?.()
    }
    return true
  } catch {
    return false
  }
}

export type ExportFetch = (url: string, init: RequestInit) => Promise<Response>
let send: ExportFetch = (url, init) => fetch(url, init)
export function setTraceExportFetchForTests(f: ExportFetch | null): void {
  send = f ?? ((url, init) => fetch(url, init))
}
export function resetTraceExportForTests(): void {
  queue = []
  if (timer) clearTimeout(timer)
  timer = null
  sending = false
  Object.assign(stats, {
    traces_sent: 0,
    spans_sent: 0,
    dropped: 0,
    failed_batches: 0,
    by_reason: { slow: 0, error: 0, kept: 0, sampled: 0 },
    last_ok_at: null,
    last_error: null,
    last_error_at: null
  })
}

/** Send what is queued, BATCH_MAX traces per request. */
export async function flushTraceExport(): Promise<void> {
  const cfg = traceExportConfig()
  if (!cfg || sending || queue.length === 0) return
  sending = true
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, BATCH_MAX)
      const spans = batch.flat()
      try {
        const res = await send(cfg.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {})
          },
          body: JSON.stringify(otlpBody(spans, cfg, instanceName)),
          signal: AbortSignal.timeout(10_000)
        })
        if (!res.ok) throw new Error(`answered ${res.status}`)
        stats.traces_sent += batch.length
        stats.spans_sent += spans.length
        stats.last_ok_at = new Date().toISOString()
      } catch (err) {
        stats.failed_batches++
        stats.dropped += batch.length
        stats.last_error = err instanceof Error ? err.message.slice(0, 200) : 'send failed'
        stats.last_error_at = new Date().toISOString()
        break
      }
    }
  } finally {
    sending = false
  }
}

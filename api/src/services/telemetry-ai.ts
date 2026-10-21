// api/src/services/telemetry-ai.ts
/**
 * AI over the telemetry stack (#2544): "why was it slow at 2 pm?", "what failed overnight?",
 * "what did the database look like at the peak?".
 *
 * Seven READ-ONLY tools over the stores (request log lines, request traces, metrics, container
 * logs, the stack's status). Every tool takes typed, validated fields and builds its own query
 * — LogsQL values quoted with `lq()`, metrics from a fixed list of expressions — so nothing the
 * model writes is ever run as query text. Results are capped and scrubbed (scrubText) before
 * they reach the provider; request lines carry ids, routes, status and timings only, as stored.
 *
 * Infrastructure questions (restarts, disk, reboot risk, proxy, throttling) use the infra_* tools
 * of infra-ai-tools.ts, offered alongside these (#2842).
 *
 * Used by POST /api/telemetry/ask (the Telemetry page, administrators) and by the ops assistant
 * in admin-only chat channels (ops-assistant.ts), which re-checks the asker on every call.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { User } from '../types.js'
import { getAiClient, getAiModelSettings } from './ai-client.js'
import { scrubText } from './ai-explain.js'
import {
  executeInfraTool,
  INFRA_PROMPT,
  INFRA_TOOL_NAMES,
  INFRA_TOOLS,
  type InfraToolContext,
  infraAvailable
} from './infra-ai-tools.js'
import {
  baseFilter,
  containsRe,
  logsQuery,
  lq,
  metricsRange,
  STORE_MAX_DAYS,
  type StoreRow,
  storeConfig,
  storeTime
} from './telemetry-store.js'
import { listStoredTraces, loadStoredTrace } from './telemetry-traces.js'
import { ROLLUP_MAX_DAYS } from './traffic-rollups.js'

const MAX_RESULT_CHARS = 12_000
const MAX_ROUNDS = 6

// ── Validation helpers ───────────────────────────────────────────────────────

export class TelemetryToolError extends Error {}

const ROUTE_RE = /^[A-Z]{3,7} \/[^\s]{0,200}$|^\/[^\s]{0,200}$/
const ENTITY_RE = /^[a-z]+\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/
const CALLER_RE = /^(u[0-9A-Fa-f-]{36}|k\d{1,12}|anon)$/
const CONTAINER_RE = /^[A-Za-z0-9_.-]{1,80}$/

function optStr(input: Record<string, unknown>, key: string, re: RegExp): string | null {
  const v = input[key]
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (!re.test(s)) throw new TelemetryToolError(`${key} is not valid`)
  return s
}

function optNum(
  input: Record<string, unknown>,
  key: string,
  lo: number,
  hi: number
): number | null {
  const v = input[key]
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new TelemetryToolError(`${key} must be a number`)
  return Math.min(hi, Math.max(lo, n))
}

/** The time window: `from`/`to` (ISO) or the last `minutes` (default 60), within the store's reach. */
export function windowOf(
  input: Record<string, unknown>,
  nowMs = Date.now(),
  maxDays: number = STORE_MAX_DAYS
): { from: number; to: number } {
  const parse = (k: string) => {
    const v = input[k]
    if (v == null || v === '') return null
    const t = Date.parse(String(v))
    if (!Number.isFinite(t)) throw new TelemetryToolError(`${k} must be an ISO date-time`)
    return t
  }
  const earliest = nowMs - maxDays * 86_400_000
  let to = parse('to') ?? nowMs
  to = Math.min(nowMs + 60_000, Math.max(earliest + 60_000, to))
  const minutes = optNum(input, 'minutes', 1, maxDays * 1440) ?? 60
  let from = parse('from') ?? to - minutes * 60_000
  from = Math.max(earliest, Math.min(from, to - 60_000))
  return { from, to }
}

const iso = (ms: number) => new Date(ms).toISOString()
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Request-line filter (access lines, logs store) from typed fields. */
export function requestFilter(input: Record<string, unknown>, env: string | null): string {
  const parts = [baseFilter(env)]
  const route = optStr(input, 'route', ROUTE_RE)
  if (route)
    parts.push(
      route.includes(' ')
        ? `route:=${lq(route)}`
        : `route:~${lq(`^[A-Z]+ ${containsRe(route).slice(4)}$`)}`
    )
  const entity = optStr(input, 'entity', ENTITY_RE)
  if (entity) parts.push(`entity:=${lq(entity)}`)
  const caller = optStr(input, 'caller', CALLER_RE)
  if (caller)
    parts.push(
      `caller:=${lq(caller === 'anon' ? caller : caller[0] + caller.slice(1).toUpperCase())}`
    )
  const status = input.status == null ? 'all' : String(input.status)
  if (status === '5xx') parts.push('status:>=500')
  else if (status === '4xx') parts.push('status:>=400 status:<500')
  else if (status === 'ok') parts.push('status:<400')
  else if (status !== 'all') throw new TelemetryToolError('status must be 5xx, 4xx, ok or all')
  const minMs = optNum(input, 'min_ms', 0, 600_000)
  if (minMs != null) parts.push(`ms:>=${Math.round(minMs)}`)
  const err = input.error_text == null ? '' : String(input.error_text).trim()
  if (err) {
    if (err.length < 3 || err.length > 200)
      throw new TelemetryToolError('error_text must be 3 to 200 characters')
    parts.push(`err:~${lq(containsRe(err))}`)
  }
  return parts.join(' ')
}

// ── Fixed metric expressions ─────────────────────────────────────────────────

/** name → [description, MetricsQL with {E} = the env matcher]. The model picks a name, never writes one. */
export const METRICS: Record<string, [string, string]> = {
  api_requests_per_s: ['API requests per second', 'sum(rate(nivaro_http_requests_total{E}[5m]))'],
  api_errors_5xx_per_s: [
    'API server errors per second',
    'sum(rate(nivaro_http_requests_total{E,status="5xx"}[5m]))'
  ],
  api_p95_seconds: [
    'API p95 response time, seconds',
    'histogram_quantile(0.95, sum by (le) (rate(nivaro_http_request_duration_seconds_bucket{E}[5m])))'
  ],
  db_pool_waiting: ['Requests waiting for a database connection', 'max(nivaro_db_pool_pending{E})'],
  db_pool_in_use: ['Database connections in use', 'sum(nivaro_db_pool_used{E})'],
  host_cpu_percent: [
    'Server CPU used, percent',
    '100 * (1 - avg by (host) (rate(node_cpu_seconds_total{E,mode="idle"}[5m])))'
  ],
  host_memory_available_percent: [
    'Server memory available, percent',
    '100 * node_memory_MemAvailable_bytes{E} / node_memory_MemTotal_bytes{E}'
  ],
  host_load_15m: ['Server 15-minute load average', 'node_load15{E}'],
  sql_blocked_requests: [
    'SQL Server requests blocked by another session',
    'max(mssql_blocked_requests{E})'
  ],
  sql_longest_block_seconds: [
    'SQL Server longest current block, seconds',
    'max(mssql_longest_block_seconds{E})'
  ],
  sql_deadlocks: [
    'SQL Server deadlocks per 5 minutes',
    'sum(increase(mssql_perf_counter{E,counter="Number of Deadlocks/sec"}[5m]))'
  ],
  sql_batches_per_s: [
    'SQL Server batch requests per second',
    'sum(rate(mssql_perf_counter{E,counter="Batch Requests/sec"}[5m]))'
  ],
  sql_cpu_percent: [
    'CPU on the database host, percent (SQL Server + other)',
    'sum by (source) (mssql_cpu_percent{E})'
  ],
  container_memory_bytes: [
    'Memory per container (top 8)',
    'topk(8, container_memory_working_set_bytes{E,container!=""})'
  ],
  container_cpu_cores: [
    'CPU per container in cores (top 8)',
    'topk(8, rate(container_cpu_usage_seconds_total{E,container!=""}[5m]))'
  ],
  nfs_free_percent: [
    'File share free space, percent',
    '100 * node_filesystem_avail_bytes{E,fstype=~"nfs.*"} / node_filesystem_size_bytes{E,fstype=~"nfs.*"}'
  ],
  // #2544 Phase 5 — per-minute request rollups (traffic-rollups.ts), one point per day, 13 months.
  requests_per_day: [
    'API requests per day (reaches back 13 months)',
    'sum(sum_over_time(nivaro_tm_requests{E,stats_result="n"}[1d]))'
  ],
  errors_5xx_per_day: [
    'API server errors per day (reaches back 13 months)',
    'sum(sum_over_time(nivaro_tm_requests{E,stats_result="e5"}[1d]))'
  ],
  p95_ms_daily: [
    'API p95 response time per day, ms, estimated from latency bands (reaches back 13 months)',
    'histogram_quantile(0.95, sum by (le) (label_replace(sum_over_time(nivaro_tm_latency{E}[1d]), "le", "$1", "stats_result", "le_(.*)")))'
  ]
}

/** Metrics read from the daily rollups: a 13-month reach and one point per day. */
export const ROLLUP_METRICS = new Set(['requests_per_day', 'errors_5xx_per_day', 'p95_ms_daily'])

export function metricExpr(name: string, env: string | null): string {
  const m = METRICS[name]
  if (!m) throw new TelemetryToolError(`metric must be one of: ${Object.keys(METRICS).join(', ')}`)
  const sel = env ? `env=${lq(env)}` : ''
  return m[1].replace(/\{E,/g, sel ? `{${sel},` : '{').replace(/\{E\}/g, sel ? `{${sel}}` : '')
}

// ── Tools ────────────────────────────────────────────────────────────────────

const windowProps = {
  minutes: {
    type: 'integer',
    description:
      'Look back this many minutes from now (default 60, up to 30 days; the *_per_day and *_daily metrics reach 13 months).'
  },
  from: { type: 'string', description: 'Window start, ISO date-time (UTC). Overrides minutes.' },
  to: { type: 'string', description: 'Window end, ISO date-time (UTC). Default now.' }
} as const
const requestProps = {
  route: {
    type: 'string',
    description:
      'Route template "GET /api/items/workflows/:id", or a path pattern "/api/items/workflows/:id" for any method.'
  },
  entity: { type: 'string', description: 'Map node "<lane>/<entity>", e.g. "items/workflows".' },
  caller: { type: 'string', description: 'Caller key: u<USER-UUID>, k<api key id> or anon.' },
  status: { type: 'string', enum: ['5xx', '4xx', 'ok', 'all'] },
  min_ms: { type: 'integer', description: 'Only requests at least this slow (milliseconds).' },
  error_text: {
    type: 'string',
    description: 'Text the logged error must contain (3–200 characters).'
  }
} as const

export const TELEMETRY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'telemetry_status',
    description:
      'The monitoring stack right now: firing alerts, failing uptime checks, collected sources that stopped answering, backup age, disk and file share space, and whether traces and request lines are arriving. Start here for "is anything wrong?".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'request_stats',
    description:
      'Counts and timings of API requests from the request log (weeks of history): requests, server errors (5xx), client errors (4xx), p50 / p95 / max milliseconds — overall, or grouped by route, map node, caller, status or hour. Use for "what was slow / failing between X and Y".',
    input_schema: {
      type: 'object',
      properties: {
        ...windowProps,
        ...requestProps,
        group_by: { type: 'string', enum: ['none', 'route', 'entity', 'caller', 'status', 'hour'] },
        sort: { type: 'string', enum: ['count', 'errors', 'p95'], description: 'Order of groups.' }
      }
    }
  },
  {
    name: 'find_requests',
    description:
      'Individual API requests from the request log: time, route, status, milliseconds, caller key, request id, trace id (when traced) and the logged error. Newest or slowest first.',
    input_schema: {
      type: 'object',
      properties: {
        ...windowProps,
        ...requestProps,
        order: { type: 'string', enum: ['newest', 'slowest'] },
        limit: { type: 'integer', description: 'Up to 30.' }
      }
    }
  },
  {
    name: 'slow_traces',
    description:
      'The slowest (or failed) traced requests in a window, from the traces store: trace id, route, status, milliseconds, time, why it was traced. Follow with get_trace for the breakdown.',
    input_schema: {
      type: 'object',
      properties: {
        ...windowProps,
        route_path: {
          type: 'string',
          description: 'Route pattern without the method, e.g. /api/items/:collection.'
        },
        errors_only: { type: 'boolean' },
        limit: { type: 'integer', description: 'Up to 15.' }
      }
    }
  },
  {
    name: 'get_trace',
    description:
      'One request trace broken down: phases (nested), database round trips and time, the heaviest SQL statements and statements repeated 5+ times (an N+1). Takes a trace id or a request id.',
    input_schema: {
      type: 'object',
      properties: { trace_id: { type: 'string' } },
      required: ['trace_id']
    }
  },
  {
    name: 'metric_series',
    description: `A metric over a window, summarised (min, max, average, last, when it peaked, ~12 sample points). Metrics: ${Object.entries(
      METRICS
    )
      .map(([k, [d]]) => `${k} (${d})`)
      .join('; ')}.`,
    input_schema: {
      type: 'object',
      properties: { ...windowProps, metric: { type: 'string', enum: Object.keys(METRICS) } },
      required: ['metric']
    }
  },
  {
    name: 'search_logs',
    description:
      'Container log lines (application, proxy, web front end, cache, the monitoring stack), newest first: optionally one container, text to contain, errors only. Request-log lines are left out (use the request tools). Tokens and email addresses were removed before storage.',
    input_schema: {
      type: 'object',
      properties: {
        ...windowProps,
        container: {
          type: 'string',
          description: 'e.g. nivaro, proxy, efp_app_staging, nivaro_cache.'
        },
        contains: { type: 'string', description: 'Case-insensitive text (2–200 characters).' },
        errors_only: { type: 'boolean' },
        limit: { type: 'integer', description: 'Up to 40.' }
      }
    }
  }
]

export const TELEMETRY_TOOL_NAMES = new Set(TELEMETRY_TOOLS.map((t) => t.name))

/** #2842 — the telemetry tools plus the read-only infrastructure tools (infra-ai-tools.ts). */
export const ASK_TOOLS: Anthropic.Tool[] = [...TELEMETRY_TOOLS, ...INFRA_TOOLS]
export const ASK_TOOL_NAMES = new Set(ASK_TOOLS.map((t) => t.name))

const r1 = (v: unknown) => Math.round(num(v) * 10) / 10

async function requestStats(input: Record<string, unknown>) {
  const env = storeConfig()?.env ?? null
  const { from, to } = windowOf(input)
  const f = requestFilter(input, env)
  const aggs =
    'count() as n, count() if (status:>=500) as e5, count() if (status:>=400 status:<500) as e4, quantile(0.5, ms) as p50, quantile(0.95, ms) as p95, max(ms) as max_ms'
  const group = String(input.group_by ?? 'none')
  const sortKey = { count: 'n', errors: 'e5', p95: 'p95' }[String(input.sort ?? 'count')] ?? 'n'
  let q: string
  if (group === 'none') q = `${f} | stats ${aggs}`
  else if (group === 'hour') q = `${f} | stats by (_time:1h) ${aggs} | sort by (_time)`
  else if (['route', 'entity', 'caller', 'status'].includes(group))
    q = `${f} | stats by (${group}) ${aggs} | sort by (${sortKey} desc) limit 25`
  else throw new TelemetryToolError('group_by must be none, route, entity, caller, status or hour')
  const rows = await logsQuery(q, from, to)
  return {
    window: { from: iso(from), to: iso(to) },
    groups: rows.map((r) => ({
      ...(group === 'hour'
        ? { hour: iso(storeTime(r._time)) }
        : group !== 'none'
          ? { [group]: r[group] }
          : {}),
      requests: num(r.n),
      server_errors: num(r.e5),
      client_errors: num(r.e4),
      p50_ms: r1(r.p50),
      p95_ms: r1(r.p95),
      max_ms: r1(r.max_ms)
    }))
  }
}

async function findRequests(input: Record<string, unknown>) {
  const env = storeConfig()?.env ?? null
  const { from, to } = windowOf(input)
  const limit = Math.round(optNum(input, 'limit', 1, 30) ?? 15)
  const order = input.order === 'slowest' ? 'ms desc' : '_time desc'
  const rows = await logsQuery(
    `${requestFilter(input, env)} | sort by (${order}) limit ${limit} | fields _time, route, status, ms, caller, rid, tid, err`,
    from,
    to
  )
  return {
    window: { from: iso(from), to: iso(to) },
    requests: rows.map((r: StoreRow) => ({
      at: iso(storeTime(r._time)),
      route: r.route,
      status: num(r.status),
      ms: num(r.ms),
      caller: r.caller,
      request_id: r.rid ?? null,
      trace_id: r.tid ?? null,
      ...(r.err ? { error: scrubText(r.err).slice(0, 300) } : {})
    }))
  }
}

async function slowTraces(input: Record<string, unknown>) {
  const { from, to } = windowOf(input)
  const route = optStr(input, 'route_path', /^\/[^\s]{0,200}$/)
  const rows = await listStoredTraces({
    from,
    to,
    route,
    errorsOnly: input.errors_only === true,
    limit: Math.round(optNum(input, 'limit', 1, 15) ?? 10)
  })
  return { window: { from: iso(from), to: iso(to) }, traces: rows }
}

async function getTraceTool(input: Record<string, unknown>) {
  const id = String(input.trace_id ?? '').trim()
  if (!/^[0-9A-Fa-f-]{32,36}$/.test(id))
    throw new TelemetryToolError('trace_id must be a trace id or request id')
  const t = await loadStoredTrace(id)
  if (!t)
    return {
      found: false,
      note: 'That trace is not in the traces store (only slow, failed, kept and sampled requests are traced; traces are kept 7 days).'
    }
  return { found: true, trace: t }
}

async function metricSeries(input: Record<string, unknown>) {
  const env = storeConfig()?.env ?? null
  const name = String(input.metric ?? '')
  const expr = metricExpr(name, env)
  const daily = ROLLUP_METRICS.has(name)
  const { from, to } = windowOf(input, Date.now(), daily ? ROLLUP_MAX_DAYS : STORE_MAX_DAYS)
  // Daily metrics sum a one-day lookbehind: one point per day so no day is skipped.
  const step = daily ? 86_400 : Math.max(15, Math.round((to - from) / 1000 / 120))
  const series = await metricsRange(expr, from, to, step)
  return {
    metric: name,
    description: METRICS[name][0],
    window: { from: iso(from), to: iso(to) },
    series: series.slice(0, 8).map((s) => {
      const pts = s.points.filter(([, v]) => Number.isFinite(v))
      if (!pts.length) return { labels: s.labels, empty: true }
      let peak = pts[0]
      let lo = pts[0][1]
      let sum = 0
      for (const p of pts) {
        if (p[1] > peak[1]) peak = p
        if (p[1] < lo) lo = p[1]
        sum += p[1]
      }
      const every = Math.max(1, Math.floor(pts.length / 12))
      const label =
        s.labels.container ?? s.labels.host ?? s.labels.source ?? s.labels.mountpoint ?? 'all'
      return {
        series: label,
        min: r1(lo),
        max: r1(peak[1]),
        avg: r1(sum / pts.length),
        last: r1(pts[pts.length - 1][1]),
        peaked_at: iso(peak[0]),
        samples: pts.filter((_, i) => i % every === 0).map(([t, v]) => [iso(t), r1(v)])
      }
    })
  }
}

async function searchLogs(input: Record<string, unknown>) {
  const env = storeConfig()?.env ?? null
  const { from, to } = windowOf(input)
  const container = optStr(input, 'container', CONTAINER_RE)
  const contains = input.contains == null ? '' : String(input.contains).trim()
  if (contains && (contains.length < 2 || contains.length > 200))
    throw new TelemetryToolError('contains must be 2 to 200 characters')
  const limit = Math.round(optNum(input, 'limit', 1, 40) ?? 20)
  const stream = [env ? `env=${lq(env)}` : null, container ? `container=${lq(container)}` : null]
    .filter(Boolean)
    .join(',')
  const parts = [stream ? `{${stream}}` : '*', '-nvr:=api']
  if (contains) parts.push(`i(${lq(contains)})`)
  if (input.errors_only === true)
    parts.push('(level:>=50 or i("error") or i("exception") or i("fatal"))')
  const rows = await logsQuery(
    `${parts.join(' ')} | sort by (_time desc) limit ${limit} | fields _time, container, level, _msg`,
    from,
    to
  )
  return {
    window: { from: iso(from), to: iso(to) },
    lines: rows.map((r) => ({
      at: iso(storeTime(r._time)),
      container: r.container,
      ...(r.level ? { level: r.level } : {}),
      message: scrubText(String(r._msg ?? '')).slice(0, 300)
    }))
  }
}

async function stackStatus() {
  const { telemetryStatus } = await import('./telemetry-status.js')
  const s = await telemetryStatus()
  return {
    firing_alerts: s.stack.alerts.items,
    failing_uptime_checks: s.stack.uptime.items.filter((u) => !u.ok),
    uptime_checks_total: s.stack.uptime.items.length,
    sources_not_answering: s.stack.targets.items.filter((t) => !t.up),
    backups: s.stack.backups.items,
    space_low: s.stack.space.items.filter((d) => d.free_pct < 25),
    arrival_last_hour: {
      request_lines: s.arrival.access_lines_1h,
      traces: s.arrival.traces_1h
    },
    errors: Object.fromEntries(
      Object.entries(s.stack)
        .filter(([, v]) => v.error)
        .map(([k, v]) => [k, v.error])
    )
  }
}

/** Run one telemetry tool. Throws TelemetryToolError for bad input (shown to the model). */
export async function executeTelemetryTool(
  name: string,
  input: Record<string, unknown>,
  ctx: InfraToolContext = {}
): Promise<unknown> {
  // Infrastructure tools read Docker / the proxy directly and work without the telemetry store.
  if (INFRA_TOOL_NAMES.has(name)) return executeInfraTool(name, input, ctx)
  if (!storeConfig())
    throw new TelemetryToolError('The telemetry store is not configured on this instance')
  switch (name) {
    case 'telemetry_status':
      return stackStatus()
    case 'request_stats':
      return requestStats(input)
    case 'find_requests':
      return findRequests(input)
    case 'slow_traces':
      return slowTraces(input)
    case 'get_trace':
      return getTraceTool(input)
    case 'metric_series':
      return metricSeries(input)
    case 'search_logs':
      return searchLogs(input)
    default:
      throw new TelemetryToolError(`Unknown telemetry tool ${name}`)
  }
}

/** A tool result as text for the model: capped, never throwing. */
export function toolResultText(result: unknown): string {
  const s = JSON.stringify(result)
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}… (cut)` : s
}

// ── Asking ───────────────────────────────────────────────────────────────────

export const TELEMETRY_PROMPT = `You answer operations questions about this Nivaro instance for an administrator, using the telemetry tools: request log (weeks), request traces (7 days; slow, failed, kept and sampled requests), metrics (13 months), container logs and the monitoring stack's status, plus the infrastructure tools (Docker hosts, swarm, proxy, host health).

Rules:
- Every claim comes from a tool result. If the tools cannot show it, say what you checked and what is missing. Never guess numbers.
- Start broad (telemetry_status, request_stats) and narrow down (find_requests, slow_traces, get_trace, metric_series, search_logs). Compare a problem window with a normal one when it helps.
- Times are UTC; write them as ISO times or "14:05 UTC".
- Cite evidence: trace ids in backticks (\`trace 4b66…\` with the full id), routes in backticks.
- When a trace shows a repeated statement (5+ calls) call it an N+1; when database time is a small part of the request, say the time went elsewhere.
- Be brief: a two-line answer first, then the evidence as a short list, then what to do next. No preamble.

${INFRA_PROMPT}`

export interface AskTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface TelemetryAnswer {
  answer: string
  /** Traces the tools returned (with route, duration and status when known), for links. */
  traces: CitedTrace[]
  tools: Array<{ tool: string; ok: boolean }>
  model: string
}

export interface CitedTrace {
  id: string
  route: string | null
  ms: number | null
  status: number | null
}

/** Collect the traces a tool result mentions, with what it said about them (for links). */
export function collectTraces(result: unknown, out: Map<string, CitedTrace>): void {
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    if (typeof v !== 'object') return
    const o = v as Record<string, unknown>
    const id =
      typeof o.trace_id === 'string' ? o.trace_id : typeof o.tid === 'string' ? o.tid : null
    if (id && /^[0-9a-f]{32}$/.test(id)) {
      const prev = out.get(id)
      const route =
        typeof o.route === 'string'
          ? `${typeof o.method === 'string' && !o.route.includes(' ') ? `${o.method} ` : ''}${o.route}`
          : null
      const ms = Number.isFinite(Number(o.total_ms ?? o.ms)) ? Number(o.total_ms ?? o.ms) : null
      const status = Number.isFinite(Number(o.status)) ? Number(o.status) : null
      out.set(id, {
        id,
        route: prev?.route ?? route,
        ms: prev?.ms ?? ms,
        status: prev?.status ?? status
      })
    }
    for (const x of Object.values(o)) if (x && typeof x === 'object') walk(x, depth + 1)
  }
  walk(result, 0)
}

type Client = {
  messages: {
    create: (args: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>
  }
}

export class TelemetryAskError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export async function askTelemetry(
  question: string,
  _asker: User,
  opts: {
    history?: AskTurn[]
    client?: Client
    signal?: AbortSignal
    redis?: InfraToolContext['redis']
  } = {}
): Promise<TelemetryAnswer> {
  const q = question.trim()
  if (q.length < 3 || q.length > 1000)
    throw new TelemetryAskError(400, 'Ask a question of 3 to 1,000 characters')
  if (!storeConfig() && !infraAvailable())
    throw new TelemetryAskError(
      409,
      'The telemetry store and Docker hosts are not configured on this instance'
    )
  const client = (opts.client ?? (await getAiClient())) as Client | null
  if (!client) throw new TelemetryAskError(503, 'AI is not configured on this instance')
  const model = (await getAiModelSettings()).chatModel
  const history = (opts.history ?? [])
    .filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-6)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }))
  const convo: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: `${q}\n\n(Now: ${new Date().toISOString()})` }
  ]
  const traces = new Map<string, CitedTrace>()
  const tools: TelemetryAnswer['tools'] = []
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (opts.signal?.aborted) throw new TelemetryAskError(499, 'Cancelled')
    let res: Anthropic.Message
    try {
      res = await client.messages.create({
        model,
        max_tokens: 1200,
        system: TELEMETRY_PROMPT,
        tools: ASK_TOOLS,
        messages: convo
      })
    } catch (err) {
      throw new TelemetryAskError(
        502,
        `The AI provider failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (res.stop_reason !== 'tool_use') {
      return {
        answer: text || 'I could not find an answer to that.',
        traces: [...traces.values()].slice(0, 12),
        tools,
        model
      }
    }
    convo.push({ role: 'assistant', content: res.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue
      try {
        if (!ASK_TOOL_NAMES.has(block.name))
          throw new TelemetryToolError(`Unknown tool ${block.name}`)
        const out = await executeTelemetryTool(
          block.name,
          (block.input ?? {}) as Record<string, unknown>,
          { redis: opts.redis }
        )
        collectTraces(out, traces)
        results.push({ type: 'tool_result', tool_use_id: block.id, content: toolResultText(out) })
        tools.push({ tool: block.name, ok: true })
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: err instanceof Error ? err.message.slice(0, 300) : 'failed',
          is_error: true
        })
        tools.push({ tool: block.name, ok: false })
      }
    }
    convo.push({ role: 'user', content: results })
  }
  return {
    answer:
      'That needed more steps than I allow for one question. Try a narrower window or a more specific question.',
    traces: [...traces.values()].slice(0, 12),
    tools,
    model
  }
}

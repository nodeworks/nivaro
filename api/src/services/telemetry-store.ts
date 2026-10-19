// api/src/services/telemetry-store.ts
/**
 * The long-history telemetry store (#2544): a VictoriaLogs instance (behind vmauth) that keeps
 * the request log for weeks after nivaro_api_logs prunes it at 14 days.
 *
 * How rows get there: with TELEMETRY_ACCESS_LOG=on, plugins/api-logger.ts writes one structured
 * line per logged request (`nvr: "api"`, see `accessLogLine`) to the process log; the host's
 * collector ships container output to the store. Nothing here writes to the store.
 *
 * Reading: TELEMETRY_STORE_URL (vmauth, e.g. http://efp_obs_vmauth:8427) + TELEMETRY_STORE_TOKEN
 * (its READ token — query paths only) + TELEMETRY_STORE_ENV (the `env` label this instance's
 * lines carry, so staging and production never mix). Server to server only: every query is
 * built here from typed parameters, values quoted with `lq()`; nothing a page sends is ever
 * passed through as query text.
 *
 * Off in cloud mode: the store has no tenant labels, so one tenant could read another's history.
 */
import { callerKeyFor, classifyRequest, entityKey, routeTemplate } from './traffic-entities.js'

/** nivaro_api_logs keeps this many days; older windows need the store. */
export const LOCAL_LOG_DAYS = 14
/** How far back the store is asked to answer (its own retention decides what is really there). */
export const STORE_MAX_DAYS = 31

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_ROWS = 10_000

export interface StoreConfig {
  url: string
  token: string | null
  env: string | null
  timeoutMs: number
}

const cloud = () => !!process.env.CLOUD_META_DB_URL

/** The store's settings, or null when it is not configured (or in cloud mode). */
export function storeConfig(): StoreConfig | null {
  if (cloud()) return null
  const url = process.env.TELEMETRY_STORE_URL?.trim().replace(/\/+$/, '')
  if (!url || !/^https?:\/\//i.test(url)) return null
  const t = Number(process.env.TELEMETRY_STORE_TIMEOUT_MS)
  return {
    url,
    token: process.env.TELEMETRY_STORE_TOKEN?.trim() || null,
    env: process.env.TELEMETRY_STORE_ENV?.trim() || null,
    timeoutMs: Number.isFinite(t) && t >= 1000 ? Math.min(t, 120_000) : DEFAULT_TIMEOUT_MS
  }
}

export const storeEnabled = (): boolean => storeConfig() !== null

/** Whether this process writes one access line per logged request (TELEMETRY_ACCESS_LOG=on). */
export function accessLogEnabled(): boolean {
  return !cloud() && /^(on|true|1)$/i.test(process.env.TELEMETRY_ACCESS_LOG?.trim() ?? '')
}

// ── LogsQL building ──────────────────────────────────────────────────────────

/** A LogsQL quoted string literal. */
export function lq(value: string): string {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

/** A regular expression that matches `text` literally, case-insensitively (SQL LIKE's way). */
export function containsRe(text: string): string {
  return `(?i)${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
}

/** The filter every request-log query starts with: this instance's env + access lines only. */
export function baseFilter(env: string | null): string {
  return `${env ? `{env=${lq(env)}} ` : ''}nvr:=api`
}

/** Step as a LogsQL duration (`3600s`). */
export const stepDur = (stepS: number): string => `${Math.max(60, Math.round(stepS))}s`

// ── Reading ──────────────────────────────────────────────────────────────────

export type StoreRow = Record<string, string>

/** Parse VictoriaLogs' newline-delimited JSON answer. Lines that do not parse are skipped. */
export function parseNdjson(body: string): StoreRow[] {
  const out: StoreRow[] = []
  for (const line of body.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const v = JSON.parse(s)
      if (v && typeof v === 'object') out.push(v as StoreRow)
    } catch {
      // a partial last line on a cut-off answer
    }
    if (out.length >= MAX_ROWS) break
  }
  return out
}

export class StoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreUnavailableError'
  }
}

/** The injectable transport (tests swap it). */
export type StoreFetch = (url: string, init: RequestInit) => Promise<Response>
let transport: StoreFetch = (url, init) => fetch(url, init)
export function setStoreFetchForTests(f: StoreFetch | null): void {
  transport = f ?? ((url, init) => fetch(url, init))
}

/**
 * Run one LogsQL query over [from, to) (epoch ms). `query` is built by this module's callers
 * from `baseFilter`, `lq` and fixed pipes — never from request text.
 */
export async function logsQuery(
  query: string,
  from: number,
  to: number,
  opts: { limit?: number; signal?: AbortSignal; store?: 'logs' | 'traces' } = {}
): Promise<StoreRow[]> {
  const cfg = storeConfig()
  if (!cfg) throw new StoreUnavailableError('The telemetry store is not configured')
  const params = new URLSearchParams({
    query,
    start: new Date(from).toISOString(),
    end: new Date(to).toISOString()
  })
  if (opts.limit) params.set('limit', String(Math.min(opts.limit, MAX_ROWS)))
  const timeout = AbortSignal.timeout(cfg.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let res: Response
  try {
    // vmauth serves the traces store under a /traces prefix (same LogsQL API).
    const prefix = opts.store === 'traces' ? '/traces' : ''
    res = await transport(`${cfg.url}${prefix}/select/logsql/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {})
      },
      body: params.toString(),
      signal
    })
  } catch (err) {
    throw new StoreUnavailableError(
      `The telemetry store did not answer (${err instanceof Error ? err.name : 'error'})`
    )
  }
  if (!res.ok) {
    throw new StoreUnavailableError(`The telemetry store answered ${res.status}`)
  }
  return parseNdjson(await res.text())
}

export interface MetricSample {
  labels: Record<string, string>
  value: number
}

/**
 * One instant MetricsQL query against the metrics store (VictoriaMetrics, through vmauth's read
 * path). `expr` is a fixed expression from this codebase — never request text.
 */
export async function metricsQuery(expr: string, signal?: AbortSignal): Promise<MetricSample[]> {
  const cfg = storeConfig()
  if (!cfg) throw new StoreUnavailableError('The telemetry store is not configured')
  const timeout = AbortSignal.timeout(cfg.timeoutMs)
  let res: Response
  try {
    res = await transport(`${cfg.url}/api/v1/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {})
      },
      body: new URLSearchParams({ query: expr }).toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
  } catch (err) {
    throw new StoreUnavailableError(
      `The metrics store did not answer (${err instanceof Error ? err.name : 'error'})`
    )
  }
  if (!res.ok) throw new StoreUnavailableError(`The metrics store answered ${res.status}`)
  const body = (await res.json()) as {
    data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> }
  }
  return (body.data?.result ?? []).map((r) => ({
    labels: r.metric ?? {},
    value: Number(r.value?.[1])
  }))
}

// Access lines this process wrote since it started (the telemetry page's egress figure).
let accessLines = 0
const accessSince = new Date().toISOString()
export function noteAccessLine(): void {
  accessLines++
}
export function accessLineStats(): { written: number; since: string } {
  return { written: accessLines, since: accessSince }
}

/** Epoch ms of a store `_time` value (RFC 3339), or NaN. */
export const storeTime = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN)

// ── Status ───────────────────────────────────────────────────────────────────

export interface StoreStatus {
  configured: boolean
  access_log: boolean
  env: string | null
  reachable: boolean | null
  latency_ms: number | null
  /** The oldest access line the store still holds (ISO), when it answered. */
  oldest: string | null
  error: string | null
}

let statusCache: { at: number; value: StoreStatus } | null = null

/** Whether the store is set up and answering, and how far back it reaches (cached 5 minutes). */
export async function storeStatus(nowMs = Date.now()): Promise<StoreStatus> {
  const cfg = storeConfig()
  const base: StoreStatus = {
    configured: !!cfg,
    access_log: accessLogEnabled(),
    env: cfg?.env ?? null,
    reachable: null,
    latency_ms: null,
    oldest: null,
    error: null
  }
  if (!cfg) return base
  if (statusCache && nowMs - statusCache.at < 5 * 60_000) return statusCache.value
  const t0 = Date.now()
  try {
    const rows = await logsQuery(
      `${baseFilter(cfg.env)} | stats min(_time) as oldest`,
      nowMs - STORE_MAX_DAYS * 86_400_000,
      nowMs
    )
    const oldest = rows[0]?.oldest
    base.reachable = true
    base.oldest = oldest && Number.isFinite(storeTime(oldest)) ? oldest : null
  } catch (err) {
    base.reachable = false
    base.error = err instanceof Error ? err.message : 'unavailable'
  }
  base.latency_ms = Date.now() - t0
  statusCache = { at: nowMs, value: base }
  return base
}

export function resetStoreStatusForTests(): void {
  statusCache = null
}

// ── Writing (the access line) ────────────────────────────────────────────────

export interface AccessLogInput {
  method: string
  path: string
  status: number
  latency_ms: number
  user: string | null
  api_key_id: number | null
  auth: string | null
  collection: string | null
  error: string | null
  graphql_operation?: string | null
  graphql_kind?: string | null
  request_id?: string | null
  chain_id?: string | null
  instance: string
  /** The request's trace went to the telemetry stack (trace-export.ts): link the line to it. */
  traced?: boolean
}

/**
 * The fields of one access line: what the history features filter and group by. Ids, route
 * templates, status and timings only — no query string, body, address or user agent. The error
 * text is the same capped message nivaro_api_logs keeps (cut to 300 characters); the collector
 * removes tokens and email addresses before storage as a second guard.
 */
export function accessLogLine(r: AccessLogInput): Record<string, string | number | boolean> {
  const c = classifyRequest({
    method: r.method,
    path: r.path,
    graphqlOperation: r.graphql_operation ?? null,
    graphqlKind: (r.graphql_kind as never) ?? null
  })
  const line: Record<string, string | number | boolean> = {
    nvr: 'api',
    method: r.method,
    route: routeTemplate(r.method, r.path, r.graphql_operation ?? null),
    entity: c ? entityKey(c.lane, c.entity) : 'other/api',
    caller: callerKeyFor({ authMethod: r.auth, apiKeyId: r.api_key_id, userId: r.user }),
    status: r.status,
    ms: r.latency_ms,
    inst: r.instance
  }
  if (r.collection) line.coll = r.collection
  if (r.graphql_operation) line.gql = r.graphql_operation
  if (r.request_id) {
    line.rid = r.request_id
    // The W3C trace id (the request id's hex digits), only when the trace was sent.
    if (r.traced) line.tid = r.request_id.replace(/-/g, '').toLowerCase()
  }
  if (r.chain_id) line.chain = r.chain_id
  if (r.error) line.err = r.error.slice(0, 300)
  return line
}

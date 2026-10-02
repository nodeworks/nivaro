// api/src/services/traffic-inspect/request.ts
/**
 * Traffic Map drill-down, group "request" (#1190 #1191 #1202 #1207 #1213): the inspect sources
 *
 *   request   [uuid]        one API call — its log row, caller, trace summary, neighbours
 *   trace     [uuid]        the kept phase waterfall + statements of one call
 *   statement [sha1]        one statement shape — text, plan-cache stats, routes, index advice
 *   compare   [rid1,rid2]   two calls side by side
 *   capture   [uuid]        a "Capture next" arm and what it caught
 *
 * Request rows come from nivaro_api_logs by request_id (migration 389). Traces, statement shapes
 * and captures are per API process (memory) — every answer says when something lives elsewhere.
 */
import { randomUUID } from 'node:crypto'
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { errorText, reasonWithoutSql } from '../../lib/db-refusal.js'
import { INTERNAL_DISPATCH_HEADER, internalDispatchTokens } from '../../plugins/api-logger.js'
import { instanceKey } from '../instance-key.js'
import { INSTANCE_ID } from '../instance-roster.js'
import { getTrace, type TraceRecord, traceConfig, unaccountedMs } from '../request-trace.js'
import { maskBodySecrets } from '../secret-mask.js'
import { callerKeyFor, classifyRequest, entityKey, routeTemplate } from '../traffic-entities.js'
import { type InspectCtx, registerInspectSource } from '../traffic-inspect.js'
import { chainForGraphqlRequest, inspectBook } from './request-capture.js'
import {
  type CompareSide,
  diffCompare,
  isRequestId,
  isStatementSha,
  parseCompareId,
  recordRefFromPath,
  routeLogFilter,
  statementSha,
  statementTables,
  UUID_RE
} from './request-logic.js'
import { statementShapeOf } from './request-statements.js'

/** API log retention (plugins/api-logger.ts RETENTION_DAYS). */
export const LOG_RETENTION_DAYS = 14
/** A request this fresh with no log row is probably still in the logger's batch. */
export const PENDING_MS = 60_000
export const NEIGHBOUR_WINDOW_MS = 5_000
export const NEIGHBOUR_MAX = 20

const INSTANCE = instanceKey().slice(0, 60)

// ─── Log rows ────────────────────────────────────────────────────────────────

export interface RequestRow {
  id: number
  request_id: string | null
  method: string
  path: string
  query: string | null
  status: number
  latency_ms: number
  created_at: string | null
  auth: string | null
  ip: string | null
  user_agent: string | null
  error: string | null
  request_body: string | null
  /** Where the body shown came from: the log (token / API-key writes) or a running capture. */
  body_source: 'log' | 'capture' | null
  body_note: string | null
  graphql: {
    operation: string | null
    kind: string | null
    depth: number | null
    selections: number | null
    errors: number | null
    deprecated: string | null
  } | null
  instance: string | null
  chain_id: string | null
  chain_parent: string | null
  user: string | null
  api_key_id: number | null
  caller: { key: string; label: string; kind: 'api_key' | 'user' | 'anonymous' }
  route: string
  entity: string | null
  record: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
const numOrNull = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const strOrNull = (v: unknown): string | null => (v == null || v === '' ? null : String(v))

function shapeRow(r: Record<string, unknown>): RequestRow {
  const method = String(r.method ?? 'GET')
  const path = String(r.path ?? '')
  const op = strOrNull(r.graphql_operation)
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
  const apiKeyId = numOrNull(r.api_key_id)
  const user = strOrNull(r.user)
  const caller: RequestRow['caller'] =
    apiKeyId != null
      ? {
          key: `k${apiKeyId}`,
          label: strOrNull(r.api_key_name) ?? `API key #${apiKeyId}`,
          kind: 'api_key'
        }
      : user
        ? {
            key: callerKeyFor({ userId: user }),
            label: name || strOrNull(r.email) || 'A person',
            kind: 'user'
          }
        : { key: 'anon', label: 'Anonymous', kind: 'anonymous' }
  const c = classifyRequest({
    method,
    path,
    graphqlOperation: op,
    graphqlKind: strOrNull(r.graphql_kind)
  })
  const hasGql = r.graphql_operation != null || r.graphql_kind != null
  const body = strOrNull(r.request_body)
  return {
    id: Number(r.id),
    request_id: strOrNull(r.request_id),
    method,
    path,
    query: strOrNull(r.query),
    status: Number(r.status ?? 0),
    latency_ms: Number(r.latency_ms ?? 0),
    created_at: iso(r.created_at),
    auth: strOrNull(r.auth),
    ip: strOrNull(r.ip),
    user_agent: strOrNull(r.user_agent),
    error: strOrNull(r.error),
    request_body: body ? maskBodySecrets(body) : null,
    body_source: body ? 'log' : null,
    body_note: null,
    graphql: hasGql
      ? {
          operation: op,
          kind: strOrNull(r.graphql_kind),
          depth: numOrNull(r.graphql_depth),
          selections: numOrNull(r.graphql_selections),
          errors: numOrNull(r.graphql_errors),
          deprecated: strOrNull(r.graphql_deprecated)
        }
      : null,
    instance: strOrNull(r.instance),
    chain_id: r.chain_id ? String(r.chain_id).toLowerCase() : null,
    chain_parent: strOrNull(r.chain_parent),
    user,
    api_key_id: apiKeyId,
    caller,
    route: routeTemplate(method, path, op),
    entity: c ? entityKey(c.lane, c.entity) : null,
    record: recordRefFromPath(path)
  }
}

function rowQuery() {
  return db('nivaro_api_logs as l')
    .leftJoin('nivaro_users as u', 'u.id', 'l.user')
    .leftJoin('nivaro_api_keys as k', 'k.id', 'l.api_key_id')
    .select('l.*', 'u.first_name', 'u.last_name', 'u.email', 'k.name as api_key_name')
}

export interface FoundRow {
  row: RequestRow
  matched_by: 'request_id' | 'chain_time' | 'time'
}

/**
 * The log row of request `rid`. Falls back, for the root `/graphql` alias (its row carries the
 * chain id but no request id — the map's event names the inner dispatch), to the /graphql row of
 * the same chain within ±2 s, else to the only request-id-less /graphql row within ±2 s of `at`.
 */
export async function findRequestRow(rid: string, at: number | null): Promise<FoundRow | null> {
  if (!isRequestId(rid) || !(await hasColumn('nivaro_api_logs', 'request_id'))) return null
  const id = rid.toLowerCase()
  const direct = (await rowQuery().where('l.request_id', id).first()) as
    | Record<string, unknown>
    | undefined
  if (direct) return { row: shapeRow(direct), matched_by: 'request_id' }

  const chain = chainForGraphqlRequest(id)
  if (chain && UUID_RE.test(chain.chainId) && (await hasColumn('nivaro_api_logs', 'chain_id'))) {
    const t = chain.at
    const r = (await rowQuery()
      .whereIn('l.path', ['/graphql', '/api/graphql'])
      .where('l.chain_id', chain.chainId)
      .whereBetween('l.created_at', [new Date(t - 2000), new Date(t + 2000)])
      .orderBy('l.id', 'desc')
      .first()) as Record<string, unknown> | undefined
    if (r) return { row: shapeRow(r), matched_by: 'chain_time' }
  }
  if (at != null) {
    const rows = (await rowQuery()
      .where('l.path', '/graphql')
      .whereNull('l.request_id')
      .whereBetween('l.created_at', [new Date(at - 2000), new Date(at + 2000)])
      .limit(2)) as Array<Record<string, unknown>>
    if (rows.length === 1) return { row: shapeRow(rows[0]), matched_by: 'time' }
  }
  return null
}

/** The same caller's other requests within ±5 s of `row` (max 20, oldest first). */
async function neighboursOf(row: RequestRow): Promise<
  Array<{
    request_id: string | null
    method: string
    path: string
    status: number
    latency_ms: number
    created_at: string | null
    route: string
  }>
> {
  if (!row.created_at) return []
  const t = Date.parse(row.created_at)
  const q = db('nivaro_api_logs as l')
    .whereBetween('l.created_at', [
      new Date(t - NEIGHBOUR_WINDOW_MS),
      new Date(t + NEIGHBOUR_WINDOW_MS)
    ])
    .whereNot('l.id', row.id)
  if (row.api_key_id != null) void q.where('l.api_key_id', row.api_key_id)
  else if (row.user) void q.where('l.user', row.user)
  else if (row.ip) void q.whereNull('l.user').where('l.ip', row.ip)
  else return []
  const withRid = await hasColumn('nivaro_api_logs', 'request_id')
  const withOp = await hasColumn('nivaro_api_logs', 'graphql_operation')
  const rows = (await q
    .select(
      'l.method',
      'l.path',
      'l.status',
      'l.latency_ms',
      'l.created_at',
      ...(withRid ? ['l.request_id'] : []),
      ...(withOp ? ['l.graphql_operation'] : [])
    )
    .orderBy('l.created_at', 'asc')
    .limit(NEIGHBOUR_MAX)) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    request_id: r.request_id ? String(r.request_id).toLowerCase() : null,
    method: String(r.method),
    path: String(r.path),
    status: Number(r.status),
    latency_ms: Number(r.latency_ms),
    created_at: iso(r.created_at),
    route: routeTemplate(String(r.method), String(r.path), strOrNull(r.graphql_operation))
  }))
}

// ─── Traces ──────────────────────────────────────────────────────────────────

export interface TraceAbsence {
  kept: false
  code: 'fast' | 'other_instance' | 'evicted' | 'unknown'
  reason: string
}

/** Why `rid` has no trace on this process, as a sentence. */
export function traceAbsence(row: RequestRow | null): TraceAbsence {
  const cfg = traceConfig()
  if (row?.instance && row.instance !== INSTANCE)
    return {
      kept: false,
      code: 'other_instance',
      reason: `Served by instance "${row.instance}" — a trace, if one was kept, lives on that instance's API process.`
    }
  if (row && row.latency_ms >= cfg.slow_ms)
    return {
      kept: false,
      code: 'evicted',
      reason: `Slow enough to trace (${row.latency_ms} ms), but this API process no longer holds it — it keeps the last ${cfg.capacity} traces — or another process of this instance served it.`
    }
  if (row)
    return {
      kept: false,
      code: 'fast',
      reason: `Not kept — requests under ${cfg.slow_ms} ms are not traced. Use "Trace next call" to keep the next one.`
    }
  return {
    kept: false,
    code: 'unknown',
    reason:
      'No trace on this API process. Fast requests are not traced, and traces live only on the process that served the call.'
  }
}

function traceSummary(t: TraceRecord) {
  const slowest = t.spans.length > 0 ? t.spans.reduce((a, b) => (b.ms > a.ms ? b : a)) : null
  return {
    kept: true as const,
    total_ms: t.total_ms,
    queries: t.queries,
    sql_ms: t.sql_ms,
    spans: t.spans.length,
    statements: t.top_sql.length,
    slowest_phase: slowest ? { phase: slowest.phase, ms: slowest.ms } : null,
    unaccounted_ms: unaccountedMs(t)
  }
}

function traceDetail(t: TraceRecord) {
  return {
    ...t,
    unaccounted_ms: unaccountedMs(t),
    top_sql: t.top_sql.map((s, index) => ({
      ...s,
      index,
      sha: statementSha(s.sql),
      select: /^\s*select\b/i.test(s.sql),
      truncated: s.sql.endsWith('…')
    }))
  }
}

// ─── Index advice (reuses GET /api/index-advisor) ────────────────────────────

interface Suggestion {
  table: string
  column: string
  rows: number
  reasons: string[]
  create_sql: string
}
let adviceCache: { at: number; list: Suggestion[] } | null = null
const ADVICE_TTL_MS = 5 * 60_000

async function indexAdvice(ctx: InspectCtx): Promise<Suggestion[] | null> {
  if (adviceCache && Date.now() - adviceCache.at < ADVICE_TTL_MS) return adviceCache.list
  const server = (ctx.req as unknown as { server?: { inject?: unknown } }).server as
    | {
        inject(opts: {
          method: string
          url: string
          headers: Record<string, string>
        }): Promise<{ statusCode: number; json(): unknown }>
      }
    | undefined
  if (!server?.inject) return null
  const token = randomUUID()
  internalDispatchTokens.add(token)
  try {
    const h = ctx.req.headers
    const headers: Record<string, string> = { [INTERNAL_DISPATCH_HEADER]: token }
    if (typeof h.authorization === 'string') headers.authorization = h.authorization
    if (typeof h.cookie === 'string') headers.cookie = h.cookie
    const res = await server.inject({ method: 'GET', url: '/api/index-advisor', headers })
    if (res.statusCode !== 200) return null
    const data = (res.json() as { data?: { suggestions?: Suggestion[] } | Suggestion[] })?.data
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.suggestions)
        ? data.suggestions
        : []
    adviceCache = { at: Date.now(), list }
    return list
  } catch {
    return null
  } finally {
    internalDispatchTokens.delete(token)
  }
}

function sentence(err: unknown): string {
  const text = errorText(err, 600)
  const cut = text.indexOf(' — while running:')
  return reasonWithoutSql(cut >= 0 ? text.slice(0, cut) : text) || 'The plan could not be read'
}

// ─── Sources ─────────────────────────────────────────────────────────────────

async function requestDetail(rid: string, ctx: InspectCtx) {
  const found = await findRequestRow(rid, ctx.at)
  const trace = getTrace(rid.toLowerCase()) ?? getTrace(rid)
  const base = { rid: rid.toLowerCase(), node: INSTANCE_ID, instance: INSTANCE }
  if (!found) {
    const age = ctx.at != null ? Date.now() - ctx.at : null
    const pending = age == null || age < PENDING_MS
    const old = age != null && age > LOG_RETENTION_DAYS * 86_400_000
    return {
      ...base,
      pending,
      missing: pending
        ? null
        : old
          ? `Older than API log retention (${LOG_RETENTION_DAYS} days).`
          : 'Not in the API log — an internal dispatch, a path the log skips (health, version, traffic-map polling), or a log batch that never flushed.',
      matched_by: null,
      row: null,
      trace: trace ? traceSummary(trace) : traceAbsence(null),
      neighbours: [],
      captured: capturedFor(rid)
    }
  }
  const row = found.row
  if (!row.request_body) {
    const cap = capturedFor(rid)
    if (cap?.body) {
      row.request_body = cap.body
      row.body_source = 'capture'
    } else if (cap?.body_note) row.body_note = cap.body_note
  }
  return {
    ...base,
    pending: false,
    missing: null,
    matched_by: found.matched_by,
    row,
    trace: trace ? traceSummary(trace) : traceAbsence(row),
    neighbours: await neighboursOf(row).catch(() => []),
    captured: capturedFor(rid)
  }
}

function capturedFor(rid: string) {
  const c = inspectBook().captured(rid)
  return c
    ? { arm: c.armId, body: c.entry.body ?? null, body_note: c.entry.body_note ?? null }
    : null
}

registerInspectSource({
  kind: 'request',
  validId: isRequestId,
  async peek(id, ctx) {
    const found = await findRequestRow(id, ctx.at)
    if (!found) {
      const t = getTrace(id.toLowerCase())
      return t
        ? {
            title: `${t.method} ${t.url.split('?')[0]}`,
            lines: [`${t.status} · ${t.total_ms} ms`, 'Not logged yet']
          }
        : { title: 'Request', lines: ['Not in the API log (yet)'] }
    }
    const r = found.row
    return {
      title: `${r.method} ${r.path}`,
      lines: [`${r.status} · ${r.latency_ms} ms`, r.caller.label],
      at: r.created_at
    }
  },
  detail: (id, ctx) => requestDetail(id, ctx)
})

registerInspectSource({
  kind: 'trace',
  validId: isRequestId,
  async peek(id) {
    const t = getTrace(id.toLowerCase())
    if (!t) return { title: 'Trace', lines: ['Not kept on this API process'] }
    const s = traceSummary(t)
    return {
      title: `${t.method} ${t.route}`,
      lines: [
        `${t.total_ms} ms · ${t.queries} queries · ${t.sql_ms} ms SQL`,
        s.slowest_phase ? `Slowest: ${s.slowest_phase.phase} ${s.slowest_phase.ms} ms` : 'No phases'
      ],
      at: t.ts
    }
  },
  async detail(id, ctx) {
    const cfg = traceConfig()
    const t = getTrace(id.toLowerCase())
    const base = { rid: id.toLowerCase(), node: INSTANCE_ID, instance: INSTANCE, config: cfg }
    if (t) return { ...base, kept: true, trace: traceDetail(t) }
    const found = await findRequestRow(id, ctx.at).catch(() => null)
    const why = traceAbsence(found?.row ?? null)
    return {
      ...base,
      kept: false,
      code: why.code,
      reason: why.reason,
      route: found?.row.route ?? null,
      caller: found?.row.caller ?? null
    }
  }
})

registerInspectSource({
  kind: 'statement',
  validId: isStatementSha,
  async peek(id) {
    const s = statementShapeOf(id)
    if (!s) return { title: 'Statement', lines: ['Not seen in a kept trace on this API process'] }
    return {
      title: s.text.slice(0, 80),
      lines: [
        `avg ${s.avg_ms} ms · ${s.calls} runs in ${s.traces} traces`,
        `${s.routes.length} routes`
      ]
    }
  },
  async detail(id, ctx) {
    const s = statementShapeOf(id)
    if (!s) return null
    const tables = statementTables(s.text)
    let plan: { source: 'cache' | 'estimated'; plan: string | null; stats: unknown } | null = null
    let planNote: string | null = null
    if (s.truncated)
      planNote = 'The statement was cut when it was captured — too long to look up a plan.'
    else {
      try {
        const { planForStatement } = await import('../custom-query-exec.js')
        if (/^\s*select\b/i.test(s.text)) plan = await planForStatement(s.text, s.bindings)
        else planNote = 'Plans are looked up for SELECT statements only.'
      } catch (err) {
        planNote = sentence(err)
      }
    }
    const advice = tables.length > 0 ? await indexAdvice(ctx) : []
    return {
      ...s,
      node: INSTANCE_ID,
      tables,
      plan,
      plan_note: planNote,
      advice:
        advice == null
          ? null
          : advice.filter((a) => tables.includes(String(a.table ?? '').toLowerCase())).slice(0, 10)
    }
  }
})

function compareSide(found: FoundRow | null, rid: string): CompareSide & { rid: string } {
  const t = getTrace(rid.toLowerCase())
  return {
    rid: rid.toLowerCase(),
    status: found?.row.status ?? t?.status ?? null,
    latency_ms: found?.row.latency_ms ?? t?.total_ms ?? null,
    query:
      found?.row.query ?? (t?.url.includes('?') ? t.url.slice(t.url.indexOf('?') + 1) : null),
    trace: t ? { total_ms: t.total_ms, spans: t.spans, top_sql: t.top_sql } : null
  }
}

registerInspectSource({
  kind: 'compare',
  validId: (id) => parseCompareId(id) != null,
  async peek(id) {
    const pair = parseCompareId(id)
    if (!pair) return null
    return {
      title: 'Compare two requests',
      lines: [`${pair[0].slice(0, 8)} vs ${pair[1].slice(0, 8)}`]
    }
  },
  async detail(id, ctx) {
    const pair = parseCompareId(id)
    if (!pair) return null
    const [fa, fb] = await Promise.all([
      findRequestRow(pair[0], ctx.at).catch(() => null),
      findRequestRow(pair[1], null).catch(() => null)
    ])
    const sa = compareSide(fa, pair[0])
    const sb = compareSide(fb, pair[1])
    if (!fa && !sa.trace && !fb && !sb.trace) return null
    const ta = getTrace(pair[0].toLowerCase())
    const tb = getTrace(pair[1].toLowerCase())
    return {
      a: {
        rid: sa.rid,
        row: fa?.row ?? null,
        trace: ta ? traceDetail(ta) : null,
        absence: ta ? null : traceAbsence(fa?.row ?? null)
      },
      b: {
        rid: sb.rid,
        row: fb?.row ?? null,
        trace: tb ? traceDetail(tb) : null,
        absence: tb ? null : traceAbsence(fb?.row ?? null)
      },
      diff: diffCompare(sa, sb),
      node: INSTANCE_ID
    }
  }
})

registerInspectSource({
  kind: 'capture',
  validId: (id) => UUID_RE.test(id),
  async peek(id) {
    const v = inspectBook().view(id.toLowerCase())
    if (!v) return { title: 'Capture', lines: ['Expired or never armed on this API process'] }
    return {
      title: `Capture · ${v.entries.length} of ${v.total}`,
      lines: [[v.spec.route, v.spec.caller, v.spec.entity].filter(Boolean).join(' · ')]
    }
  },
  async detail(id) {
    const v = inspectBook().view(id.toLowerCase())
    if (!v) return null
    return {
      ...v,
      node: INSTANCE_ID,
      entries: v.entries.map((e) => ({
        rid: e.rid,
        at: e.at,
        ms: e.ms,
        route: e.route,
        method: e.method,
        path: e.path,
        status: e.status,
        node: e.node,
        query: e.query ?? null,
        has_body: typeof e.body === 'string' && e.body.length > 0,
        body_bytes: typeof e.body === 'string' ? e.body.length : 0,
        body_note: e.body_note ?? null
      }))
    }
  }
})

/**
 * The same route's other recent requests (last hour, newest first, ≤ 20) — the "Compare with…"
 * picker. Null when `rid` has no log row.
 */
export async function compareCandidates(rid: string, at: number | null) {
  const found = await findRequestRow(rid, at)
  if (!found) return null
  const row = found.row
  const f = routeLogFilter(row.route)
  if (!f) return { route: row.route, candidates: [] }
  const withOp = await hasColumn('nivaro_api_logs', 'graphql_operation')
  const q = db('nivaro_api_logs as l')
    .where('l.created_at', '>=', new Date(Date.now() - 3600_000))
    .where('l.method', f.method)
    .whereNotNull('l.request_id')
    .whereNot('l.request_id', rid.toLowerCase())
  if (f.pathExact) void q.where('l.path', f.pathExact)
  if (f.pathLike) void q.where('l.path', 'like', f.pathLike)
  if (f.operation && withOp) void q.where('l.graphql_operation', f.operation)
  const rows = (await q
    .select(
      'l.request_id',
      'l.method',
      'l.path',
      'l.status',
      'l.latency_ms',
      'l.created_at',
      'l.user',
      'l.api_key_id',
      ...(withOp ? ['l.graphql_operation'] : [])
    )
    .orderBy('l.created_at', 'desc')
    .limit(200)) as Array<Record<string, unknown>>
  const candidates = rows
    .filter(
      (r) =>
        routeTemplate(String(r.method), String(r.path), strOrNull(r.graphql_operation)) ===
        row.route
    )
    .slice(0, 20)
    .map((r) => ({
      request_id: String(r.request_id).toLowerCase(),
      path: String(r.path),
      status: Number(r.status),
      latency_ms: Number(r.latency_ms),
      created_at: iso(r.created_at),
      same_caller:
        (row.api_key_id != null && Number(r.api_key_id) === row.api_key_id) ||
        (row.user != null && String(r.user ?? '').toUpperCase() === row.user.toUpperCase()),
      traced: getTrace(String(r.request_id).toLowerCase()) != null
    }))
  return { route: row.route, candidates }
}

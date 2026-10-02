// api/src/services/traffic-inspect/entities-caller.ts
/**
 * Inspect source `caller` (#1199): one caller of the API — an API key (`k12`), a person or
 * machine account (`u<UUID>`), a background source (`cron:<job>`, `flow:<id>`, `import:*`) or one
 * of the map's aggregate buckets (`cron`, `anon`).
 *
 * Detail: who it is, its requests in the window from the API log grouped by route and status,
 * error rate, p95, refused credentials, the key's scopes / rate limit / IP allowlist, open
 * circuit breakers on it, and the recent requests (each with its request id when the log row
 * carries one). Field dependencies are heavy (a 14-day log scan) and load on their own route.
 */
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { parseRefusal } from '../../routes/api-analytics.js'
import { callerDependencies } from '../partner-dependencies.js'
import { activeBreakers } from '../traffic-breaker.js'
import type { InspectCtx, InspectPeek } from '../traffic-inspect.js'
import {
  bucketCounts,
  type CallerRef,
  dependencyKeyOf,
  jsonArray,
  type LogRow,
  parseCallerKey,
  rangeFor,
  summarizeRequests
} from './entities-logic.js'

/** Most API-log rows one caller panel reads (newest first). */
export const CALLER_ROW_CAP = 5000
const RECENT = 30
const SERIES_POINTS = 30
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const personName = (u: { first_name?: unknown; last_name?: unknown; email?: unknown }) =>
  `${String(u.first_name ?? '')} ${String(u.last_name ?? '')}`.trim() ||
  String(u.email ?? '').split('@')[0] ||
  null

async function logRows(c: CallerRef, from: Date, to: Date): Promise<LogRow[] | null> {
  if (c.kind !== 'key' && c.kind !== 'person') return null
  const withRid = await hasColumn('nivaro_api_logs', 'request_id').catch(() => false)
  const q = db('nivaro_api_logs')
    .where('created_at', '>=', from)
    .where('created_at', '<=', to)
    .orderBy('created_at', 'desc')
    .limit(CALLER_ROW_CAP)
    .select(
      'method',
      'path',
      'status',
      'latency_ms',
      'created_at',
      'graphql_operation',
      'auth',
      'error'
    )
  if (withRid) q.select('request_id')
  if (c.kind === 'key') q.where('api_key_id', c.apiKeyId).where('auth', 'api_key')
  else
    q.whereIn('user', [c.userId, c.userId.toLowerCase()]).where((b) => {
      b.whereNull('auth').orWhereNot('auth', 'api_key')
    })
  return (await q) as LogRow[]
}

async function keyInfo(id: number) {
  const k = (await db('nivaro_api_keys')
    .where('id', id)
    .first(
      'id',
      'name',
      'prefix',
      'user',
      'scopes',
      'scope_restrictions',
      'rate_limit_per_minute',
      'ip_allowlist',
      'expires_at',
      'last_used_at',
      'is_active',
      'sandbox',
      'graphql_max_depth',
      'created_at'
    )
    .catch(() => null)) as Record<string, unknown> | null | undefined
  if (!k) return null
  let owner: { id: string; name: string | null } | null = null
  if (typeof k.user === 'string' && UUID.test(k.user)) {
    const u = (await db('nivaro_users')
      .where('id', k.user)
      .first('id', 'first_name', 'last_name', 'email')
      .catch(() => null)) as Record<string, unknown> | null | undefined
    owner = { id: String(k.user).toUpperCase(), name: u ? personName(u) : null }
  }
  return {
    id: Number(k.id),
    name: String(k.name ?? `API key ${id}`),
    prefix: k.prefix ? String(k.prefix) : null,
    owner,
    scopes: jsonArray(k.scopes),
    scope_restrictions: jsonArray(k.scope_restrictions),
    rate_limit_per_minute: k.rate_limit_per_minute == null ? null : Number(k.rate_limit_per_minute),
    ip_allowlist: (jsonArray(k.ip_allowlist) ?? []).map(String),
    expires_at: k.expires_at ?? null,
    last_used_at: k.last_used_at ?? null,
    active: k.is_active === true || k.is_active === 1,
    sandbox: k.sandbox === true || k.sandbox === 1,
    graphql_max_depth: k.graphql_max_depth == null ? null : Number(k.graphql_max_depth)
  }
}

async function personInfo(userId: string) {
  const u = (await db('nivaro_users as u')
    .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
    .where('u.id', userId)
    .first(
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.title',
      'u.department',
      'u.status',
      'u.account_kind',
      'u.last_access',
      'u.is_out_of_office',
      'r.name as role_name'
    )
    .catch(() => null)) as Record<string, unknown> | null | undefined
  if (!u) return null
  return {
    id: String(u.id).toUpperCase(),
    name: personName(u),
    email: u.email ? String(u.email) : null,
    title: u.title ? String(u.title) : null,
    department: u.department ? String(u.department) : null,
    status: u.status ? String(u.status) : null,
    account_kind: u.account_kind ? String(u.account_kind) : null,
    role: u.role_name ? String(u.role_name) : null,
    last_access: u.last_access ?? null,
    out_of_office: u.is_out_of_office === true || u.is_out_of_office === 1
  }
}

/** Recent runs behind a background source (`cron:<job>` → job runs, `flow:<id>` → flow runs). */
async function sourceRuns(c: Extract<CallerRef, { kind: 'source' }>) {
  if (c.source === 'cron') {
    const rows = (await db('nivaro_job_runs')
      .where('job_id', c.ref)
      .orderBy('id', 'desc')
      .limit(15)
      .select('id', 'label', 'status', 'started_at', 'duration_ms', 'trigger_kind', 'error')
      .catch(() => [])) as Array<Record<string, unknown>>
    return {
      kind: 'job' as const,
      label: rows.find((r) => r.label)?.label ?? null,
      runs: rows.map((r) => ({
        id: String(r.id),
        status: String(r.status ?? ''),
        at: r.started_at ?? null,
        ms: r.duration_ms == null ? null : Number(r.duration_ms),
        note: r.trigger_kind ? String(r.trigger_kind) : null,
        error: r.error ? String(r.error).slice(0, 200) : null
      }))
    }
  }
  if (c.source === 'flow' && UUID.test(c.ref)) {
    const [flow, rows] = await Promise.all([
      db('nivaro_flows')
        .where('id', c.ref)
        .first('id', 'name')
        .catch(() => null) as Promise<Record<string, unknown> | null | undefined>,
      db('nivaro_flow_runs')
        .where('flow', c.ref)
        .orderBy('started_at', 'desc')
        .limit(15)
        .select('id', 'status', 'started_at', 'duration_ms', 'trigger', 'error_message')
        .catch(() => []) as Promise<Array<Record<string, unknown>>>
    ])
    return {
      kind: 'flow' as const,
      label: flow?.name ?? null,
      runs: rows.map((r) => ({
        id: String(r.id),
        status: String(r.status ?? ''),
        at: r.started_at ?? null,
        ms: r.duration_ms == null ? null : Number(r.duration_ms),
        note: r.trigger ? String(r.trigger) : null,
        error: r.error_message ? String(r.error_message).slice(0, 200) : null
      }))
    }
  }
  return null
}

function sourceNote(c: CallerRef): string | null {
  if (c.kind === 'cron')
    return 'Every request a cron job or flow made through the API, grouped as one caller. Pick the job in the map to see one of them.'
  if (c.kind === 'anon')
    return 'Requests that carried no credential (public forms, sign-in, health checks).'
  if (c.kind !== 'source') return null
  if (c.source === 'cron') return 'A scheduled job. Its runs are listed below; each opens the run.'
  if (c.source === 'flow') return 'A flow. Its runs are listed below; each opens the run.'
  if (c.source === 'import') return 'The staged-import worker. Its runs live in the Import Console.'
  if (c.source === 'socket')
    return 'Browser socket connections; they make no API requests of their own.'
  return 'A background source; it makes no API requests of its own, so the API log holds nothing for it.'
}

export async function callerDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  const c = parseCallerKey(id)
  if (!c) return null
  const range = rangeFor(ctx.at, ctx.windowSec)
  const from = new Date(range.from)
  const to = new Date(range.to)
  const [rows, key, person, runs] = await Promise.all([
    logRows(c, from, to),
    c.kind === 'key' ? keyInfo(c.apiKeyId) : Promise.resolve(null),
    c.kind === 'person' ? personInfo(c.userId) : Promise.resolve(null),
    c.kind === 'source' ? sourceRuns(c) : Promise.resolve(null)
  ])
  if (c.kind === 'key' && !key && !rows?.length) return null
  const summary = rows ? summarizeRequests(rows, 20) : null
  const failures = new Map<
    string,
    { code: string; status: number; message: string | null; n: number }
  >()
  for (const r of rows ?? []) {
    const s = Number(r.status)
    if (s !== 401 && s !== 403 && s !== 429) continue
    const p = parseRefusal(r.error, s)
    const g = failures.get(p.code)
    if (g) g.n++
    else failures.set(p.code, { code: p.code, status: s, message: p.message, n: 1 })
  }
  const label =
    key?.name ??
    person?.name ??
    (c.kind === 'cron' ? 'Crons & flows' : c.kind === 'anon' ? 'Unauthenticated' : null) ??
    (c.kind === 'source' ? (runs?.label ? String(runs.label) : c.key) : c.key)
  return {
    key: c.key,
    kind: c.kind === 'person' && person?.account_kind ? 'machine' : c.kind,
    label,
    note: sourceNote(c),
    range: { from: range.from, to: range.to },
    logged: rows != null,
    truncated: (rows?.length ?? 0) >= CALLER_ROW_CAP,
    summary,
    series: rows
      ? bucketCounts(
          rows.map((r) => r.created_at),
          range.from,
          range.to,
          SERIES_POINTS
        )
      : null,
    auth_failures: [...failures.values()].sort((a, b) => b.n - a.n),
    recent: (rows ?? []).slice(0, RECENT).map((r) => ({
      at: r.created_at,
      method: String(r.method ?? 'GET').toUpperCase(),
      path: String(r.path ?? ''),
      status: Number(r.status) || 0,
      ms: Number(r.latency_ms) || 0,
      request_id: r.request_id ? String(r.request_id) : null
    })),
    request_ids_logged: await hasColumn('nivaro_api_logs', 'request_id').catch(() => false),
    key_info: key,
    person,
    runs,
    breakers: activeBreakers()
      .filter((b) => b.kind === 'caller' && b.target.toUpperCase() === c.key.toUpperCase())
      .map((b) => ({
        mode: b.mode,
        limit: b.limit,
        until: b.until,
        reason: b.reason,
        by_name: b.by_name
      })),
    has_dependencies: dependencyKeyOf(c) != null
  }
}

export async function callerPeek(id: string, ctx: InspectCtx): Promise<InspectPeek | null> {
  const c = parseCallerKey(id)
  if (!c) return null
  if (c.kind === 'key') {
    const k = await keyInfo(c.apiKeyId)
    return {
      title: k?.name ?? `API key ${c.apiKeyId}`,
      lines: [
        k ? (k.active ? 'API key · active' : 'API key · revoked') : 'API key (no longer exists)',
        k?.rate_limit_per_minute ? `Limit ${k.rate_limit_per_minute}/min` : 'No per-key rate limit'
      ]
    }
  }
  if (c.kind === 'person') {
    const p = await personInfo(c.userId)
    return {
      title: p?.name ?? 'Unknown user',
      lines: [p?.role ?? 'No role', p?.email ?? ''].filter(Boolean)
    }
  }
  void ctx
  return { title: c.key, lines: [sourceNote(c) ?? ''].filter(Boolean) }
}

/** Fields, endpoints and operations a caller depends on (partner-dependencies, 14 days). */
export async function callerDependencySummary(id: string): Promise<unknown | null> {
  const c = parseCallerKey(id)
  const depKey = c ? dependencyKeyOf(c) : null
  if (!depKey) return null
  const dep = await callerDependencies(depKey)
  if (!dep) return { found: false }
  return {
    found: true,
    partner: dep.partner,
    calls: dep.calls,
    first_seen: dep.first_seen,
    last_seen: dep.last_seen,
    collections: dep.collections.slice(0, 40).map((col) => ({
      collection: col.collection,
      calls: col.calls,
      read_all: col.read_all,
      read: col.read.slice(0, 60).map((f) => f.field),
      written: col.written.slice(0, 60).map((f) => f.field)
    })),
    endpoints: dep.endpoints.slice(0, 20),
    operations: dep.operations
      .slice(0, 20)
      .map((o) => ({ name: o.name, kind: o.kind, calls: o.calls, errors: o.errors })),
    evidence: dep.evidence
  }
}

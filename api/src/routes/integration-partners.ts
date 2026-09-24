/**
 * Integrations console — partner health cards, partner detail and staged
 * import health (spec 2026-09-23, Task 7).
 *
 * Distinct from `integration-signals.ts`, which surfaces PROBLEMS across the
 * whole registry: this is the per-partner OVERVIEW — success rate, latency,
 * an hourly grid, and what the record already says about it (owner, contract
 * status, obligation counts) — read straight from `nivaro_outbound_log`
 * (Task 3's always-on counter row per call) rather than any signal snapshot.
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { selectInChunks } from '../services/db-batch.js'
import { endpointEnvironment } from '../services/endpoint-environment.js'
import { maskHeaders, mockConfigFor, resolveInstanceRow } from '../services/external-apis.js'
import { isAuthFailure } from '../services/integration-signals-core.js'
import { maskBodySecrets } from '../services/secret-mask.js'
import {
  type FactUser,
  type RequesterUser,
  toRequesterUser
} from '../services/submission-detail.js'

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export function healthWord(i: {
  calls24: number
  failures24: number
  lastOkAt: Date | null
  lastFailAt: Date | null
  authFailing: boolean
}): 'healthy' | 'degraded' | 'failing' | 'idle' {
  if (i.authFailing) return 'failing'
  if (i.calls24 === 0) return 'idle'
  if (i.lastFailAt && (!i.lastOkAt || i.lastFailAt > i.lastOkAt)) return 'failing'
  if (i.failures24 / i.calls24 >= 0.2) return 'degraded'
  return 'healthy'
}

export function hourBuckets(
  calls: Array<{ created_at: Date; ok: boolean }>,
  now: Date,
  hours: number
): Array<{ hour: string; ok: number; failed: number }> {
  const out: Array<{ hour: string; ok: number; failed: number }> = []
  const idx = new Map<string, number>()
  for (let h = hours - 1; h >= 0; h--) {
    const key = new Date(now.getTime() - h * 3600_000).toISOString().slice(0, 13)
    idx.set(key, out.length)
    out.push({ hour: key, ok: 0, failed: 0 })
  }
  for (const c of calls) {
    const i = idx.get(new Date(c.created_at).toISOString().slice(0, 13))
    if (i == null) continue
    if (c.ok) out[i].ok++
    else out[i].failed++
  }
  return out
}

// ─── Recent calls (Task 15e) ────────────────────────────────────────────────
// A call's bodies live in `nivaro_external_api_logs` — written only when the
// caller passes `_log` (every core call site does; extension calls only
// since 523205cf). `nivaro_outbound_log` is the counter row written for
// EVERY call regardless, so a call from before that fix — or from any caller
// that still passes no `_log` — has an outbound row and no call-log row. It
// still belongs in the list, just with nothing to open (`source: 'outbound'`,
// no trigger, no body).

export interface CallLogListRow {
  id: number
  created_at: Date | string
  method: string
  url: string
  response_status: number | null
  duration_ms: number | null
  error: string | null
  triggered_by: string | null
  user_id: string | null
  has_body: boolean | number
}

export interface OutboundListRow {
  id: number
  created_at: Date | string
  method: string
  path: string | null
  status: number | null
  ok: boolean | number
  duration_ms: number | null
  error: string | null
}

export interface PartnerCallListItem {
  /** Stable React key — `id` alone can collide across the two source tables. */
  key: string
  id: number
  source: 'log' | 'outbound'
  created_at: string
  method: string | null
  path: string | null
  status: number | null
  ok: boolean
  duration_ms: number | null
  error: string | null
  triggered_by: string | null
  has_body: boolean
  /** Resolved the SAME way the push drill-down resolves a requester — a
   *  suspended/redacted/machine account carries its `inactive`/`account_kind`
   *  facts here too, not just a bare name. */
  user: RequesterUser | null
}

/** The stored `url` reduced to what the list shows — a plain path (+ query),
 *  falling back to the raw string (capped) for anything that isn't a real
 *  URL rather than dropping it. */
export function pathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}` || '/'
  } catch {
    return url.length > 300 ? `${url.slice(0, 300)}…` : url
  }
}

const httpOk = (status: number | null): boolean => status != null && status >= 200 && status < 300

/** Coarse deliberately, per spec: two independent calls that land in the
 *  exact same second with neither carrying a call-log row of its own would
 *  collapse to one outbound entry here — accepted as the cost of a cheap,
 *  reliable match with no shared identifier to key on. */
const sameSecond = (a: Date | string, b: Date | string): boolean =>
  Math.floor(+new Date(a) / 1000) === Math.floor(+new Date(b) / 1000)

/**
 * Newest-first merge of the two logs for one partner. Every call-log row
 * appears with its full facts; an outbound row is added only when nothing in
 * `logs` shares its second, so a partner whose calls have always carried
 * `_log` never shows a phantom "outbound" duplicate of a row it already has.
 */
export function mergeCallHistory(
  logs: CallLogListRow[],
  outbound: OutboundListRow[],
  users: FactUser[]
): PartnerCallListItem[] {
  // Same resolution the push drill-down uses (`toRequesterUser`) — a
  // suspended or machine account on a call carries the same `inactive`/
  // `account_kind` facts here as it does on a `Requester` elsewhere in the
  // console, instead of a bare name that hides it.
  const userOf = (id: string | null): PartnerCallListItem['user'] => {
    if (!id) return null
    const u = users.find((x) => x.id === id)
    return u ? toRequesterUser(u) : null
  }
  const fromLogs: PartnerCallListItem[] = logs.map((l) => ({
    key: `log:${l.id}`,
    id: l.id,
    source: 'log',
    created_at: new Date(l.created_at).toISOString(),
    method: l.method,
    path: pathFromUrl(l.url),
    status: l.response_status,
    ok: httpOk(l.response_status),
    duration_ms: l.duration_ms,
    error: l.error,
    triggered_by: l.triggered_by,
    has_body: !!l.has_body,
    user: userOf(l.user_id)
  }))
  const fromOutbound: PartnerCallListItem[] = outbound
    .filter((o) => !logs.some((l) => sameSecond(l.created_at, o.created_at)))
    .map((o) => ({
      key: `outbound:${o.id}`,
      id: o.id,
      source: 'outbound',
      created_at: new Date(o.created_at).toISOString(),
      method: o.method,
      path: o.path,
      status: o.status,
      ok: !!o.ok,
      duration_ms: o.duration_ms,
      error: o.error,
      triggered_by: null,
      has_body: false,
      user: null
    }))
  return [...fromLogs, ...fromOutbound].sort(
    (a, b) => +new Date(b.created_at) - +new Date(a.created_at)
  )
}

const CALLS_WINDOW_DAYS = 14
const CALLS_LIMIT = 200

async function buildCallHistory(apiId: number): Promise<PartnerCallListItem[]> {
  const since = new Date(Date.now() - CALLS_WINDOW_DAYS * 86_400_000)
  const [logs, outbound] = await Promise.all([
    db('nivaro_external_api_logs')
      .where({ api_id: apiId })
      .where('created_at', '>=', since)
      .orderBy('id', 'desc')
      .limit(CALLS_LIMIT)
      .select(
        'id',
        'created_at',
        'method',
        'url',
        'response_status',
        'duration_ms',
        'error',
        'triggered_by',
        'user_id',
        db.raw(
          'CASE WHEN request_body IS NOT NULL OR response_body IS NOT NULL THEN 1 ELSE 0 END as has_body'
        )
      ) as Promise<CallLogListRow[]>,
    db('nivaro_outbound_log')
      .where({ api_id: apiId })
      .where('created_at', '>=', since)
      .orderBy('id', 'desc')
      .limit(CALLS_LIMIT)
      .select(
        'id',
        'created_at',
        'method',
        'path',
        'status',
        'ok',
        'duration_ms',
        'error'
      ) as Promise<OutboundListRow[]>
  ])
  const userIds = [...new Set(logs.map((l) => l.user_id).filter((v): v is string => !!v))]
  const users = userIds.length
    ? ((await selectInChunks(userIds, 500, (chunk) =>
        db('nivaro_users')
          .whereIn('id', chunk)
          .select('id', 'first_name', 'last_name', 'email', 'status', 'is_redacted', 'account_kind')
      )) as FactUser[])
    : []
  return mergeCallHistory(logs, outbound, users)
}

/** `null`/unparsable in, `null` out — never throws on a corrupt or absent
 *  stored headers column. */
function parseHeadersColumn(v: string | null | undefined): Record<string, string> | null {
  if (!v) return null
  try {
    const parsed: unknown = JSON.parse(v)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : null
  } catch {
    return null
  }
}

/** Re-masks on every read — a row stored before a masking fix (or by a
 *  caller that ever bypasses one) must never hand a secret back regardless
 *  of what actually landed in the column. */
function maskStoredHeaders(v: string | null | undefined): Record<string, string> | null {
  const parsed = parseHeadersColumn(v)
  return parsed ? maskHeaders(parsed) : null
}

interface CallLogFullRow {
  id: number
  created_at: Date | string
  method: string
  url: string
  request_headers: string | null
  request_body: string | null
  response_status: number | null
  response_headers: string | null
  response_body: string | null
  duration_ms: number | null
  error: string | null
  triggered_by: string | null
  user_id: string | null
}

// Mirrors the private `AuthType` union in services/external-apis.ts — needed
// only so `resolveInstanceRow`'s generic bound is satisfied structurally;
// the column itself is unconstrained free text.
type AuthType = 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2_cc' | 'hmac' | 'aws_sigv4'

type ApiRow = {
  id: number
  name: string
  base_url: string
  auth_type: AuthType
  auth_config: string | null
  headers: string | null
  enabled: boolean | number
  mock_config: string | null
  instance_overrides: string | null
  owner_user: string | null
}

async function buildCards(onlyId?: number) {
  const now = new Date()
  const since7 = new Date(now.getTime() - 7 * 86_400_000)
  const since24 = new Date(now.getTime() - 86_400_000)
  let q = db('nivaro_external_apis').select(
    'id',
    'name',
    'base_url',
    'auth_type',
    'auth_config',
    'headers',
    'enabled',
    'mock_config',
    'instance_overrides',
    'owner_user'
  )
  if (onlyId != null) q = q.where({ id: onlyId })
  const apis = (await q) as ApiRow[]
  const calls = (await db('nivaro_outbound_log')
    .where('created_at', '>=', since7)
    .modify((x) => (onlyId != null ? x.where({ api_id: onlyId }) : x))
    .select('api_id', 'ok', 'status', 'error', 'duration_ms', 'created_at')) as Array<{
    api_id: number
    ok: boolean | number
    status: number | null
    error: string | null
    duration_ms: number
    created_at: Date
  }>
  const obl = (await db('nivaro_integration_obligations')
    .whereNull('resolved_at')
    .orWhere('created_at', '>=', since7)
    .groupBy('api', 'outcome')
    .select('api', 'outcome')
    .count('* as n')) as Array<{ api: string; outcome: string; n: number | string }>
  const owners = (await db('nivaro_users')
    .whereIn('id', apis.map((a) => a.owner_user).filter(Boolean) as string[])
    .select('id', 'first_name', 'last_name')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
  }>
  return apis.map((a) => {
    const mine = calls
      .filter((c) => c.api_id === a.id)
      .sort((x, y) => +new Date(y.created_at) - +new Date(x.created_at))
    const d24 = mine.filter((c) => new Date(c.created_at) >= since24)
    const ok24 = d24.filter((c) => !!c.ok).length
    const ok7 = mine.filter((c) => !!c.ok).length
    const lastOk = mine.find((c) => !!c.ok)
    const lastFail = mine.find((c) => !c.ok)
    const authFailing = !!mine[0] && !mine[0].ok && isAuthFailure(mine[0].status, mine[0].error)
    const durations = d24.map((c) => c.duration_ms).sort((x, y) => x - y)
    const row = resolveInstanceRow({ ...a, enabled: !!a.enabled })
    const counts = { sent: 0, pending: 0, failed: 0, missing: 0, overdue: 0 }
    for (const o of obl)
      if (o.api === a.name && o.outcome in counts)
        counts[o.outcome as keyof typeof counts] = Number(o.n)
    const owner = owners.find((u) => u.id === a.owner_user)
    return {
      id: a.id,
      name: a.name,
      enabled: !!a.enabled,
      health: healthWord({
        calls24: d24.length,
        failures24: d24.length - ok24,
        lastOkAt: lastOk ? new Date(lastOk.created_at) : null,
        lastFailAt: lastFail ? new Date(lastFail.created_at) : null,
        authFailing
      }),
      calls24: d24.length,
      success_pct24: d24.length ? Math.round((ok24 / d24.length) * 1000) / 10 : null,
      success_pct7d: mine.length ? Math.round((ok7 / mine.length) * 1000) / 10 : null,
      p50_ms: percentile(durations, 50),
      p95_ms: percentile(durations, 95),
      last_ok_at: lastOk ? new Date(lastOk.created_at).toISOString() : null,
      last_fail_at: lastFail ? new Date(lastFail.created_at).toISOString() : null,
      last_fail_reason: lastFail
        ? (lastFail.error ?? (lastFail.status != null ? `HTTP ${lastFail.status}` : 'No response'))
        : null,
      hourly: hourBuckets(
        mine.map((c) => ({ created_at: c.created_at, ok: !!c.ok })),
        now,
        48
      ),
      flags: {
        test_endpoint: endpointEnvironment(row.base_url).environment === 'test',
        mock: !!mockConfigFor(a),
        auth_failing: authFailing
      },
      owner: owner
        ? { id: owner.id, name: `${owner.first_name ?? ''} ${owner.last_name ?? ''}`.trim() }
        : null,
      obligations: counts
    }
  })
}

export type PartnerCard = Awaited<ReturnType<typeof buildCards>>[number]

export async function integrationPartnersRoutes(app: FastifyInstance) {
  app.get('/integration-partners', { preHandler: requireAdmin }, async () => {
    const partners = await buildCards()
    const calls24 = partners.reduce((s, p) => s + p.calls24, 0)
    const ok24 = partners.reduce(
      (s, p) => s + (p.success_pct24 != null ? (p.success_pct24 / 100) * p.calls24 : 0),
      0
    )
    return {
      data: {
        summary: {
          calls24,
          success_pct24: calls24 ? Math.round((ok24 / calls24) * 1000) / 10 : null,
          not_healthy: partners.filter((p) => p.health === 'degraded' || p.health === 'failing')
            .length
        },
        partners
      }
    }
  })

  // Registered ahead of `/:id` so this static segment wins the route match.
  // Every definition (inactive ones too — the Import Console's definitions
  // list shows their staleness setting); only active ones can go stale.
  app.get('/integration-partners/imports', { preHandler: requireAdmin }, async () => {
    const { importCadence, isImportStale, resolveThresholds } = await import(
      '../services/integration-signal-settings.js'
    )
    const { getIntegrationSignal } = await import('../services/integration-signals.js')
    const stale = getIntegrationSignal('core:import-stale')
    const th = stale ? (await resolveThresholds(stale)).thresholds : { default_hours: 48 }
    const rows = (await db.raw(
      `SELECT d.[key], d.label, d.is_active,
              (SELECT TOP 1 status FROM nivaro_import_queue q WHERE q.definition = d.id ORDER BY q.id DESC) AS last_status,
              (SELECT MAX(COALESCE(finished_at, started_at, created_at)) FROM nivaro_import_queue q WHERE q.definition = d.id) AS last_run_at,
              (SELECT MAX(finished_at) FROM nivaro_import_queue q WHERE q.definition = d.id AND q.status = 'completed') AS last_ok_at,
              (SELECT COUNT(*) FROM nivaro_import_queue q WHERE q.definition = d.id AND q.status = 'error' AND q.created_at >= DATEADD(day, -7, GETUTCDATE())) AS failures7d
         FROM nivaro_import_definitions d ORDER BY d.sort, d.label`
    )) as Array<{
      key: string
      label: string
      is_active: boolean | number
      last_status: string | null
      last_run_at: Date | null
      last_ok_at: Date | null
      failures7d: number
    }>
    const now = new Date()
    return {
      data: rows.map((r) => {
        // `last_run_at` is any status (never status-filtered) — the last
        // attempt of ANY kind, which is what decides dormancy, not just success.
        const cadence = importCadence(r.key, th, r.last_run_at, now)
        const active = !!r.is_active
        return {
          ...r,
          is_active: active,
          failures7d: Number(r.failures7d),
          cadence_hours: cadence.hours,
          cadence_source: cadence.source,
          stale: active && isImportStale(r.last_ok_at, cadence, now)
        }
      }),
      default_hours: th.default_hours ?? 48
    }
  })

  app.get('/integration-partners/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'Invalid id' })
    }
    const [card] = await buildCards(id)
    if (!card) return reply.code(404).send({ error: 'Not found' })
    const calls = await buildCallHistory(id)
    const contracts = await db('nivaro_external_api_endpoints')
      .where({ api_id: id })
      .whereNotNull('contract')
      .select(
        'id as endpoint_id',
        'name',
        'contract_last_run as last_run',
        'contract_last_ok as ok',
        'contract_last_detail as detail'
      )
      .catch(() => [])
    return { data: { card, calls, contracts } }
  })

  // One call's full request/response — never fetched as part of the list
  // (bodies can run to tens of KB each), only when a row is expanded.
  app.get<{ Params: { id: string; callId: string } }>(
    '/integration-partners/:id/calls/:callId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const callId = Number(req.params.callId)
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(callId) || callId <= 0) {
        return reply.code(400).send({ error: 'Invalid id' })
      }
      // Scoped by (id, api_id) together — a callId belonging to a DIFFERENT
      // partner reads as unknown, never as a row to filter out client-side.
      const row = (await db('nivaro_external_api_logs')
        .where({ id: callId, api_id: id })
        .first()) as CallLogFullRow | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })

      let user: PartnerCallListItem['user'] = null
      if (row.user_id) {
        const u = (await db('nivaro_users')
          .where({ id: row.user_id })
          .first(
            'id',
            'first_name',
            'last_name',
            'email',
            'status',
            'is_redacted',
            'account_kind'
          )) as FactUser | undefined
        if (u) user = toRequesterUser(u)
      }

      return {
        data: {
          id: row.id,
          created_at: row.created_at,
          method: row.method,
          url: row.url,
          request_headers: maskStoredHeaders(row.request_headers),
          request_body: maskBodySecrets(row.request_body),
          response_status: row.response_status,
          response_headers: maskStoredHeaders(row.response_headers),
          response_body: maskBodySecrets(row.response_body),
          duration_ms: row.duration_ms,
          error: row.error,
          triggered_by: row.triggered_by,
          user
        }
      }
    }
  )
}

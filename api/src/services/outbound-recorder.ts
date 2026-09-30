/**
 * Outbound flight recorder (#626) + mock record mode (#604).
 *
 * Two stores, one timeline:
 *   - nivaro_outbound_log — the always-on counter row per partner call
 *     (written by callExternalApi) now also carries the call's detail: url,
 *     endpoint, trigger, redacted headers and bodies. Bodies are blanked after
 *     24 hours; the row stays 31 days (per-API SLOs read it).
 *   - nivaro_outbound_side_log — outbound HTTP that is not a partner call and
 *     must never count toward partner health: token fetches, health probes,
 *     token probes, editor test calls.
 *
 * Everything written here is redacted first (outbound-redaction.ts). Writers
 * never throw and never make a call fail; a database behind migration 382
 * simply records nothing extra.
 */
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'
import {
  buildCurl,
  EMPTY_REDACTION,
  parseRedaction,
  type RedactionRules,
  redactBody,
  redactHeaders,
  redactUrl
} from './outbound-redaction.js'
import { instanceKey } from './settings-overrides.js'

// ─── Per-API redaction rules (60 s cache) ──────────────────────────────────

const redactionCache = new Map<string, { at: number; rules: RedactionRules }>()
const REDACTION_TTL_MS = 60_000

export function bustRedactionCache(apiId?: number): void {
  if (apiId == null) redactionCache.clear()
  else redactionCache.delete(`${getTenantId() ?? ''}\u0000${apiId}`)
}

export async function redactionFor(apiId: number): Promise<RedactionRules> {
  const key = `${getTenantId() ?? ''}\u0000${apiId}`
  const hit = redactionCache.get(key)
  if (hit && Date.now() - hit.at < REDACTION_TTL_MS) return hit.rules
  let rules = EMPTY_REDACTION
  try {
    if (await hasColumn('nivaro_external_apis', 'redaction')) {
      const row = (await db('nivaro_external_apis').where({ id: apiId }).first('redaction')) as
        | { redaction: string | null }
        | undefined
      rules = parseRedaction(row?.redaction ?? null)
    }
  } catch {
    rules = EMPTY_REDACTION
  }
  redactionCache.set(key, { at: Date.now(), rules })
  return rules
}

// ─── Call detail on the counter row ────────────────────────────────────────

export interface CallDetail {
  url?: string | null
  endpoint_id?: number | null
  triggered_by?: string | null
  request_headers?: Record<string, string> | null
  request_body?: string | null
  response_headers?: Record<string, string> | null
  response_body?: string | null
}

/** The detail columns for a nivaro_outbound_log insert — `{}` on a database behind 382. */
export async function outboundDetailFields(
  apiId: number,
  d: CallDetail
): Promise<Record<string, unknown>> {
  try {
    if (!(await hasColumn('nivaro_outbound_log', 'response_body'))) return {}
    const rules = await redactionFor(apiId)
    const h = (x: Record<string, string> | null | undefined) => {
      const r = redactHeaders(x ?? null, rules)
      return r ? JSON.stringify(r) : null
    }
    return {
      url: redactUrl(d.url ?? null, rules)?.slice(0, 2048) ?? null,
      endpoint_id: d.endpoint_id ?? null,
      triggered_by: d.triggered_by ? d.triggered_by.slice(0, 100) : null,
      request_headers: h(d.request_headers),
      request_body: redactBody(d.request_body ?? null, rules),
      response_headers: h(d.response_headers),
      response_body: redactBody(d.response_body ?? null, rules)
    }
  } catch {
    return {}
  }
}

// ─── Side traffic ──────────────────────────────────────────────────────────

export type SideKind = 'token' | 'health' | 'token_probe' | 'test' | 'lookup'

export interface SideCall extends CallDetail {
  api_id: number
  kind: SideKind
  method?: string | null
  status?: number | null
  ok?: boolean
  duration_ms?: number
  error?: string | null
}

/** Write one side-traffic row. Fire-and-forget safe: never throws. */
export async function recordSideCall(c: SideCall): Promise<void> {
  try {
    const rules = await redactionFor(c.api_id)
    const h = (x: Record<string, string> | null | undefined) => {
      const r = redactHeaders(x ?? null, rules)
      return r ? JSON.stringify(r) : null
    }
    await db('nivaro_outbound_side_log').insert({
      api_id: c.api_id,
      kind: c.kind,
      method: (c.method ?? 'GET').toUpperCase().slice(0, 12),
      url: redactUrl(c.url ?? null, rules)?.slice(0, 2048) ?? null,
      status: c.status ?? null,
      ok:
        c.ok ?? (c.status != null && c.status >= 200 && c.status < 300 && !c.error ? true : false),
      duration_ms: Math.max(0, Math.round(c.duration_ms ?? 0)),
      error: c.error ? String(c.error).slice(0, 500) : null,
      triggered_by: c.triggered_by ? c.triggered_by.slice(0, 100) : null,
      request_headers: h(c.request_headers),
      request_body: redactBody(c.request_body ?? null, rules),
      response_headers: h(c.response_headers),
      response_body: redactBody(c.response_body ?? null, rules),
      created_at: new Date()
    })
  } catch {
    /* table not there yet, or the write failed — the call itself is unaffected */
  }
}

// ─── Retention ─────────────────────────────────────────────────────────────

const DAY = 86_400_000
/** Counter rows (and probe rows) — long enough for a 30-day SLO window. */
export const OUTBOUND_RETENTION_DAYS = 31

async function chunked(run: () => Promise<number>, rounds = 20): Promise<number> {
  let total = 0
  for (let i = 0; i < rounds; i++) {
    const n = await run().catch(() => 0)
    total += n
    if (n < 500) break
  }
  return total
}

/**
 * The recorder's retention pass: bodies older than 24 h are blanked (the
 * ring), counter rows older than 31 days deleted, token / test side rows
 * older than 24 h deleted, probe rows older than 31 days deleted. Chunked so
 * a first pass after deploy never times out.
 */
export async function pruneOutboundRecorder(now = Date.now()): Promise<Record<string, number>> {
  const dayAgo = new Date(now - DAY)
  const monthAgo = new Date(now - OUTBOUND_RETENTION_DAYS * DAY)
  const out: Record<string, number> = {}
  out.outbound_deleted = await chunked(() =>
    db('nivaro_outbound_log')
      .whereIn(
        'id',
        db('nivaro_outbound_log').where('created_at', '<', monthAgo).select('id').limit(500)
      )
      .delete()
  )
  if (await hasColumn('nivaro_outbound_log', 'response_body').catch(() => false)) {
    out.outbound_bodies_blanked = await chunked(() =>
      db('nivaro_outbound_log')
        .whereIn(
          'id',
          db('nivaro_outbound_log')
            .where('created_at', '<', dayAgo)
            .where((q) => {
              void q
                .whereNotNull('request_body')
                .orWhereNotNull('response_body')
                .orWhereNotNull('request_headers')
                .orWhereNotNull('response_headers')
            })
            .select('id')
            .limit(500)
        )
        .update({
          request_body: null,
          response_body: null,
          request_headers: null,
          response_headers: null
        })
    )
  }
  try {
    out.side_deleted = await chunked(() =>
      db('nivaro_outbound_side_log')
        .whereIn(
          'id',
          db('nivaro_outbound_side_log')
            .where((q) => {
              void q.where('created_at', '<', monthAgo).orWhere((q2) => {
                void q2
                  .whereIn('kind', ['token', 'test', 'lookup'])
                  .where('created_at', '<', dayAgo)
              })
            })
            .select('id')
            .limit(500)
        )
        .delete()
    )
    out.side_bodies_blanked = await chunked(() =>
      db('nivaro_outbound_side_log')
        .whereIn(
          'id',
          db('nivaro_outbound_side_log')
            .where('created_at', '<', dayAgo)
            .where((q) => {
              void q.whereNotNull('request_body').orWhereNotNull('response_body')
            })
            .select('id')
            .limit(500)
        )
        .update({
          request_body: null,
          response_body: null,
          request_headers: null,
          response_headers: null
        })
    )
  } catch {
    /* side table not there yet */
  }
  return out
}

// ─── Reading the timeline ──────────────────────────────────────────────────

export interface RecorderRow {
  source: 'call' | 'side'
  id: number
  kind: string
  created_at: string
  method: string
  path: string | null
  url: string | null
  status: number | null
  ok: boolean
  duration_ms: number
  error: string | null
  triggered_by: string | null
  endpoint_id: number | null
  has_body: boolean
}

export async function listRecorder(
  apiId: number,
  opts: { hours?: number; kind?: string; failedOnly?: boolean; limit?: number } = {}
): Promise<RecorderRow[]> {
  const hours = Math.min(24 * 31, Math.max(1, Number(opts.hours) || 24))
  const limit = Math.min(1000, Math.max(1, Number(opts.limit) || 300))
  const since = new Date(Date.now() - hours * 3_600_000)
  const detail = await hasColumn('nivaro_outbound_log', 'response_body').catch(() => false)
  const out: RecorderRow[] = []
  const wantCalls = !opts.kind || opts.kind === 'call' || opts.kind === 'mock'
  if (wantCalls) {
    const q = db('nivaro_outbound_log')
      .where({ api_id: apiId })
      .where('created_at', '>=', since)
      .orderBy('id', 'desc')
      .limit(limit)
      .select(
        'id',
        'created_at',
        'method',
        'path',
        'status',
        'ok',
        'duration_ms',
        'error',
        ...(detail
          ? [
              'url',
              'endpoint_id',
              'triggered_by',
              db.raw(
                'CASE WHEN request_body IS NOT NULL OR response_body IS NOT NULL THEN 1 ELSE 0 END as has_body'
              )
            ]
          : [])
      )
    if (opts.failedOnly) q.where((x) => void x.where('ok', false).orWhereNull('status'))
    const rows = (await q.catch(() => [])) as Array<Record<string, unknown>>
    for (const r of rows) {
      const path = (r.path as string | null) ?? null
      const mock = !!path?.endsWith(' [mock]')
      if (opts.kind === 'mock' && !mock) continue
      if (opts.kind === 'call' && mock) continue
      out.push({
        source: 'call',
        id: Number(r.id),
        kind: mock ? 'mock' : 'call',
        created_at: new Date(r.created_at as Date).toISOString(),
        method: String(r.method ?? ''),
        path,
        url: (r.url as string | null) ?? null,
        status: r.status == null ? null : Number(r.status),
        ok: !!r.ok,
        duration_ms: Number(r.duration_ms ?? 0),
        error: (r.error as string | null) ?? null,
        triggered_by: (r.triggered_by as string | null) ?? null,
        endpoint_id: r.endpoint_id == null ? null : Number(r.endpoint_id),
        has_body: Number(r.has_body ?? 0) === 1
      })
    }
  }
  if (!opts.kind || !['call', 'mock'].includes(opts.kind)) {
    const q = db('nivaro_outbound_side_log')
      .where({ api_id: apiId })
      .where('created_at', '>=', since)
      .orderBy('id', 'desc')
      .limit(limit)
      .select(
        'id',
        'kind',
        'created_at',
        'method',
        'url',
        'status',
        'ok',
        'duration_ms',
        'error',
        'triggered_by',
        db.raw(
          'CASE WHEN request_body IS NOT NULL OR response_body IS NOT NULL THEN 1 ELSE 0 END as has_body'
        )
      )
    if (opts.kind) q.where({ kind: opts.kind })
    if (opts.failedOnly) q.where('ok', false)
    const rows = (await q.catch(() => [])) as Array<Record<string, unknown>>
    for (const r of rows) {
      const url = (r.url as string | null) ?? null
      let path: string | null = null
      try {
        path = url ? new URL(url).pathname : null
      } catch {
        path = url
      }
      out.push({
        source: 'side',
        id: Number(r.id),
        kind: String(r.kind),
        created_at: new Date(r.created_at as Date).toISOString(),
        method: String(r.method ?? ''),
        path,
        url,
        status: r.status == null ? null : Number(r.status),
        ok: !!r.ok,
        duration_ms: Number(r.duration_ms ?? 0),
        error: (r.error as string | null) ?? null,
        triggered_by: (r.triggered_by as string | null) ?? null,
        endpoint_id: null,
        has_body: Number(r.has_body ?? 0) === 1
      })
    }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit)
}

function parseObj(v: unknown): Record<string, string> | null {
  if (v == null) return null
  if (typeof v === 'object') return v as Record<string, string>
  try {
    const p = JSON.parse(String(v)) as unknown
    return p && typeof p === 'object' ? (p as Record<string, string>) : null
  } catch {
    return null
  }
}

/** One recorded call with bodies — re-redacted with today's rules — and its curl. */
export async function recorderDetail(
  apiId: number,
  source: 'call' | 'side',
  id: number
): Promise<Record<string, unknown> | null> {
  const table = source === 'call' ? 'nivaro_outbound_log' : 'nivaro_outbound_side_log'
  const row = (await db(table)
    .where({ id, api_id: apiId })
    .first()
    .catch(() => undefined)) as Record<string, unknown> | undefined
  if (!row) return null
  const rules = await redactionFor(apiId)
  const reqHeaders = redactHeaders(parseObj(row.request_headers), rules)
  const resHeaders = redactHeaders(parseObj(row.response_headers), rules)
  const reqBody = redactBody((row.request_body as string | null) ?? null, rules)
  const resBody = redactBody((row.response_body as string | null) ?? null, rules)
  const url = redactUrl((row.url as string | null) ?? null, rules)
  const path = (row.path as string | null) ?? null
  const kind =
    source === 'side' ? String(row.kind) : path?.endsWith(' [mock]') ? 'mock' : ('call' as string)
  return {
    source,
    id: Number(row.id),
    kind,
    created_at: new Date(row.created_at as Date).toISOString(),
    method: row.method,
    path,
    url,
    status: row.status == null ? null : Number(row.status),
    ok: !!row.ok,
    duration_ms: Number(row.duration_ms ?? 0),
    error: row.error ?? null,
    triggered_by: row.triggered_by ?? null,
    endpoint_id: row.endpoint_id == null ? null : Number(row.endpoint_id),
    request_headers: reqHeaders,
    request_body: reqBody,
    response_headers: resHeaders,
    response_body: resBody,
    bodies_expired: reqBody == null && resBody == null && reqHeaders == null,
    curl: url
      ? buildCurl({
          method: String(row.method ?? 'GET'),
          url,
          request_headers: reqHeaders,
          request_body: reqBody
        })
      : null
  }
}

// ─── #604 — mock record mode ───────────────────────────────────────────────

const RECORD_RULE_CAP = 200
const RECORD_BODY_CAP = 64_000
const recordChains = new Map<number, Promise<void>>()

interface MockInstanceLike {
  enabled?: boolean
  record?: boolean
  rules?: Array<Record<string, unknown>>
  fallback?: unknown
}

/** True while this instance records live answers into its mock rules. */
export function mockRecordOn(row: { mock_config?: string | null }, key = instanceKey()): boolean {
  if (!row.mock_config) return false
  try {
    const all = JSON.parse(row.mock_config) as Record<string, MockInstanceLike>
    const m = all?.[key]
    return !!m && !m.enabled && !!m.record
  } catch {
    return false
  }
}

/** Pure: the rule list with this answer upserted (method + exact path). */
export function upsertRecordedRule(
  rules: Array<Record<string, unknown>>,
  answer: { method: string; path: string; status: number; body: unknown },
  at: string = new Date().toISOString()
): Array<Record<string, unknown>> {
  const method = answer.method.toUpperCase()
  const next = rules.filter(
    (r) => !(String(r.method ?? '').toUpperCase() === method && r.path === answer.path)
  )
  // Recorded rules go first so an older wildcard rule never shadows them.
  next.unshift({
    method,
    path: answer.path,
    status: answer.status,
    body: answer.body,
    recorded_at: at
  })
  return next.slice(0, RECORD_RULE_CAP)
}

/**
 * Record one live answer as a mock rule for this instance. Only answers the
 * partner actually gave (status < 500) and bodies under 64 KB; the API's
 * body-path redaction applies. Serialised per API so concurrent calls do not
 * overwrite each other's rules.
 */
export function recordMockAnswer(
  apiId: number,
  answer: { method: string; path: string; status: number; bodyText: string }
): Promise<void> {
  if (answer.status >= 500 || answer.bodyText.length > RECORD_BODY_CAP) return Promise.resolve()
  const prev = recordChains.get(apiId) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      const key = instanceKey()
      const row = (await db('nivaro_external_apis').where({ id: apiId }).first('mock_config')) as
        | { mock_config: string | null }
        | undefined
      if (!row?.mock_config) return
      const all = JSON.parse(row.mock_config) as Record<string, MockInstanceLike>
      const mine = all[key]
      if (!mine || mine.enabled || !mine.record) return
      const rules = await redactionFor(apiId)
      const text =
        redactBody(
          answer.bodyText,
          { headers: [], body_paths: rules.body_paths },
          RECORD_BODY_CAP
        ) ?? ''
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = text
      }
      const current = Array.isArray(mine.rules) ? mine.rules : []
      const method = answer.method.toUpperCase()
      const same = current.find(
        (r) => String(r.method ?? '').toUpperCase() === method && r.path === answer.path
      )
      // Nothing new to learn — skip the config write (it moves the config epoch).
      if (
        same &&
        same.status === answer.status &&
        JSON.stringify(same.body ?? null) === JSON.stringify(body ?? null)
      )
        return
      mine.rules = upsertRecordedRule(current, {
        method: answer.method,
        path: answer.path,
        status: answer.status,
        body
      })
      await db('nivaro_external_apis')
        .where({ id: apiId })
        .update({ mock_config: JSON.stringify({ ...all, [key]: mine }) })
    })
    .catch(() => {})
  recordChains.set(apiId, next)
  void next.finally(() => {
    if (recordChains.get(apiId) === next) recordChains.delete(apiId)
  })
  return next
}

/**
 * External API health probes (#612) and per-API SLOs (#603).
 *
 * Probes: an API with `health_path` set is probed every 5 minutes (the
 * `external-api-health-probes` cron — ticks only on deployed instances; Run
 * now works everywhere) and on demand from its editor. For an oauth2_cc API
 * the token endpoint is probed separately first. Every probe lands on the
 * flight recorder as side traffic (kind `health` / `token_probe`) — never as a
 * partner call, so a probe never moves partner health or failure signals —
 * and the newest verdict is stamped on the API row.
 *
 * SLOs: p50 / p95 latency, error rate and availability per API over a window,
 * read from the counter rows (nivaro_outbound_log, kept 31 days). Availability
 * comes from probes when the API has any in the window, else from calls.
 */
import { db } from '../db/index.js'
import { mockConfigFor, resolveAuth, resolveInstanceRow } from './external-apis.js'
import { recordSideCall } from './outbound-recorder.js'

type AuthType = 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2_cc' | 'hmac' | 'aws_sigv4'

interface ApiRow {
  id: number
  name: string
  base_url: string
  auth_type: AuthType
  auth_config: string | null
  headers: string | null
  enabled: boolean | number
  mock_config?: string | null
  instance_overrides?: string | null
  health_path?: string | null
  health_method?: string | null
  health_expect_status?: number | null
}

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

export interface ProbeResult {
  api_id: number
  api_name: string
  skipped?: string
  token?: { ok: boolean; status: number | null; duration_ms: number; error: string | null }
  health?: {
    ok: boolean
    status: number | null
    expected: number
    duration_ms: number
    error: string | null
  }
  ok: boolean
  detail: string
}

const PROBE_TIMEOUT_MS = 10_000

/** Probe one API now: token endpoint (oauth2_cc) then the health path. */
export async function probeApi(apiId: number, triggeredBy = 'probe'): Promise<ProbeResult> {
  const stored = (await db('nivaro_external_apis').where({ id: apiId }).first()) as
    | ApiRow
    | undefined
  if (!stored) throw new Error('External API not found')
  const out: ProbeResult = { api_id: stored.id, api_name: stored.name, ok: true, detail: '' }
  if (!stored.enabled) return { ...out, skipped: 'disabled', ok: false, detail: 'API is disabled' }
  if (mockConfigFor(stored))
    return { ...out, skipped: 'mocked', ok: false, detail: 'Mock mode is on for this instance' }
  const row = resolveInstanceRow({ ...stored, enabled: !!stored.enabled })
  const cfg = parseJson<Record<string, unknown>>(row.auth_config)
  const hasHealth = !!row.health_path?.trim()
  const isOauth = row.auth_type === 'oauth2_cc'
  if (!hasHealth && !isOauth)
    return { ...out, skipped: 'unconfigured', ok: false, detail: 'No health path set' }

  let authHeaders: Record<string, string> = {}
  let authQuery: Record<string, string> = {}
  const problems: string[] = []

  // Token endpoint first — a dead token endpoint fails every call, and says so
  // more precisely than the health path's 401 would.
  {
    const t0 = Date.now()
    try {
      const a = await resolveAuth(row.auth_type, cfg, {
        apiId: row.id,
        kind: isOauth ? 'token_probe' : 'token',
        triggeredBy
      })
      authHeaders = a.headers
      authQuery = a.queryParams
      if (isOauth) out.token = { ok: true, status: 200, duration_ms: Date.now() - t0, error: null }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isOauth) {
        out.token = { ok: false, status: null, duration_ms: Date.now() - t0, error: msg }
        problems.push(`token endpoint: ${msg}`)
      } else problems.push(msg)
    }
  }

  if (hasHealth && problems.length === 0) {
    const method = (row.health_method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET'
    const expected = Number(row.health_expect_status) || 200
    const path = String(row.health_path).trim()
    let url: URL | null = null
    try {
      url = new URL(row.base_url.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`))
      for (const [k, v] of Object.entries(authQuery)) url.searchParams.set(k, v)
    } catch {
      problems.push(`health path does not form a valid url with ${row.base_url}`)
    }
    if (url) {
      const headers: Record<string, string> = {
        ...(parseJson<Record<string, string>>(row.headers) ?? {}),
        ...authHeaders
      }
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
      const t0 = Date.now()
      let status: number | null = null
      let error: string | null = null
      let text: string | null = null
      const resHeaders: Record<string, string> = {}
      try {
        const res = await fetch(url.toString(), { method, headers, signal: ctl.signal })
        status = res.status
        res.headers.forEach((v, k) => {
          resHeaders[k] = v
        })
        text = method === 'HEAD' ? null : (await res.text()).slice(0, 16_000)
      } catch (err) {
        error =
          err instanceof Error
            ? err.name === 'AbortError'
              ? `Timed out after ${PROBE_TIMEOUT_MS}ms`
              : err.message
            : String(err)
      } finally {
        clearTimeout(timer)
      }
      const duration = Date.now() - t0
      const ok = error == null && status === expected
      if (!ok) error = error ?? `HTTP ${status} (expected ${expected})`
      out.health = { ok, status, expected, duration_ms: duration, error: ok ? null : error }
      if (!ok) problems.push(`health: ${error}`)
      await recordSideCall({
        api_id: row.id,
        kind: 'health',
        method,
        url: url.toString(),
        status,
        ok,
        duration_ms: duration,
        error: ok ? null : error,
        triggered_by: triggeredBy,
        request_headers: headers,
        response_headers: resHeaders,
        response_body: text
      })
    }
  }

  out.ok = problems.length === 0
  out.detail = out.ok
    ? [
        out.token ? `token ${out.token.duration_ms} ms` : null,
        out.health ? `HTTP ${out.health.status} in ${out.health.duration_ms} ms` : null
      ]
        .filter(Boolean)
        .join(' · ')
    : problems.join(' · ')
  await db('nivaro_external_apis')
    .where({ id: row.id })
    .update({
      health_last_ok: out.ok,
      health_last_at: new Date(),
      health_last_detail: out.detail.slice(0, 500)
    })
    .catch(() => {})
  return out
}

/** APIs the probe cron visits: enabled, with a health path, not mocked here. */
export async function healthProbeTargets(): Promise<
  Array<{ id: number; name: string; path: string }>
> {
  const rows = (await db('nivaro_external_apis')
    .where({ enabled: true })
    .whereNotNull('health_path')
    .select('id', 'name', 'health_path', 'mock_config')
    .catch(() => [])) as Array<{
    id: number
    name: string
    health_path: string | null
    mock_config: string | null
  }>
  return rows
    .filter((r) => (r.health_path ?? '').trim() && !mockConfigFor(r))
    .map((r) => ({ id: r.id, name: r.name, path: String(r.health_path) }))
}

/** Probe every target, four at a time. */
export async function runHealthProbes(): Promise<ProbeResult[]> {
  const targets = await healthProbeTargets()
  const results: ProbeResult[] = []
  for (let i = 0; i < targets.length; i += 4) {
    const batch = await Promise.all(
      targets.slice(i, i + 4).map((t) =>
        probeApi(t.id, 'cron').catch(
          (err): ProbeResult => ({
            api_id: t.id,
            api_name: t.name,
            ok: false,
            detail: err instanceof Error ? err.message : String(err)
          })
        )
      )
    )
    results.push(...batch)
  }
  return results
}

// ─── Uptime ────────────────────────────────────────────────────────────────

export interface UptimeBucket {
  at: string
  ok: number
  failed: number
  token_ok: number
  token_failed: number
}

/** Pure: probe rows into `count` buckets of `bucketMs`, oldest first. */
export function uptimeBuckets(
  rows: Array<{ kind: string; ok: boolean | number; created_at: Date | string }>,
  now: number,
  count: number,
  bucketMs: number
): { buckets: UptimeBucket[]; uptime_pct: number | null; probes: number } {
  const start = now - count * bucketMs
  const buckets: UptimeBucket[] = Array.from({ length: count }, (_, i) => ({
    at: new Date(start + i * bucketMs).toISOString(),
    ok: 0,
    failed: 0,
    token_ok: 0,
    token_failed: 0
  }))
  let ok = 0
  let total = 0
  for (const r of rows) {
    const t = new Date(r.created_at).getTime()
    const i = Math.floor((t - start) / bucketMs)
    if (i < 0 || i >= count) continue
    const good = !!r.ok
    if (r.kind === 'token_probe') {
      if (good) buckets[i].token_ok++
      else buckets[i].token_failed++
    } else {
      if (good) buckets[i].ok++
      else buckets[i].failed++
    }
    total++
    if (good) ok++
  }
  return {
    buckets,
    uptime_pct: total ? Math.round((ok / total) * 10000) / 100 : null,
    probes: total
  }
}

/** Probe uptime per API over the last `hours`, hourly buckets. */
export async function apiUptime(
  apiIds: number[],
  hours = 24
): Promise<Map<number, ReturnType<typeof uptimeBuckets>>> {
  const out = new Map<number, ReturnType<typeof uptimeBuckets>>()
  if (!apiIds.length) return out
  const now = Date.now()
  const h = Math.min(24 * 31, Math.max(1, hours))
  const since = new Date(now - h * 3_600_000)
  const rows = (await db('nivaro_outbound_side_log')
    .whereIn('api_id', apiIds)
    .whereIn('kind', ['health', 'token_probe'])
    .where('created_at', '>=', since)
    .select('api_id', 'kind', 'ok', 'created_at')
    .catch(() => [])) as Array<{
    api_id: number
    kind: string
    ok: boolean | number
    created_at: Date
  }>
  const bucketMs = h <= 48 ? 3_600_000 : 86_400_000
  const count = Math.ceil((h * 3_600_000) / bucketMs)
  for (const id of apiIds) {
    out.set(
      id,
      uptimeBuckets(
        rows.filter((r) => Number(r.api_id) === id),
        now,
        count,
        bucketMs
      )
    )
  }
  return out
}

// ─── SLOs ──────────────────────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

export interface SloFigures {
  calls: number
  failed: number
  error_rate: number | null
  p50_ms: number | null
  p95_ms: number | null
  availability: number | null
  availability_source: 'probes' | 'calls' | null
}

/** Pure: SLO figures from call rows (+ probe rows for availability). */
export function sloFigures(
  calls: Array<{ ok: boolean | number; duration_ms: number }>,
  probes: Array<{ ok: boolean | number }> = []
): SloFigures {
  const failed = calls.filter((c) => !c.ok).length
  const durations = calls.map((c) => Number(c.duration_ms) || 0).sort((a, b) => a - b)
  const errorRate = calls.length ? Math.round((failed / calls.length) * 10000) / 100 : null
  let availability: number | null = null
  let source: SloFigures['availability_source'] = null
  if (probes.length) {
    const good = probes.filter((p) => !!p.ok).length
    availability = Math.round((good / probes.length) * 10000) / 100
    source = 'probes'
  } else if (calls.length) {
    availability = Math.round(((calls.length - failed) / calls.length) * 10000) / 100
    source = 'calls'
  }
  return {
    calls: calls.length,
    failed,
    error_rate: errorRate,
    p50_ms: percentile(durations, 50),
    p95_ms: percentile(durations, 95),
    availability,
    availability_source: source
  }
}

const ROW_CAP = 50_000

async function callRows(apiIds: number[] | null, since: Date) {
  const q = db('nivaro_outbound_log')
    .where('created_at', '>=', since)
    .orderBy('id', 'desc')
    .limit(ROW_CAP)
    .select('api_id', 'ok', 'duration_ms', 'created_at')
    // Mocked answers are not the partner's — they never count toward an SLO.
    .where((x) => void x.whereNull('path').orWhere('path', 'not like', '% [mock]'))
  if (apiIds) q.whereIn('api_id', apiIds)
  return (await q.catch(() => [])) as Array<{
    api_id: number
    ok: boolean | number
    duration_ms: number
    created_at: Date
  }>
}

async function probeRows(apiIds: number[] | null, since: Date) {
  const q = db('nivaro_outbound_side_log')
    .where('created_at', '>=', since)
    .whereIn('kind', ['health', 'token_probe'])
    .select('api_id', 'ok', 'created_at')
  if (apiIds) q.whereIn('api_id', apiIds)
  return (await q.catch(() => [])) as Array<{
    api_id: number
    ok: boolean | number
    created_at: Date
  }>
}

/** One API's SLO over `days` (1–30) with a daily trend, oldest day first. */
export async function apiSlo(apiId: number, days = 7) {
  const d = Math.min(30, Math.max(1, Math.round(days)))
  const now = Date.now()
  const since = new Date(now - d * 86_400_000)
  const [calls, probes] = await Promise.all([callRows([apiId], since), probeRows([apiId], since)])
  const trend: Array<{ day: string } & SloFigures> = []
  const dayStart = (t: number) => {
    const x = new Date(t)
    return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
  }
  const first = dayStart(since.getTime())
  for (let t = first; t <= now; t += 86_400_000) {
    const end = t + 86_400_000
    const inDay = <T extends { created_at: Date }>(r: T) => {
      const at = new Date(r.created_at).getTime()
      return at >= t && at < end
    }
    trend.push({
      day: new Date(t).toISOString().slice(0, 10),
      ...sloFigures(calls.filter(inDay), probes.filter(inDay))
    })
  }
  return {
    days: d,
    truncated: calls.length >= ROW_CAP,
    ...sloFigures(calls, probes),
    trend
  }
}

export type SloMetric = 'error_rate' | 'p95_ms' | 'p50_ms' | 'availability' | 'calls'

/**
 * A metric-alert value (#603): `metric` for one API (by id or name) — or
 * every API together when none is named — over the last `windowMinutes`.
 * Null when the window holds no data (the rule is skipped, never resolved).
 */
export async function resolveApiSloMetric(
  metric: SloMetric,
  apiRef: string | number | null,
  windowMinutes = 15
): Promise<number | null> {
  let ids: number[] | null = null
  if (apiRef != null && String(apiRef).trim() !== '') {
    const ref = String(apiRef).trim()
    const row = (await db('nivaro_external_apis')
      .where(/^\d+$/.test(ref) ? { id: Number(ref) } : { name: ref })
      .first('id')) as { id: number } | undefined
    if (!row) return null
    ids = [row.id]
  }
  const since = new Date(Date.now() - Math.min(43_200, Math.max(1, windowMinutes)) * 60_000)
  const [calls, probes] = await Promise.all([
    callRows(ids, since),
    metric === 'availability' ? probeRows(ids, since) : Promise.resolve([])
  ])
  const f = sloFigures(calls, probes)
  switch (metric) {
    case 'error_rate':
      return f.error_rate
    case 'p95_ms':
      return f.p95_ms
    case 'p50_ms':
      return f.p50_ms
    case 'availability':
      return f.availability
    case 'calls':
      return f.calls
    default:
      return null
  }
}

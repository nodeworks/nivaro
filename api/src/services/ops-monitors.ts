import { createHash } from 'node:crypto'
import tls from 'node:tls'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import { startJobRun } from './job-runs.js'
import { notifyUser } from './notification-channels.js'
import type { FastifyInstance } from 'fastify'

/**
 * Ops monitors evaluator. Three check types share one lifecycle: evaluate on
 * the cron tick, record the run (kind 'monitor' in nivaro_job_runs), and on
 * an ok→failing flip raise a deduped nivaro_issues row + notify the creator.
 * Recovery flips last_status back and resolves quietly (the issue stays for
 * triage — resolving it re-arms the alert, same contract as the sweeps).
 */

export interface MonitorRow {
  id: number
  type: 'freshness' | 'deploy_regression' | 'synthetic' | 'journey' | 'ssl_cert'
  name: string
  config: string | null
  state: string | null
  is_active: boolean
  last_status: string
  last_checked_at: Date | null
  last_detail: string | null
  created_by: string | null
}

export interface EvalResult {
  status: 'ok' | 'failing' | 'unknown'
  detail: string
  /** Probe latency etc — lands as the job run's outcome for trend reads. */
  metric?: number
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback
  if (typeof raw === 'object') return raw as T
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return fallback
  }
}

const TIMESTAMP_CANDIDATES = ['date_updated', 'updated_at', 'date_created', 'created_at', 'timestamp', 'created', 'changed']

/** Freshness: newest timestamp in the collection must be within max_age_hours. */
async function evalFreshness(cfg: {
  collection?: string
  timestamp_column?: string
  max_age_hours?: number
}): Promise<EvalResult> {
  const collection = String(cfg.collection ?? '')
  if (!/^[A-Za-z0-9_]+$/.test(collection)) {
    return { status: 'unknown', detail: 'No valid collection configured' }
  }
  const maxAge = Math.max(1, Number(cfg.max_age_hours) || 24)

  let col = cfg.timestamp_column && /^[A-Za-z0-9_]+$/.test(cfg.timestamp_column) ? cfg.timestamp_column : null
  const cols = (await db('information_schema.columns')
    .where('table_name', collection)
    .select('column_name')) as Array<{ column_name: string }>
  const names = new Set(cols.map((c) => c.column_name.toLowerCase()))
  if (names.size === 0) return { status: 'unknown', detail: `Collection ${collection} not found` }
  if (col && !names.has(col.toLowerCase())) {
    return { status: 'unknown', detail: `Column ${col} not on ${collection}` }
  }
  if (!col) col = TIMESTAMP_CANDIDATES.find((c) => names.has(c)) ?? null
  if (!col) return { status: 'unknown', detail: `No timestamp column found on ${collection}` }

  const row = (await db(collection).max({ newest: col }).first()) as { newest?: Date | string | null } | undefined
  if (!row?.newest) return { status: 'failing', detail: `${collection}.${col} has no rows at all` }
  const ageHours = (Date.now() - new Date(row.newest).getTime()) / 3_600_000
  const detail = `Newest ${collection}.${col} is ${ageHours < 48 ? `${ageHours.toFixed(1)}h` : `${(ageHours / 24).toFixed(1)}d`} old (limit ${maxAge}h)`
  return { status: ageHours > maxAge ? 'failing' : 'ok', detail, metric: Math.round(ageHours * 10) / 10 }
}

/** Synthetic: fetch a URL (or own-instance path), expect a status, watch latency. */
async function evalSynthetic(cfg: {
  url?: string
  path?: string
  expect_status?: number
  latency_warn_ms?: number
}): Promise<EvalResult> {
  const base = process.env.PUBLIC_URL || 'http://localhost:3055'
  const target = cfg.url || (cfg.path ? `${base.replace(/\/$/, '')}${cfg.path}` : null)
  if (!target || !/^https?:\/\//i.test(target)) {
    return { status: 'unknown', detail: 'No valid url/path configured' }
  }
  const expect = Number(cfg.expect_status) || 200
  const warnMs = Number(cfg.latency_warn_ms) || 5000
  const began = Date.now()
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(15_000), redirect: 'manual' })
    const ms = Date.now() - began
    if (res.status !== expect) {
      return { status: 'failing', detail: `${target} answered ${res.status} (expected ${expect}) in ${ms}ms`, metric: ms }
    }
    if (ms > warnMs) {
      return { status: 'failing', detail: `${target} answered ${res.status} but took ${ms}ms (limit ${warnMs}ms)`, metric: ms }
    }
    return { status: 'ok', detail: `${res.status} in ${ms}ms`, metric: ms }
  } catch (err) {
    return {
      status: 'failing',
      detail: `${target} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      metric: Date.now() - began
    }
  }
}

interface RouteMetric {
  requests: number
  errorRate: number
  p95: number
}

/** Aggregate api-log metrics for a window, overall + worst routes. */
async function windowMetrics(from: Date, to: Date): Promise<{ overall: RouteMetric; routes: Map<string, RouteMetric> }> {
  const rows = (await db.raw(
    `SELECT [path] AS route,
            COUNT(*) AS n,
            SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS err,
            MAX(latency_ms) AS maxd,
            AVG(CAST(latency_ms AS FLOAT)) AS avgd
     FROM nivaro_api_logs
     WHERE created_at >= ? AND created_at < ?
     GROUP BY [path]`,
    [from, to]
  )) as Array<{ route: string; n: number; err: number; maxd: number; avgd: number }>
  // A true p95 per route needs PERCENTILE_CONT per group; avg + max bound it
  // well enough for regression detection — we compare the SAME statistic
  // across two windows, so the estimator's bias cancels.
  const routes = new Map<string, RouteMetric>()
  let tn = 0
  let terr = 0
  let wsum = 0
  for (const r of rows) {
    const n = Number(r.n)
    const p95 = Number(r.avgd) + (Number(r.maxd) - Number(r.avgd)) * 0.5
    routes.set(r.route, { requests: n, errorRate: Number(r.err) / Math.max(1, n), p95 })
    tn += n
    terr += Number(r.err)
    wsum += p95 * n
  }
  return {
    overall: { requests: tn, errorRate: terr / Math.max(1, tn), p95: wsum / Math.max(1, tn) },
    routes
  }
}

/** Deploy regression: on a version change, snapshot the pre-deploy baseline;
 *  an hour later, compare and flag routes that got meaningfully worse. */
async function evalDeployRegression(
  cfg: { p95_worsen_pct?: number; min_requests?: number },
  state: Record<string, unknown>
): Promise<{ result: EvalResult; state: Record<string, unknown> }> {
  const worsenPct = Math.max(10, Number(cfg.p95_worsen_pct) || 50)
  const minReq = Math.max(5, Number(cfg.min_requests) || 20)
  const version = NIVARO_VERSION
  const now = Date.now()

  if (state.current_version !== version) {
    // Deploy just landed: capture the baseline from the hour BEFORE it.
    const base = await windowMetrics(new Date(now - 3_600_000), new Date(now))
    return {
      state: {
        current_version: version,
        deploy_at: new Date(now).toISOString(),
        baseline: { p95: base.overall.p95, errorRate: base.overall.errorRate, requests: base.overall.requests },
        evaluated: false
      },
      result: { status: 'ok', detail: `Deploy ${version} detected — baseline captured, comparing in ~1h` }
    }
  }

  const deployAt = state.deploy_at ? new Date(String(state.deploy_at)).getTime() : 0
  if (!deployAt || state.evaluated === true) {
    return { state, result: { status: 'ok', detail: `Watching for the next deploy (current ${version})` } }
  }
  if (now - deployAt < 3_600_000) {
    return {
      state,
      result: { status: 'ok', detail: `Deploy ${version} ${(Math.round((now - deployAt) / 60000))}m ago — comparing at 60m` }
    }
  }

  const baseline = (state.baseline ?? {}) as { p95?: number; errorRate?: number; requests?: number }
  const post = await windowMetrics(new Date(deployAt), new Date(deployAt + 3_600_000))
  const nextState = { ...state, evaluated: true }
  if ((baseline.requests ?? 0) < minReq || post.overall.requests < minReq) {
    return { state: nextState, result: { status: 'ok', detail: `Deploy ${version}: too little traffic to compare (${baseline.requests ?? 0} pre / ${post.overall.requests} post)` } }
  }
  const p95Delta = ((post.overall.p95 - (baseline.p95 ?? 0)) / Math.max(1, baseline.p95 ?? 1)) * 100
  const errDelta = post.overall.errorRate - (baseline.errorRate ?? 0)
  if (p95Delta > worsenPct || errDelta > 0.05) {
    const worst = [...post.routes.entries()]
      .filter(([, m]) => m.requests >= 5)
      .sort((a, b) => b[1].p95 - a[1].p95)
      .slice(0, 5)
      .map(([route, m]) => `  ${route}: ~${Math.round(m.p95)}ms, ${(m.errorRate * 100).toFixed(1)}% errors (${m.requests} reqs)`)
    return {
      state: nextState,
      result: {
        status: 'failing',
        detail: [
          `Deploy ${version} regressed: p95 ${p95Delta >= 0 ? '+' : ''}${p95Delta.toFixed(0)}% (${Math.round(baseline.p95 ?? 0)}→${Math.round(post.overall.p95)}ms), error rate ${((baseline.errorRate ?? 0) * 100).toFixed(1)}%→${(post.overall.errorRate * 100).toFixed(1)}%.`,
          'Slowest routes post-deploy:',
          ...worst
        ].join('\n')
      }
    }
  }
  return {
    state: nextState,
    result: { status: 'ok', detail: `Deploy ${version} healthy: p95 ${p95Delta >= 0 ? '+' : ''}${p95Delta.toFixed(0)}%, error rate ${(post.overall.errorRate * 100).toFixed(1)}%` }
  }
}

async function raiseIssue(monitor: MonitorRow, detail: string, app: FastifyInstance | null): Promise<void> {
  try {
    const fingerprint = createHash('sha256').update(`ops-monitor|${monitor.id}`).digest('hex')
    const existing = await db('nivaro_issues')
      .where({ fingerprint })
      .whereIn('status', ['open', 'acknowledged'])
      .first()
    if (existing) {
      await db('nivaro_issues')
        .where({ id: existing.id })
        .update({ details: detail, occurrence_count: db.raw('occurrence_count + 1'), last_seen_at: new Date(), updated_at: new Date() })
    } else {
      await db('nivaro_issues').insert({
        title: `Monitor failing: ${monitor.name}`,
        severity: monitor.type === 'synthetic' || monitor.type === 'journey' ? 'error' : 'warning',
        status: 'open',
        source: 'server',
        details: detail,
        fingerprint,
        occurrence_count: 1,
        last_seen_at: new Date(),
        created_at: new Date(),
        updated_at: new Date()
      })
    }
    if (app && monitor.created_by) {
      await notifyUser(app, monitor.created_by, {
        subject: `Monitor failing: ${monitor.name}`,
        message: detail.slice(0, 500)
      }).catch(() => {})
    }
  } catch (err) {
    console.warn('ops-monitor issue write failed:', err)
  }
}


/** Journey probe (#293): a scripted sequence of INTERNAL requests run through
 *  app.inject as a configured token's identity — "login → read a record →
 *  evaluate transitions" as a scheduled canary. Config:
 *  { token: '<static or api key>', steps: [{ path, method?, expect_status?, max_ms? }] } */
async function evalJourney(
  cfg: { token?: string; steps?: Array<{ path?: string; method?: string; expect_status?: number; max_ms?: number }> },
  app: FastifyInstance | null
): Promise<EvalResult> {
  if (!app) return { status: 'unknown', detail: 'No app instance in this context' }
  const steps = Array.isArray(cfg.steps) ? cfg.steps : []
  if (steps.length === 0) return { status: 'unknown', detail: 'No steps configured' }
  const results: string[] = []
  for (const [i, step] of steps.entries()) {
    const path = String(step.path ?? '')
    if (!path.startsWith('/api/')) {
      return { status: 'failing', detail: `Step ${i + 1}: path must start with /api/` }
    }
    const t0 = Date.now()
    const res = await app.inject({
      method: (step.method ?? 'GET') as 'GET',
      url: path,
      headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}
    })
    const ms = Date.now() - t0
    const want = step.expect_status ?? 200
    if (res.statusCode !== want) {
      return {
        status: 'failing',
        detail: `Step ${i + 1} (${path}) answered ${res.statusCode}, expected ${want} — after ${results.length} passing step(s)`
      }
    }
    if (step.max_ms && ms > step.max_ms) {
      return { status: 'failing', detail: `Step ${i + 1} (${path}) took ${ms}ms, budget ${step.max_ms}ms` }
    }
    results.push(`${path} ${res.statusCode} in ${ms}ms`)
  }
  return { status: 'ok', detail: results.join(' → ') }
}

/** TLS certificate expiry watch: connect, read the peer cert's valid_to,
 *  fail when expired or inside the warning window. rejectUnauthorized is off
 *  on purpose — corporate CA chains this process doesn't trust still have an
 *  expiry worth reporting, and we only READ the certificate. */
async function evalSslCert(cfg: {
  host?: string
  port?: number
  warn_days?: number
}): Promise<EvalResult> {
  const host = String(cfg.host ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
  if (!host) return { status: 'unknown', detail: 'No host configured' }
  const port = Number(cfg.port) || 443
  const warnDays = Number(cfg.warn_days) || 30
  let cert: tls.PeerCertificate
  try {
    cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
      const sock = tls.connect(
        { host, port, servername: host, timeout: 10_000, rejectUnauthorized: false },
        () => {
          const c = sock.getPeerCertificate()
          sock.end()
          if (c && c.valid_to) resolve(c)
          else reject(new Error('No certificate presented'))
        }
      )
      sock.on('error', reject)
      sock.setTimeout(10_000, () => {
        sock.destroy()
        reject(new Error('TLS connect timeout'))
      })
    })
  } catch (err) {
    return {
      status: 'failing',
      detail: `${host}:${port} — ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const expires = new Date(cert.valid_to)
  const daysLeft = Math.floor((expires.getTime() - Date.now()) / 86_400_000)
  const issuer = cert.issuer?.O ?? cert.issuer?.CN ?? 'unknown issuer'
  const when = expires.toISOString().slice(0, 10)
  if (daysLeft < 0)
    return {
      status: 'failing',
      metric: daysLeft,
      detail: `${host} certificate EXPIRED ${-daysLeft}d ago (${when}, ${issuer})`
    }
  if (daysLeft <= warnDays)
    return {
      status: 'failing',
      metric: daysLeft,
      detail: `${host} certificate expires in ${daysLeft}d (${when}, ${issuer}) — renew now`
    }
  return {
    status: 'ok',
    metric: daysLeft,
    detail: `${host} expires ${when} (${daysLeft}d, ${issuer})`
  }
}

export async function evaluateMonitor(monitor: MonitorRow, app: FastifyInstance | null): Promise<EvalResult> {
  const cfg = parseJson<Record<string, unknown>>(monitor.config, {})
  const state = parseJson<Record<string, unknown>>(monitor.state, {})
  const run = await startJobRun('monitor', `${monitor.type}:${monitor.name}`.slice(0, 200))

  let result: EvalResult
  let nextState = state
  try {
    if (monitor.type === 'freshness') result = await evalFreshness(cfg)
    else if (monitor.type === 'synthetic') result = await evalSynthetic(cfg)
    else if (monitor.type === 'ssl_cert') result = await evalSslCert(cfg)
    else if (monitor.type === 'journey') result = await evalJourney(cfg, app)
    else {
      const r = await evalDeployRegression(cfg, state)
      result = r.result
      nextState = r.state
    }
  } catch (err) {
    result = { status: 'unknown', detail: `Evaluator error: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Flip detection BEFORE the row update reads the prior status.
  const flippedToFailing = result.status === 'failing' && monitor.last_status !== 'failing'
  await db('nivaro_monitors')
    .where('id', monitor.id)
    .update({
      last_status: result.status,
      last_checked_at: new Date(),
      last_detail: result.detail.slice(0, 4000),
      state: JSON.stringify(nextState).slice(0, 8000),
      updated_at: new Date()
    })
    .catch(() => {})
  if (flippedToFailing) await raiseIssue(monitor, result.detail, app)

  const outcome = result.metric != null ? `${result.status} · ${result.metric} · ${result.detail}` : `${result.status} · ${result.detail}`
  if (result.status === 'failing') await run.fail(result.detail)
  else await run.complete(outcome.slice(0, 500))
  return result
}

/** The cron body: evaluate every active monitor, sequentially (they're cheap
 *  and sequential keeps the pool calm). */
export async function evaluateAllMonitors(app: FastifyInstance | null): Promise<string> {
  const monitors = (await db('nivaro_monitors').where('is_active', true)) as MonitorRow[]
  let failing = 0
  for (const m of monitors) {
    const r = await evaluateMonitor(m, app)
    if (r.status === 'failing') failing++
    // Live monitor board (#279): each evaluation lands on watchers instantly.
    try {
      const { getIo } = await import('./io-holder.js')
      getIo()
        ?.to('watch:monitors')
        .emit('monitor:status', { id: m.id, name: m.name, status: r.status })
    } catch {
      /* emit is decoration */
    }
  }
  return `${monitors.length} monitor(s) evaluated, ${failing} failing`
}

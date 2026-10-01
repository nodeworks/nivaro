import { timingSafeEqual } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { requireAdmin } from '../middleware/authenticate.js'
import { INSTANCE_ID } from '../services/instance-roster.js'
import { poolNow, poolPressure } from '../services/pool-attribution.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * GET /api/metrics — Prometheus text exposition (#1088).
 *
 * Written by hand (the format is a few lines of text) rather than pulling in a
 * client library. What it reports, per process:
 *
 *   nivaro_info{version,instance,role}               1
 *   process_* / nodejs_heap_*                         memory, CPU, start time
 *   nodejs_eventloop_lag_seconds{quantile}            event-loop delay since the last scrape
 *   nivaro_http_requests_total{method,route,status}   by route PATTERN (/api/items/:collection), never a raw URL
 *   nivaro_http_request_duration_seconds_*            the same, as a histogram
 *   nivaro_db_pool_{used,pending,max}                 knex/tarn pool right now
 *   nivaro_db_pool_wait_p95_seconds                   acquire wait over the last five minutes
 *   nivaro_cron_leader                                1 when this process holds the scheduler lease
 *
 * Access: `Authorization: Bearer <METRICS_TOKEN>` (the scraper's token; set it
 * with METRICS_TOKEN or METRICS_TOKEN_FILE), or a signed-in administrator.
 * Without METRICS_TOKEN only administrators can read it.
 */

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]
/** Distinct series kept before new routes fold into "__other__" — a bound on
 *  memory if something unexpected starts minting route patterns. */
const MAX_SERIES = 2000

interface Series {
  method: string
  route: string
  status: string
  count: number
  sum: number
  buckets: number[]
}

const series = new Map<string, Series>()

/** Record one finished request. Exported for tests. */
export function observeRequest(
  method: string,
  route: string,
  status: number,
  seconds: number
): void {
  const statusClass = `${Math.floor(status / 100)}xx`
  let key = `${method} ${route} ${statusClass}`
  let s = series.get(key)
  if (!s && series.size >= MAX_SERIES) {
    route = '__other__'
    key = `${method} ${route} ${statusClass}`
    s = series.get(key)
  }
  if (!s) {
    s = { method, route, status: statusClass, count: 0, sum: 0, buckets: BUCKETS.map(() => 0) }
    series.set(key, s)
  }
  s.count += 1
  s.sum += seconds
  for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) s.buckets[i] += 1
}

/** Reset collected request series (tests). */
export function resetMetrics(): void {
  series.clear()
}

const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
const num = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '0')

let loopHist: ReturnType<typeof monitorEventLoopDelay> | null = null
/** Sampling interval of the delay histogram. Node records the whole interval
 *  between samples, so an idle loop reads ~20ms; the exposition subtracts it. */
const LOOP_RESOLUTION_MS = 20
const lagSeconds = (ns: number) => Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS) / 1000

export interface MetricsExtras {
  cronLeader?: boolean | null
}

/** The whole exposition. Exported for tests. */
export function renderMetrics(extras: MetricsExtras = {}): string {
  const out: string[] = []
  const metric = (name: string, type: string, help: string) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
  }

  metric('nivaro_info', 'gauge', 'This API process (always 1).')
  out.push(
    `nivaro_info{version="${label(NIVARO_VERSION)}",instance="${label(INSTANCE_ID)}",role="${label(process.env.NIVARO_ROLE || '')}"} 1`
  )

  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  metric('process_cpu_user_seconds_total', 'counter', 'User CPU time spent.')
  out.push(`process_cpu_user_seconds_total ${num(cpu.user / 1e6)}`)
  metric('process_cpu_system_seconds_total', 'counter', 'System CPU time spent.')
  out.push(`process_cpu_system_seconds_total ${num(cpu.system / 1e6)}`)
  metric('process_resident_memory_bytes', 'gauge', 'Resident memory size.')
  out.push(`process_resident_memory_bytes ${mem.rss}`)
  metric('process_start_time_seconds', 'gauge', 'Start time of the process since the Unix epoch.')
  out.push(`process_start_time_seconds ${num(Date.now() / 1000 - process.uptime())}`)
  metric('nodejs_heap_used_bytes', 'gauge', 'V8 heap in use.')
  out.push(`nodejs_heap_used_bytes ${mem.heapUsed}`)
  metric('nodejs_heap_total_bytes', 'gauge', 'V8 heap allocated.')
  out.push(`nodejs_heap_total_bytes ${mem.heapTotal}`)
  metric('nodejs_external_memory_bytes', 'gauge', 'Memory held outside the V8 heap.')
  out.push(`nodejs_external_memory_bytes ${mem.external}`)

  if (loopHist && loopHist.count > 0) {
    metric('nodejs_eventloop_lag_seconds', 'summary', 'Event-loop delay since the previous scrape.')
    for (const q of [0.5, 0.9, 0.99]) {
      out.push(
        `nodejs_eventloop_lag_seconds{quantile="${q}"} ${num(lagSeconds(loopHist.percentile(q * 100)))}`
      )
    }
    out.push(`nodejs_eventloop_lag_seconds_sum ${num(lagSeconds(loopHist.mean) * loopHist.count)}`)
    out.push(`nodejs_eventloop_lag_seconds_count ${loopHist.count}`)
    metric(
      'nodejs_eventloop_lag_max_seconds',
      'gauge',
      'Longest event-loop delay since the previous scrape.'
    )
    out.push(`nodejs_eventloop_lag_max_seconds ${num(lagSeconds(loopHist.max))}`)
    loopHist.reset()
  }

  const all = [...series.values()].sort((a, b) =>
    `${a.route} ${a.method} ${a.status}`.localeCompare(`${b.route} ${b.method} ${b.status}`)
  )
  metric('nivaro_http_requests_total', 'counter', 'Finished HTTP requests by route pattern.')
  for (const s of all) {
    out.push(
      `nivaro_http_requests_total{method="${s.method}",route="${label(s.route)}",status="${s.status}"} ${s.count}`
    )
  }
  metric(
    'nivaro_http_request_duration_seconds',
    'histogram',
    'HTTP request duration by route pattern.'
  )
  for (const s of all) {
    const l = `method="${s.method}",route="${label(s.route)}",status="${s.status}"`
    BUCKETS.forEach((b, i) => {
      out.push(`nivaro_http_request_duration_seconds_bucket{${l},le="${b}"} ${s.buckets[i]}`)
    })
    out.push(`nivaro_http_request_duration_seconds_bucket{${l},le="+Inf"} ${s.count}`)
    out.push(`nivaro_http_request_duration_seconds_sum{${l}} ${num(s.sum)}`)
    out.push(`nivaro_http_request_duration_seconds_count{${l}} ${s.count}`)
  }

  const pool = poolNow()
  if (pool) {
    metric('nivaro_db_pool_used', 'gauge', 'Database connections checked out.')
    out.push(`nivaro_db_pool_used ${pool.used}`)
    metric('nivaro_db_pool_pending', 'gauge', 'Requests waiting for a database connection.')
    out.push(`nivaro_db_pool_pending ${pool.pending}`)
    metric('nivaro_db_pool_max', 'gauge', 'Database pool ceiling (DB_POOL_MAX).')
    out.push(`nivaro_db_pool_max ${pool.max}`)
    const pressure = poolPressure()
    metric(
      'nivaro_db_pool_wait_p95_seconds',
      'gauge',
      'p95 wait for a connection over the last five minutes.'
    )
    out.push(`nivaro_db_pool_wait_p95_seconds ${num(pressure.wait_p95_ms / 1000)}`)
  }

  if (extras.cronLeader !== undefined && extras.cronLeader !== null) {
    metric('nivaro_cron_leader', 'gauge', '1 when this process holds the scheduler lease.')
    out.push(`nivaro_cron_leader ${extras.cronLeader ? 1 : 0}`)
  }
  return `${out.join('\n')}\n`
}

function bearerMatches(req: FastifyRequest, token: string): boolean {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) return false
  const given = Buffer.from(h.slice(7).trim())
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

export const metricsPlugin = fp(async (app: FastifyInstance) => {
  loopHist = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS })
  loopHist.enable()

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url
    if (!route || route === '/api/metrics') return
    observeRequest(req.method, route, reply.statusCode, reply.elapsedTime / 1000)
  })

  app.addHook('onClose', async () => {
    loopHist?.disable()
  })

  app.get('/api/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = process.env.METRICS_TOKEN
    if (!(token && bearerMatches(req, token))) await requireAdmin(req, reply)
    let cronLeader: boolean | null = null
    try {
      cronLeader = app.cron ? app.cron.mayTick() : null
    } catch {
      cronLeader = null
    }
    void reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
    void reply.header('cache-control', 'no-store')
    return renderMetrics({ cronLeader })
  })
})

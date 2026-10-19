// api/src/routes/traffic-map-extras/history.ts
/**
 * Traffic Map — long history, playback and history-derived analysis:
 *   GET  /history/settings        the optional minute store: settings + what it holds (#2228)
 *   PUT  /history/settings        switch it on/off, retention, edges (activity row)
 *   GET  /history/timelapse       24 h / 7 d / 30 d / 90 d / 13 months of the map per step + people
 *                                 + markers (#2183/#2249; 90 d and 13 months from rollups, #2544)
 *   GET  /history/search          last hit / first error / busiest hour (#2175)
 *   GET  /history/route-latency   one route's duration histogram and its modes (#2193)
 *   GET  /history/slow-params     query parameters that go with slow requests on a route (#2252)
 *   GET  /history/jobs            scheduled jobs over the day's traffic + quieter slots (#2165)
 *   GET  /capacity/what-if        headroom, pool and loop lag under a scenario (#2151)
 * Mounted under /api/traffic-map by traffic-map-extras/index.ts (admin only, 404 in cloud).
 * Crons `traffic-minutes-write` (every minute, leader only) and `traffic-minutes-prune` (hourly).
 */
import type { FastifyInstance } from 'fastify'
import { listInstances } from '../../services/instance-roster.js'
import { clientGoneSignal, sharedGatedRead } from '../../services/read-gate.js'
import { instanceKey } from '../../services/settings-overrides.js'
import {
  LOCAL_LOG_DAYS,
  STORE_MAX_DAYS,
  storeEnabled,
  storeStatus
} from '../../services/telemetry-store.js'
import {
  buildTimelapse,
  jobsAgainstPeaks,
  latencyDistribution,
  projectWhatIf,
  slowParameters,
  type TimelapseGroup
} from '../../services/traffic-history-analysis.js'
import {
  CALLER_KEY,
  type CronListEntry,
  ENTITY_KEY,
  jobInputs,
  logSteps,
  peopleSteps,
  ROUTE_RE,
  type RouteRows,
  routeRows,
  type SearchKind,
  searchHistory,
  timelapseMarkers
} from '../../services/traffic-history-reads.js'
import { storeActive, storeSteps } from '../../services/traffic-history-store.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import {
  MinuteSettingsUnavailableError,
  minuteCoverage,
  minuteSteps,
  pruneMinuteRows,
  readMinuteSettings,
  saveMinuteSettings,
  startMinuteStore,
  writePushedMinutes
} from '../../services/traffic-minutes.js'
import {
  rollupActive,
  rollupDataFrom,
  rollupSteps,
  rollupsEnabled
} from '../../services/traffic-rollups.js'
import { capacityReport, logMinutes } from '../../services/traffic-taps/capacity.js'
import { nodeHealth } from '../../services/traffic-taps/node-health.js'

const RANGES = {
  '24h': { ms: 24 * 3600_000, stepS: 300 },
  '7d': { ms: 7 * 86_400_000, stepS: 3600 },
  // #2544 — older than the request log's 14 days: read from the long-history store.
  '30d': { ms: 30 * 86_400_000, stepS: 6 * 3600 },
  // #2544 Phase 5 — past the log store's month: hourly request rollups in the metrics store.
  '90d': { ms: 90 * 86_400_000, stepS: 12 * 3600 },
  '13mo': { ms: 395 * 86_400_000, stepS: 3 * 86_400 }
} as const
type Range = keyof typeof RANGES
const ROLLUP_RANGES = new Set<Range>(['90d', '13mo'])
const HOURS = new Set([1, 6, 24, 168])
const SEARCH_KINDS = new Set<SearchKind>(['last_hit', 'first_error', 'busiest_hour'])
const PARTNER = /^ext:\d{1,9}$/
const JOB_ID = /^[A-Za-z0-9_.:-]{1,200}$/
const JOB_DAYS = 14

/** A tiny TTL cache + single flight, per key (these reads are seconds long; viewers share). */
function cached<T>(ttlMs: number) {
  const hits = new Map<string, { at: number; value: T }>()
  const flights = new Map<string, Promise<T>>()
  return async (key: string, fn: () => Promise<T>): Promise<T> => {
    const h = hits.get(key)
    if (h && Date.now() - h.at < ttlMs) return h.value
    const f = flights.get(key)
    if (f) return f
    const p = fn()
      .then((value) => {
        hits.set(key, { at: Date.now(), value })
        if (hits.size > 50) hits.delete(hits.keys().next().value as string)
        return value
      })
      .finally(() => flights.delete(key))
    flights.set(key, p)
    return p
  }
}

interface TimelapseBody {
  range: Range
  source: 'minutes' | 'log' | 'store' | 'rollups' | 'unavailable'
  from: number
  to: number
  step_s: number
  nodes: Array<{ key: string; n: number; e: number }>
  frames: Array<{
    t: number
    req: number
    err: number
    nodes: Array<[number, number, number, number]>
  }>
  people: { online: Array<number | null>; active: number[]; sampled: boolean }
  markers: Array<{ kind: string; at: number; until?: number; label: string }>
  minutes: { enabled: boolean; first: string | null }
  /** Set when the long-history store was wanted but did not answer (the frames are partial). */
  note?: string
  /** Rollup ranges: when the rollups start (epoch ms); earlier steps are empty, not quiet. */
  data_from?: number | null
}

const timelapseCache = cached<TimelapseBody>(5 * 60_000)
const routeCache = cached<RouteRows>(60_000)
const jobsCache = cached<ReturnType<typeof jobsAgainstPeaks> & { source: string }>(10 * 60_000)

async function buildTimelapseBody(range: Range, want: string | undefined): Promise<TimelapseBody> {
  const { ms, stepS } = RANGES[range]
  // Whole steps, ending at the current step's end, so frames line up with the clock.
  const to = Math.ceil(Date.now() / (stepS * 1000)) * stepS * 1000
  const from = to - ms
  if (ROLLUP_RANGES.has(range)) return buildRollupBody(range, from, to, stepS)
  const settings = await readMinuteSettings()
  const coverage = await minuteCoverage()
  // The minute store answers when it is on and reaches back far enough (an hour of slack).
  const covers = coverage.table && !!coverage.first && Date.parse(coverage.first) <= from + 3600_000
  // The store answers windows older than the request log, or when asked for by name.
  const useStore =
    storeEnabled() &&
    (want === 'store' || (want == null && from < to - LOCAL_LOG_DAYS * 86_400_000 && !covers))
  const useMinutes =
    !useStore &&
    (want === 'minutes' ? coverage.table : want === 'log' ? false : settings.enabled && covers)
  let groups: TimelapseGroup[] | null = null
  let source: TimelapseBody['source'] = 'unavailable'
  let note: string | undefined
  if (useStore) {
    try {
      groups = await storeSteps(from, to, stepS)
      source = 'store'
    } catch {
      note = `The long-history store did not answer; showing the request log's last ${LOCAL_LOG_DAYS} days.`
    }
  }
  if (source === 'unavailable') {
    if (useMinutes) {
      groups = await minuteSteps(from, to, stepS)
      source = 'minutes'
    } else {
      groups = await logSteps(from, to, stepS)
      source = groups ? 'log' : 'unavailable'
    }
  }
  const tl = buildTimelapse(groups ?? [], { from, to, stepS }, 40)
  const emptyPeople = () => ({
    online: new Array(tl.frames.length).fill(null),
    active: new Array(tl.frames.length).fill(0),
    sampled: false
  })
  const [people, markers, storeActiveSteps] = await Promise.all([
    peopleSteps(from, to, stepS).catch(emptyPeople),
    timelapseMarkers(from, to),
    source === 'store' ? storeActive(from, to, stepS).catch(() => null) : Promise.resolve(null)
  ])
  if (storeActiveSteps) people.active = storeActiveSteps
  return {
    range,
    source,
    from,
    to,
    step_s: stepS,
    nodes: tl.nodes,
    frames: tl.frames,
    people,
    markers,
    minutes: { enabled: settings.enabled, first: coverage.first },
    ...(note ? { note } : {})
  }
}

/** 90 days / 13 months: the map per step from the hourly request rollups (#2544 Phase 5). */
async function buildRollupBody(
  range: Range,
  from: number,
  to: number,
  stepS: number
): Promise<TimelapseBody> {
  const settings = await readMinuteSettings()
  const coverage = await minuteCoverage()
  let groups: TimelapseGroup[] = []
  let active: number[] | null = null
  let source: TimelapseBody['source'] = 'unavailable'
  let note: string | undefined
  let dataFrom: number | null = null
  if (!rollupsEnabled()) {
    note = 'Long history isn’t set up, so ranges past 30 days have no frames.'
  } else {
    try {
      ;[groups, active, dataFrom] = await Promise.all([
        rollupSteps(from, to, stepS),
        rollupActive(from, to, stepS).catch(() => null),
        rollupDataFrom()
      ])
      source = 'rollups'
    } catch {
      note = 'Long history didn’t answer, so this range has no frames right now.'
    }
  }
  const tl = buildTimelapse(groups, { from, to, stepS }, 40)
  const [people, markers] = await Promise.all([
    peopleSteps(from, to, stepS).catch(() => ({
      online: new Array(tl.frames.length).fill(null),
      active: new Array(tl.frames.length).fill(0),
      sampled: false
    })),
    timelapseMarkers(from, to)
  ])
  if (active) people.active = active
  return {
    range,
    source,
    from,
    to,
    step_s: stepS,
    nodes: tl.nodes,
    frames: tl.frames,
    people,
    markers,
    minutes: { enabled: settings.enabled, first: coverage.first },
    ...(note ? { note } : {}),
    ...(source === 'rollups' ? { data_from: dataFrom } : {})
  }
}

/** Requests per minute for each UTC hour of the day, from the per-minute request log (7 days). */
function curveFromLogMinutes(): number[] | null {
  const log = logMinutes()
  if (!log) return null
  const sums = new Array(24).fill(0)
  const counts = new Array(24).fill(0)
  for (let i = 0; i < log.counts.length; i++) {
    const h = Math.floor(((((log.start + i) % 1440) + 1440) % 1440) / 60)
    sums[h] += log.counts[i]
    counts[h]++
  }
  return sums.map((s, h) => (counts[h] ? s / counts[h] : 0))
}

/** The same curve from the 7-day time-lapse read (when the per-minute read has not landed yet). */
function curveFromTimelapse(tl: TimelapseBody): number[] {
  const sums = new Array(24).fill(0)
  const counts = new Array(24).fill(0)
  for (const f of tl.frames) {
    const h = new Date(f.t).getUTCHours()
    sums[h] += f.req / (tl.step_s / 60)
    counts[h]++
  }
  return sums.map((s, h) => (counts[h] ? s / counts[h] : 0))
}

export async function historyRoutes(app: FastifyInstance): Promise<void> {
  const cloud = !!process.env.CLOUD_META_DB_URL
  if (!cloud) {
    startMinuteStore()
    const cron = (
      app as unknown as {
        cron?: {
          schedule?: (
            id: string,
            expr: string,
            fn: () => Promise<void>,
            opts?: Record<string, unknown>
          ) => void
        }
      }
    ).cron
    if (cron?.schedule) {
      cron.schedule(
        'traffic-minutes-write',
        '* * * * *',
        async () => {
          await writePushedMinutes()
        },
        {
          quiet: true,
          idempotent: 'safe',
          description:
            'Every minute — writes the Traffic Map minute history (per node and edge: requests, errors, p50/p95, bytes) that every API process pushed for the minutes just closed. Returns at once while minute history is off (Traffic Map → History).'
        }
      )
      cron.schedule(
        'traffic-minutes-prune',
        '25 * * * *',
        async () => {
          await pruneMinuteRows()
        },
        {
          idempotent: 'safe',
          description:
            'Hourly at :25 — deletes Traffic Map minute history older than its retention (30 days unless changed), 5,000 rows at a time and at most 1,000,000 a run, so a busy store never falls behind.'
        }
      )
    }
  }

  app.get('/history/settings', async () => {
    const [settings, coverage] = await Promise.all([readMinuteSettings(true), minuteCoverage()])
    return { data: { settings, coverage, cloud } }
  })

  app.put<{ Body: Record<string, unknown> }>('/history/settings', async (req, reply) => {
    if (cloud)
      return reply
        .code(400)
        .send({ error: 'Minute history is not available in cloud mode', code: 'HISTORY_CLOUD' })
    try {
      const settings = await saveMinuteSettings(req.body ?? {}, {
        userId: req.user?.id ?? null,
        req
      })
      return { data: { settings, coverage: await minuteCoverage(), cloud } }
    } catch (err) {
      if (err instanceof MinuteSettingsUnavailableError)
        return reply.code(409).send({ error: err.message, code: 'HISTORY_NOT_MIGRATED' })
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : 'Invalid', code: 'HISTORY_INVALID' })
    }
  })

  // #2544 — whether the long-history store is set up and answering, and how far back it reaches.
  app.get('/history/store', async () => ({ data: await storeStatus() }))

  app.get<{ Querystring: { range?: string; source?: string } }>(
    '/history/timelapse',
    async (req, reply) => {
      const range = (req.query.range ?? '24h') as Range
      if (!(range in RANGES))
        return reply
          .code(400)
          .send({ error: 'range must be 24h, 7d, 30d, 90d or 13mo', code: 'RANGE_INVALID' })
      const want = req.query.source
      if (want != null && want !== 'minutes' && want !== 'log' && want !== 'store')
        return reply
          .code(400)
          .send({ error: 'source must be minutes, log or store', code: 'SOURCE_INVALID' })
      try {
        return {
          data: await timelapseCache(`${range}|${want ?? ''}`, () =>
            buildTimelapseBody(range, want)
          )
        }
      } catch (err) {
        req.log.warn({ err }, 'traffic-map time-lapse read failed')
        return reply.code(503).send({
          error: 'The traffic history could not be read right now',
          code: 'HISTORY_UNAVAILABLE'
        })
      }
    }
  )

  app.get<{
    Querystring: {
      kind?: string
      caller?: string
      entity?: string
      route?: string
      error?: string
      partner?: string
      days?: string
    }
  }>('/history/search', async (req, reply) => {
    const q = req.query
    const kind = q.kind as SearchKind
    const bad = (error: string) => reply.code(400).send({ error, code: 'SEARCH_INVALID' })
    if (!SEARCH_KINDS.has(kind)) return bad('kind must be last_hit, first_error or busiest_hour')
    const days = Number(q.days ?? 7)
    if (!Number.isInteger(days) || days < 1 || days > STORE_MAX_DAYS)
      return bad(`days must be 1 to ${STORE_MAX_DAYS}`)
    const caller = q.caller?.trim() || null
    const entity = q.entity?.trim() || null
    const route = q.route?.trim() || null
    const error = q.error?.trim() || null
    const partner = q.partner?.trim() || null
    if (caller && !CALLER_KEY.test(caller)) return bad('caller is not a caller key')
    if (entity && !ENTITY_KEY.test(entity)) return bad('entity must be <lane>/<entity>')
    if (route && !ROUTE_RE.test(route)) return bad('route must look like "GET /api/…"')
    if (error && (error.length < 3 || error.length > 200))
      return bad('error text must be 3 to 200 characters')
    if (partner && !PARTNER.test(partner)) return bad('partner must be ext:<id>')
    if (partner && kind !== 'busiest_hour') return bad('a partner is searched by busiest hour only')
    if (kind === 'last_hit' && !caller && !route && !entity)
      return bad('last hit needs a caller, a route or a node')
    if (kind === 'first_error' && !error && !route && !entity)
      return bad('first error needs error text, a route or a node')
    if (kind === 'busiest_hour' && !caller && !route && !entity && !partner)
      return bad('busiest hour needs a caller, a route, a node or a partner')
    try {
      const args = { kind, caller, entity, route, error, partner, days }
      // Up to three long scans of the request log: gated, and one run per identical search.
      const { value } = await sharedGatedRead(
        `tm:history-search|${JSON.stringify(args)}`,
        req.user?.id,
        () => searchHistory(args, Date.now(), clientGoneSignal(reply.raw)),
        { signal: clientGoneSignal(reply.raw), label: 'tm:history-search' }
      )
      return { data: value }
    } catch (err) {
      req.log.warn({ err }, 'traffic-map history search failed')
      return reply
        .code(503)
        .send({ error: 'The search could not finish — try a shorter range', code: 'SEARCH_FAILED' })
    }
  })

  const routeParams = (q: { key?: string; route?: string; hours?: string }) => {
    const key = String(q.key ?? '')
    const route = String(q.route ?? '')
    const hours = Number(q.hours ?? 24)
    if (!ENTITY_KEY.test(key) || !ROUTE_RE.test(route) || !HOURS.has(hours)) return null
    return { key, route, hours }
  }
  const badRoute = {
    error: 'key (<lane>/<entity>), route ("GET /api/…") and hours (1, 6, 24 or 168) are required',
    code: 'ROUTE_PARAMS_INVALID'
  }

  app.get<{ Querystring: { key?: string; route?: string; hours?: string } }>(
    '/history/route-latency',
    async (req, reply) => {
      const p = routeParams(req.query)
      if (!p) return reply.code(400).send(badRoute)
      try {
        const rows = await routeCache(`${p.key}|${p.route}|${p.hours}`, () =>
          routeRows(p.key, p.route, p.hours)
        )
        return {
          data: {
            ...latencyDistribution(rows.latencies),
            hours: p.hours,
            truncated: rows.truncated
          }
        }
      } catch (err) {
        req.log.warn({ err }, 'traffic-map route latency read failed')
        return reply.code(503).send({
          error: 'The request log could not be read right now',
          code: 'HISTORY_UNAVAILABLE'
        })
      }
    }
  )

  app.get<{ Querystring: { key?: string; route?: string; hours?: string } }>(
    '/history/slow-params',
    async (req, reply) => {
      const p = routeParams(req.query)
      if (!p) return reply.code(400).send(badRoute)
      try {
        const rows = await routeCache(`${p.key}|${p.route}|${p.hours}`, () =>
          routeRows(p.key, p.route, p.hours)
        )
        return {
          data: { ...slowParameters(rows.rows), hours: p.hours, truncated: rows.truncated }
        }
      } catch (err) {
        req.log.warn({ err }, 'traffic-map slow parameters read failed')
        return reply.code(503).send({
          error: 'The request log could not be read right now',
          code: 'HISTORY_UNAVAILABLE'
        })
      }
    }
  )

  const jobsReport = () =>
    jobsCache('jobs', async () => {
      const list =
        (app as unknown as { cron?: { list?: () => CronListEntry[] } }).cron?.list?.() ?? []
      // Chained jobs run after another one (no schedule of their own); paused ones not at all.
      const scheduled = list.filter((e) => !e.after && !e.paused)
      const inputs = await jobInputs(scheduled, JOB_DAYS)
      let curve = curveFromLogMinutes()
      let source = 'log-minutes'
      if (!curve) {
        curve = curveFromTimelapse(
          await timelapseCache('7d|', () => buildTimelapseBody('7d', undefined))
        )
        source = 'log-hours'
      }
      return { ...jobsAgainstPeaks(curve, inputs, { days: JOB_DAYS }), source }
    })

  app.get('/history/jobs', async (req, reply) => {
    try {
      return { data: await jobsReport() }
    } catch (err) {
      req.log.warn({ err }, 'traffic-map jobs-against-peaks read failed')
      return reply
        .code(503)
        .send({ error: 'The job runs could not be read right now', code: 'HISTORY_UNAVAILABLE' })
    }
  })

  app.get<{
    Querystring: { traffic_pct?: string; add_replicas?: string; job?: string; to_minute?: string }
  }>('/capacity/what-if', async (req, reply) => {
    const pct = Number(req.query.traffic_pct ?? 0)
    const add = Number(req.query.add_replicas ?? 0)
    const job = req.query.job?.trim() || null
    const toMinute = req.query.to_minute == null ? null : Number(req.query.to_minute)
    if (!Number.isFinite(pct) || pct < -95 || pct > 1000)
      return reply
        .code(400)
        .send({ error: 'traffic_pct must be from -95 to 1000', code: 'WHATIF_INVALID' })
    if (!Number.isInteger(add) || add < -20 || add > 20)
      return reply.code(400).send({
        error: 'add_replicas must be a whole number from -20 to 20',
        code: 'WHATIF_INVALID'
      })
    if (
      job &&
      (!JOB_ID.test(job) ||
        toMinute == null ||
        !Number.isInteger(toMinute) ||
        toMinute < 0 ||
        toMinute >= 1440)
    )
      return reply.code(400).send({
        error: 'a moved job needs its id and to_minute (UTC minute of the day, 0–1439)',
        code: 'WHATIF_INVALID'
      })
    const cap = capacityReport()
    const health = nodeHealth(300, currentTrafficSec())
    const me = instanceKey()
    const instances = await listInstances()
    const replicas = Math.max(
      1,
      instances.filter((i) => (i.instance ?? me) === me && i.role !== 'worker').length
    )
    let moveJob: { id: string; from_rpm: number; to_rpm: number; connections: number } | null = null
    if (job && toMinute != null) {
      const report = await jobsReport().catch(() => null)
      const slot = report?.jobs.find((j) => j.id === job)
      if (!slot || slot.start_minute_utc == null)
        return reply.code(404).send({
          error: 'That job has no usual start time in its recent runs',
          code: 'WHATIF_JOB_UNKNOWN'
        })
      const level = (m: number) => report?.curve[Math.floor(m / 60) % 24] ?? 0
      moveJob = {
        id: job,
        from_rpm: level(slot.start_minute_utc),
        to_rpm: level(toMinute),
        connections: slot.heavy ? 2 : 1
      }
    }
    const result = projectWhatIf(
      {
        now_rps: cap.now_rps,
        ceiling_rps: cap.ceiling.rps,
        replicas,
        pool_used: cap.pool.used,
        pool_max: cap.pool.max,
        pool_per_rps: cap.projection.pool_per_rps,
        loop_p99_ms: health.loop.p99 > 0 ? health.loop.p99 : null
      },
      { traffic_pct: pct, add_replicas: add, move_job: moveJob }
    )
    return {
      data: {
        ...result,
        ceiling: cap.ceiling,
        inputs: { traffic_pct: pct, add_replicas: add, job, to_minute: toMinute }
      }
    }
  })
}

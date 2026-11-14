// api/src/services/slow-screens.ts
/**
 * Slow screens for one person — the database half (logic: slow-screens-logic.ts). Admin only
 * (routes/slow-screens.ts). Every read is narrowed to the one person, capped, and runs as a
 * statement with a server-side deadline; the request-log read goes through apiLogSource
 * (WITH (NOLOCK) on SQL Server — this is analytics, never a read that decides a write) and
 * only for the moments the person was loading the pages listed.
 */
import type { Knex } from 'knex'
import { resolveDb } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { apiLogSource } from './api-log-source.js'
import { boundedRaw } from './bounded-sql.js'
import {
  CALL_PAGES,
  callsBehind,
  callWindowMs,
  deviceMix,
  type JourneyRow,
  type PageStat,
  type RecordingRow,
  type RequestRow,
  replayAt,
  requestWindows,
  summarisePages,
  type TimingRow,
  VISITS_PER_PAGE,
  visitForTiming,
  visitsOf
} from './slow-screens-logic.js'
import { foldPath } from './support-ticket-traffic.js'
import { normalizeApp, normalizeScreenPath } from './traffic-client-facts.js'
import { buildVisits, DAY, MIN, type Visit } from './traffic-inspect/people-ux-logic.js'

const STATEMENT_MS = 15_000
const TIMING_CAP = 20_000
const JOURNEY_CAP = 20_000
const REQUEST_CAP = 20_000
const RECORDING_CAP = 2_000
/** Browser timings and the request log are kept this long (services/log-retention.ts). */
export const TIMING_KEEP_DAYS = 14

export interface SlowScreensReport {
  user_id: string
  days: number
  /** Days the timings actually cover (the browser-timing log keeps 14). */
  timing_days: number
  samples: number
  pages: PageStat[]
  devices: ReturnType<typeof deviceMix>
  /** The journey log had visits to tie calls to. */
  journeys: boolean
  /** The browser-timing table had nothing for this person (missing, empty, or no beacons). */
  no_timings: boolean
}

const ms = (v: unknown) => new Date(v as string | number | Date).getTime()
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

async function bounded<T>(knex: Knex, qb: Knex.QueryBuilder): Promise<T[]> {
  const q = qb.toSQL()
  return boundedRaw<T>(q.sql, q.bindings as unknown[], { timeoutMs: STATEMENT_MS, knex })
}

async function readTimings(knex: Knex, userId: string, since: number): Promise<TimingRow[]> {
  if (!(await knex.schema.hasTable('nivaro_rum_events').catch(() => false))) return []
  const device = await hasColumn('nivaro_rum_events', 'browser').catch(() => false)
  const rows = await bounded<Record<string, unknown>>(
    knex,
    knex('nivaro_rum_events')
      .where('user', userId)
      .where('created_at', '>=', new Date(since))
      .whereIn('kind', ['load', 'route'])
      .orderBy('created_at', 'desc')
      .limit(TIMING_CAP)
      .select(
        'route',
        'kind',
        'ttfb_ms',
        'lcp_ms',
        'duration_ms',
        'app',
        'created_at',
        ...(device ? ['browser', 'os', 'screen'] : [])
      )
  )
  const out: TimingRow[] = []
  for (const r of rows) {
    const kind = r.kind === 'load' ? 'load' : 'route'
    const value = kind === 'load' ? (r.lcp_ms ?? r.duration_ms) : r.duration_ms
    if (value == null) continue
    const page = normalizeScreenPath(r.route) ?? String(r.route ?? '').slice(0, 120)
    if (!page) continue
    out.push({
      page,
      app: normalizeApp(r.app) ?? 'admin',
      kind,
      ms: num(value),
      ttfb_ms: r.ttfb_ms == null ? null : num(r.ttfb_ms),
      at: ms(r.created_at),
      browser: (r.browser as string | null | undefined) ?? null,
      os: (r.os as string | null | undefined) ?? null,
      screen: (r.screen as string | null | undefined) ?? null
    })
  }
  return out
}

async function readVisits(knex: Knex, userId: string, since: number): Promise<Visit[]> {
  const withApp = await hasColumn('nivaro_admin_journeys', 'app').catch(() => false)
  const rows = await bounded<Record<string, unknown>>(
    knex,
    knex('nivaro_admin_journeys')
      .where('user', userId)
      .where('entered_at', '>=', new Date(since - 35 * MIN))
      .orderBy('entered_at', 'desc')
      .limit(JOURNEY_CAP)
      .select('session_id', 'path', 'entered_at', 'duration_seconds', ...(withApp ? ['app'] : []))
  ).catch(() => [])
  const journeys: JourneyRow[] = []
  for (const r of rows) {
    const page = normalizeScreenPath(r.path)
    if (!page) continue
    journeys.push({
      user: userId,
      session_id: String(r.session_id ?? ''),
      page,
      app: normalizeApp(r.app) ?? 'admin',
      entered_at: ms(r.entered_at),
      duration_seconds: r.duration_seconds == null ? null : num(r.duration_seconds)
    })
  }
  return buildVisits(journeys).get(userId) ?? []
}

async function readRequests(
  knex: Knex,
  userId: string,
  windows: Array<[number, number]>
): Promise<RequestRow[]> {
  if (windows.length === 0) return []
  const qb = apiLogSource(knex)
    .where('user', userId)
    .where((q) => {
      for (const [s, e] of windows) void q.orWhereBetween('created_at', [new Date(s), new Date(e)])
    })
    .orderBy('created_at', 'desc')
    .limit(REQUEST_CAP)
    .select('method', 'path', 'status', 'latency_ms', 'created_at')
  const rows = await bounded<Record<string, unknown>>(knex, qb)
  return rows.map((r) => ({
    at: ms(r.created_at),
    method: String(r.method ?? 'GET'),
    path: foldPath(String(r.path ?? '')),
    status: num(r.status),
    latency_ms: num(r.latency_ms)
  }))
}

async function readRecordings(knex: Knex, userId: string, since: number): Promise<RecordingRow[]> {
  if (!(await knex.schema.hasTable('nivaro_session_recordings').catch(() => false))) return []
  const rows = await bounded<Record<string, unknown>>(
    knex,
    knex('nivaro_session_recordings')
      .where('user', userId)
      .where('started_at', '>=', new Date(since - DAY))
      .orderBy('started_at', 'desc')
      .limit(RECORDING_CAP)
      .select('id', 'started_at', 'ended_at', 'last_event_at')
  ).catch(() => [])
  return rows.map((r) => ({
    id: String(r.id),
    started_at: ms(r.started_at),
    ended_at:
      r.ended_at != null ? ms(r.ended_at) : r.last_event_at != null ? ms(r.last_event_at) : null
  }))
}

export async function readSlowScreens(
  userId: string,
  days: number,
  now = Date.now()
): Promise<SlowScreensReport> {
  const knex = resolveDb() as unknown as Knex
  const since = now - days * DAY
  const [timings, visits, recordings] = await Promise.all([
    readTimings(knex, userId, since),
    readVisits(knex, userId, since),
    readRecordings(knex, userId, since)
  ])
  const pages = summarisePages(timings)

  // Calls behind the slowest pages: only the first seconds of their newest visits are read.
  const callPages = pages.slice(0, CALL_PAGES).map((p) => ({
    page: p,
    visits: visitsOf(visits, p.app, p.page),
    windowMs: callWindowMs(p.p95_ms)
  }))
  for (const c of callPages) c.page.visits = c.visits.filter((v) => v.start >= since).length
  const requests = await readRequests(knex, userId, requestWindows(callPages)).catch(() => [])
  for (const c of callPages) {
    const read = c.visits.slice(0, VISITS_PER_PAGE)
    c.page.calls = callsBehind(read, requests, c.windowMs)
    c.page.calls_from_visits = read.length
  }

  // A replay of each slow visit, when a recording was running then.
  for (const p of pages) {
    const own = visitsOf(visits, p.app, p.page)
    for (const v of p.slow_visits) {
      const t = timings.find((x) => x.at === v.at && x.ms === v.ms && x.page === p.page)
      const visit = t ? visitForTiming(own, t) : null
      v.replay = replayAt(recordings, visit ? visit.start : v.at - v.ms, now)
    }
  }

  return {
    user_id: userId,
    days,
    timing_days: Math.min(days, TIMING_KEEP_DAYS),
    samples: timings.length,
    pages,
    devices: deviceMix(timings),
    journeys: visits.length > 0,
    no_timings: timings.length === 0
  }
}

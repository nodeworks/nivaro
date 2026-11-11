/**
 * Daily operations report — the numbers (#ops-report, 2026-11-10).
 *
 * Fixed, read-only SQL over what the instance already records for one window: the request log,
 * issues, job runs, integration submissions + outbound calls + obligations, mail, notifications,
 * workflow history, activity, search, sign-ins. No AI here: the digest is stored with each
 * report, so trends and day-to-day comparisons never need a model.
 *
 * The request log is the hottest append table there is: every read of it here is WITH (NOLOCK)
 * on SQL Server (its page locks deadlocked with its own inserts on prod, 2026-11-10).
 */
import type { Knex } from 'knex'
import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { buildMore, type DigestExtras } from './digest-more.js'
import { routeOf } from './digest-route.js'

export { routeOf }

import type { OpsDigest } from './types.js'
import { clock, type ReportWindow } from './window.js'

export type { OpsDigest }

export const DIGEST_VERSION = 1

type Row = Record<string, unknown>

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

async function rows(sql: string, bindings: readonly unknown[] = []): Promise<Row[]> {
  try {
    const r = (await db.raw(sql, bindings as Knex.RawBinding[])) as unknown
    return Array.isArray(r) ? (r as Row[]) : ((r as { rows?: Row[] })?.rows ?? [])
  } catch {
    return []
  }
}

/** The request log as a FROM (alias l), dirty-read on SQL Server. */
function logs(): string {
  return isMssql(db) ? 'nivaro_api_logs AS l WITH (NOLOCK)' : 'nivaro_api_logs AS l'
}

/** Approximate percentile from latency buckets (exact PERCENTILE_CONT over 600k rows took 12 s). */
const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]
export function percentileFromBuckets(counts: number[], total: number, p: number): number | null {
  if (total <= 0) return null
  const want = total * p
  let seen = 0
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i]
    if (seen >= want) return i < BUCKETS.length ? BUCKETS[i] : BUCKETS[BUCKETS.length - 1]
  }
  return BUCKETS[BUCKETS.length - 1]
}

/**
 * Build the digest for one window. Each part reads on its own and an unreadable part is empty,
 * never a failed report (a table an older instance lacks, a slow statement cut by the driver).
 */
export async function buildDigest(
  win: ReportWindow,
  extras: DigestExtras = {}
): Promise<OpsDigest> {
  const S = win.start
  const E = win.end
  const at = (v: unknown) =>
    v instanceof Date ? clock(v, win.tz) : v ? clock(new Date(String(v)), win.tz) : ''
  const range = [S, E] as const
  const hourExpr = isMssql(db)
    ? (col: string) => `DATEPART(hour, DATEADD(minute, ${offsetMinutes(win)}, ${col}))`
    : (col: string) => `EXTRACT(HOUR FROM ${col} + INTERVAL '${offsetMinutes(win)} minutes')`
  const minuteKey = isMssql(db)
    ? (col: string) => `CONVERT(varchar(16), ${col}, 120)`
    : (col: string) => `to_char(${col}, 'YYYY-MM-DD HH24:MI')`

  // ── People ──────────────────────────────────────────────────────────────────
  const [active] = await rows(
    `SELECT COUNT(DISTINCT l.[user]) n FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND l.[user] IS NOT NULL AND l.auth IN ('session','masquerade')`,
    range
  )
  const [logins] = await rows(
    `SELECT COUNT(*) n, COUNT(DISTINCT [user]) people FROM nivaro_login_events WHERE created_at >= ? AND created_at < ? AND method <> 'masquerade'`,
    range
  )
  const [carried] = await rows(
    `SELECT COUNT(DISTINCT l.[user]) n FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND l.auth = 'session' AND l.[user] IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM nivaro_login_events e WHERE e.[user] = l.[user] AND e.created_at >= ? AND e.created_at < ? AND e.method <> 'masquerade')`,
    [S, E, dayStart(win), E]
  )
  // New accounts, not "no earlier sign-in event": the sign-in log may be younger than the people.
  const [firstTime] = await rows(
    `SELECT COUNT(*) n FROM nivaro_users WHERE created_at >= ? AND created_at < ? AND (account_kind IS NULL OR account_kind = '')`,
    range
  )
  const viewAs = await rows(
    `SELECT e.created_at, u.first_name, u.last_name FROM nivaro_login_events e LEFT JOIN nivaro_users u ON u.id = e.[user] WHERE e.created_at >= ? AND e.created_at < ? AND e.method = 'masquerade' ORDER BY e.created_at`,
    range
  )
  const byRole = await rows(
    `SELECT r.name role, COUNT(DISTINCT l.[user]) people FROM ${logs()} JOIN nivaro_users u ON u.id = l.[user] LEFT JOIN nivaro_roles r ON r.id = u.role WHERE l.created_at >= ? AND l.created_at < ? GROUP BY r.name ORDER BY people DESC`,
    range
  )
  const machines = await rows(
    `SELECT COALESCE(k.name, u.first_name + ' ' + u.last_name, l.auth) name, COUNT(*) n, SUM(CASE WHEN l.status >= 400 THEN 1 ELSE 0 END) errs
       FROM ${logs()} LEFT JOIN nivaro_api_keys k ON k.id = l.api_key_id LEFT JOIN nivaro_users u ON u.id = l.[user]
      WHERE l.created_at >= ? AND l.created_at < ? AND (l.auth IN ('token','api_key') OR l.api_key_id IS NOT NULL)
      GROUP BY COALESCE(k.name, u.first_name + ' ' + u.last_name, l.auth) ORDER BY n DESC`,
    range
  )
  // People who hit trouble: server errors, refusals (4xx but not signed-out / not-found noise),
  // requests over 5 s and blocked moves (a transition refused for missing requirements).
  const trouble = await rows(
    `SELECT u.first_name, u.last_name,
            SUM(CASE WHEN l.status >= 500 THEN 1 ELSE 0 END) + SUM(CASE WHEN l.status IN (400, 403, 409, 415) THEN 1 ELSE 0 END) errs,
            SUM(CASE WHEN l.latency_ms >= 5000 THEN 1 ELSE 0 END) slow,
            SUM(CASE WHEN l.status = 422 AND l.path LIKE '%/transition' THEN 1 ELSE 0 END) blocked
       FROM ${logs()} JOIN nivaro_users u ON u.id = l.[user]
      WHERE l.created_at >= ? AND l.created_at < ? AND l.auth = 'session' AND (l.status >= 400 OR l.latency_ms >= 5000) AND l.status <> 401 AND l.path <> '/api/ready'
      GROUP BY u.first_name, u.last_name`,
    range
  )
  const activeN = num(active?.n)
  const signedIn = num(logins?.people)
  const carriedN = num(carried?.n)
  const people: OpsDigest['people'] = {
    active: activeN,
    signed_in_today: signedIn,
    sign_ins: num(logins?.n),
    carried_sessions: carriedN,
    first_time: num(firstTime?.n),
    view_as_sessions: viewAs.length,
    trouble: trouble
      .map((r) => ({
        person: personName(r) ?? 'Someone',
        errors: num(r.errs),
        slow: num(r.slow),
        blocked: num(r.blocked)
      }))
      .filter((t) => t.errors + t.slow + t.blocked >= 3)
      .sort((a, b) => b.errors + b.slow + b.blocked - (a.errors + a.slow + a.blocked))
      .slice(0, 10),
    machine_callers: machines.slice(0, 10).map((r) => ({
      name: String(r.name ?? 'unknown'),
      requests: num(r.n),
      errors: num(r.errs)
    })),
    by_role: byRole.map((r) => ({ role: String(r.role ?? 'No role'), people: num(r.people) })),
    explain: [
      `${activeN} people used the app between ${clock(S, win.tz)} and ${clock(E, win.tz)} (anyone signed in who made a request).`,
      `${signedIn} of them went through Microsoft sign-in today (${num(logins?.n)} sign-ins — some people sign in more than once).`,
      `${carriedN} never signed in today: they were still signed in from an earlier day, because a sign-in lasts several days.`,
      `${num(firstTime?.n)} got an account today (their first time here).`,
      'View-as sessions (an admin seeing the app as someone else) and machine callers (integrations, API keys) are counted separately and are not people.'
    ]
  }

  // ── Traffic + speed ─────────────────────────────────────────────────────────
  const byHour = await rows(
    `SELECT ${hourExpr('l.created_at')} h, COUNT(*) n, COUNT(DISTINCT l.[user]) u,
            SUM(CASE WHEN l.status >= 500 AND l.path <> '/api/ready' THEN 1 ELSE 0 END) e5,
            SUM(CASE WHEN l.status >= 400 AND l.status < 500 AND l.status <> 401 THEN 1 ELSE 0 END) e4,
            AVG(CAST(l.latency_ms AS bigint)) av, SUM(CASE WHEN l.latency_ms >= 5000 THEN 1 ELSE 0 END) o5
       FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? GROUP BY ${hourExpr('l.created_at')} ORDER BY h`,
    range
  )
  const caseBuckets = BUCKETS.map(
    (b, i) =>
      `SUM(CASE WHEN l.latency_ms ${i === 0 ? '' : `>= ${BUCKETS[i - 1]} AND l.latency_ms `}< ${b} THEN 1 ELSE 0 END) b${i}`
  ).join(', ')
  const [tot] = await rows(
    `SELECT COUNT(*) n, AVG(CAST(l.latency_ms AS bigint)) av,
            SUM(CASE WHEN l.latency_ms >= 1000 THEN 1 ELSE 0 END) o1, SUM(CASE WHEN l.latency_ms >= 5000 THEN 1 ELSE 0 END) o5,
            SUM(CASE WHEN l.latency_ms >= 30000 THEN 1 ELSE 0 END) o30,
            SUM(CASE WHEN l.path = '/api/analytics/pageview' THEN 1 ELSE 0 END) pv,
            SUM(CASE WHEN l.status = 401 THEN 1 ELSE 0 END) s401,
            SUM(CASE WHEN l.status = 503 AND l.path = '/api/ready' THEN 1 ELSE 0 END) drain,
            ${caseBuckets}, SUM(CASE WHEN l.latency_ms >= ${BUCKETS[BUCKETS.length - 1]} THEN 1 ELSE 0 END) b${BUCKETS.length}
       FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ?`,
    range
  )
  const total = num(tot?.n)
  const counts = Array.from({ length: BUCKETS.length + 1 }, (_, i) => num(tot?.[`b${i}`]))
  const hours = byHour.map((r) => ({
    hour: num(r.h),
    requests: num(r.n),
    people: num(r.u),
    e5: num(r.e5),
    e4: num(r.e4),
    avg_ms: num(r.av),
    over5s: num(r.o5)
  }))
  const peak = hours.reduce<OpsDigest['traffic']['peak']>(
    (best, h) =>
      !best || h.requests > best.requests
        ? { hour: h.hour, requests: h.requests, people: h.people }
        : best,
    null
  )

  const slow = await rows(
    `SELECT l.method, l.path, l.latency_ms ms, l.[user] u, l.created_at FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND l.latency_ms >= 3000`,
    range
  )
  const slowBy = new Map<string, { n: number; sum: number; max: number; people: Set<string> }>()
  const burstBy = new Map<
    string,
    { at: Date; route: string; n: number; people: Set<string>; max: number }
  >()
  for (const r of slow) {
    const route = `${r.method} ${routeOf(String(r.path))}`
    const e = slowBy.get(route) ?? { n: 0, sum: 0, max: 0, people: new Set<string>() }
    e.n++
    e.sum += num(r.ms)
    e.max = Math.max(e.max, num(r.ms))
    if (r.u) e.people.add(String(r.u))
    slowBy.set(route, e)
    const started = new Date(new Date(String(r.created_at)).getTime() - num(r.ms))
    const key = `${started.toISOString().slice(0, 16)}|${route}`
    const b = burstBy.get(key) ?? { at: started, route, n: 0, people: new Set<string>(), max: 0 }
    b.n++
    b.max = Math.max(b.max, num(r.ms))
    if (r.u) b.people.add(String(r.u))
    burstBy.set(key, b)
  }
  const vol = await rows(
    `SELECT l.method, l.path, COUNT(*) n, SUM(CAST(l.latency_ms AS bigint)) tot FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? GROUP BY l.method, l.path`,
    range
  )
  const heavy = new Map<string, { n: number; tot: number }>()
  for (const r of vol) {
    const route = `${r.method} ${routeOf(String(r.path))}`
    const e = heavy.get(route) ?? { n: 0, tot: 0 }
    e.n += num(r.n)
    e.tot += num(r.tot)
    heavy.set(route, e)
  }

  // ── Errors ──────────────────────────────────────────────────────────────────
  const e5 = await rows(
    `SELECT l.created_at, l.method, l.path, l.status, l.latency_ms ms, u.first_name, u.last_name FROM ${logs()} LEFT JOIN nivaro_users u ON u.id = l.[user]
      WHERE l.created_at >= ? AND l.created_at < ? AND l.status >= 500 AND l.path <> '/api/ready' ORDER BY l.created_at`,
    range
  )
  const e4 = await rows(
    `SELECT l.method, l.path, l.status, COUNT(*) n, COUNT(DISTINCT l.[user]) u, MAX(LEFT(l.error, 200)) err FROM ${logs()}
      WHERE l.created_at >= ? AND l.created_at < ? AND l.status >= 400 AND l.status < 500 AND l.status <> 401 GROUP BY l.method, l.path, l.status`,
    range
  )
  const e4By = new Map<
    string,
    { status: number; route: string; n: number; people: number; message: string }
  >()
  for (const r of e4) {
    const route = `${r.method} ${routeOf(String(r.path))}`
    const key = `${r.status} ${route}`
    const e = e4By.get(key) ?? {
      status: num(r.status),
      route,
      n: 0,
      people: 0,
      message: errorText(r.err)
    }
    e.n += num(r.n)
    e.people = Math.max(e.people, num(r.u))
    e4By.set(key, e)
  }

  // ── Deploys + drains ────────────────────────────────────────────────────────
  const deploys = await rows(
    `SELECT [timestamp] t, comment FROM nivaro_activity WHERE [timestamp] >= ? AND [timestamp] < ? AND action = 'infra-drift-baseline' ORDER BY [timestamp]`,
    range
  )
  const drains = await rows(
    `SELECT ${minuteKey('l.created_at')} m, MIN(l.created_at) t, COUNT(*) n FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND l.path = '/api/ready' AND l.status = 503 GROUP BY ${minuteKey('l.created_at')} ORDER BY m`,
    range
  )

  // ── Issues: deadlocks, timeouts, freezes, new and repeating ─────────────────
  const issues = await rows(
    `SELECT id, source, severity, title, details, occurrence_count c, created_at, last_seen_at FROM nivaro_issues
      WHERE (created_at >= ? AND created_at < ?) OR (last_seen_at >= ? AND last_seen_at < ?) ORDER BY created_at`,
    [S, E, S, E]
  )
  const deadlocks: OpsDigest['database']['deadlocks'] = []
  const timeouts: OpsDigest['database']['timeouts'] = []
  const freezes: OpsDigest['database']['freezes'] = []
  for (const r of issues) {
    const title = String(r.title ?? '')
    if (/deadlock-sweep/i.test(title)) {
      const sides = deadlockSides(String(r.details ?? ''))
      const when = /timestamp="([^"]+)"/.exec(String(r.details ?? ''))?.[1]
      deadlocks.push({
        issue: num(r.id),
        at: at(when ?? r.created_at),
        victim: sides.victim,
        other: sides.other
      })
    } else if (
      /Timeout: Request failed/i.test(`${title} ${String(r.details ?? '').slice(0, 4000)}`)
    )
      timeouts.push({ issue: num(r.id), title: title.slice(0, 200) })
    else if (/^Monitor failing/i.test(title))
      freezes.push({ issue: num(r.id), title: title.slice(0, 200) })
  }

  // ── Jobs ────────────────────────────────────────────────────────────────────
  const [jobN] = await rows(
    `SELECT COUNT(*) n FROM nivaro_job_runs WHERE started_at >= ? AND started_at < ?`,
    range
  )
  const jobFailed = await rows(
    `SELECT started_at, job_id, status, LEFT(error, 300) err FROM nivaro_job_runs WHERE started_at >= ? AND started_at < ? AND status NOT IN ('completed','running','skipped') ORDER BY started_at`,
    range
  )
  const jobSlow = await rows(
    `SELECT job_id, COUNT(*) n, MAX(duration_ms) mx, AVG(CAST(duration_ms AS bigint)) av FROM nivaro_job_runs WHERE started_at >= ? AND started_at < ? GROUP BY job_id ORDER BY MAX(duration_ms) DESC`,
    range
  )

  // ── Integrations ────────────────────────────────────────────────────────────
  const subs = await rows(
    `SELECT a.name api, s.status, COUNT(*) n FROM nivaro_erp_submissions s LEFT JOIN nivaro_external_apis a ON a.id = s.external_api WHERE s.created_at >= ? AND s.created_at < ? GROUP BY a.name, s.status ORDER BY a.name`,
    range
  )
  const subFail = await rows(
    `SELECT s.created_at, a.name api, s.collection, s.item, LEFT(s.last_error, 300) err FROM nivaro_erp_submissions s LEFT JOIN nivaro_external_apis a ON a.id = s.external_api
      WHERE s.created_at >= ? AND s.created_at < ? AND s.status NOT IN ('accepted','pending','skipped') ORDER BY s.created_at`,
    range
  )
  const calls = await rows(
    `SELECT a.name api, COUNT(*) n, SUM(CASE WHEN x.response_status >= 400 OR x.error IS NOT NULL THEN 1 ELSE 0 END) bad, AVG(CAST(x.duration_ms AS bigint)) av, MAX(x.duration_ms) mx
       FROM nivaro_external_api_logs x LEFT JOIN nivaro_external_apis a ON a.id = x.api_id WHERE x.created_at >= ? AND x.created_at < ? GROUP BY a.name ORDER BY n DESC`,
    range
  )
  const weekCalls = await rows(
    `SELECT a.name api, AVG(CAST(x.duration_ms AS bigint)) av FROM nivaro_external_api_logs x LEFT JOIN nivaro_external_apis a ON a.id = x.api_id
      WHERE x.created_at >= ? AND x.created_at < ? GROUP BY a.name`,
    [new Date(S.getTime() - 7 * 86_400_000), S]
  )
  const weekAvg = new Map(weekCalls.map((r) => [String(r.api ?? 'unknown'), num(r.av)]))
  const alarms = await rows(
    `SELECT api, kind, outcome, COUNT(*) n FROM nivaro_integration_obligations o WHERE outcome IN ('missing','failed','overdue')
       AND id = (SELECT MAX(id) FROM nivaro_integration_obligations x WHERE x.collection = o.collection AND x.item = o.item AND x.kind = o.kind) GROUP BY api, kind, outcome`
  )
  const incidents = await rows(
    `SELECT title, status, started_at, ended_at FROM nivaro_ops_incidents WHERE started_at < ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at`,
    [E, S]
  )

  // ── Imports, mail, notifications ────────────────────────────────────────────
  const imports = await rows(
    `SELECT COALESCE(d.label, d.[key], CAST(q.definition AS varchar(20))) def, q.status, COUNT(*) n, SUM(COALESCE(q.row_count, 0)) rws
       FROM nivaro_import_queue q LEFT JOIN nivaro_import_definitions d ON d.id = q.definition WHERE q.created_at >= ? AND q.created_at < ?
      GROUP BY COALESCE(d.label, d.[key], CAST(q.definition AS varchar(20))), q.status`,
    range
  )
  const mailStatus = await rows(
    `SELECT status, COUNT(*) n FROM nivaro_mail_log WHERE created_at >= ? AND created_at < ? GROUP BY status`,
    range
  )
  const mailWhy = await rows(
    `SELECT LEFT(COALESCE(error, status), 120) r, COUNT(*) n FROM nivaro_mail_log WHERE created_at >= ? AND created_at < ? AND status <> 'sent' GROUP BY LEFT(COALESCE(error, status), 120) ORDER BY n DESC`,
    range
  )
  const notes = await rows(
    `SELECT category, COUNT(*) n, COUNT(DISTINCT recipient) r, SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) rd FROM nivaro_notifications WHERE [timestamp] >= ? AND [timestamp] < ? GROUP BY category ORDER BY n DESC`,
    range
  )

  // ── Work done + backlog ─────────────────────────────────────────────────────
  const [moves] = await rows(
    `SELECT COUNT(*) n, COUNT(DISTINCT [user]) u FROM nivaro_workflow_history WHERE [timestamp] >= ? AND [timestamp] < ?`,
    range
  )
  const byState = await rows(
    `SELECT s.label st, COUNT(*) n FROM nivaro_workflow_history h JOIN nivaro_workflow_states s ON s.id = h.to_state WHERE h.[timestamp] >= ? AND h.[timestamp] < ? GROUP BY s.label ORDER BY n DESC`,
    range
  )
  const creates = await rows(
    `SELECT collection, COUNT(*) n, COUNT(DISTINCT [user]) u FROM nivaro_activity WHERE [timestamp] >= ? AND [timestamp] < ? AND action = 'create' AND collection NOT LIKE 'nivaro[_]%' GROUP BY collection ORDER BY n DESC`,
    range
  )
  const backlog = await rows(
    `SELECT s.label st, COUNT(*) n, MIN(i.started_at) oldest FROM nivaro_workflow_instances i JOIN nivaro_workflow_states s ON s.id = i.current_state
      WHERE i.completed_at IS NULL AND (s.is_terminal = 0 OR s.is_terminal IS NULL) GROUP BY s.label ORDER BY n DESC`
  )

  // ── Search, config, security ────────────────────────────────────────────────
  const [search] = await rows(
    `SELECT COUNT(*) n, COUNT(DISTINCT [user]) u, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) z, AVG(duration_ms) av FROM nivaro_search_log WHERE created_at >= ? AND created_at < ?`,
    range
  )
  const missed = await rows(
    `SELECT LEFT(query, 80) q, COUNT(*) n FROM nivaro_search_log WHERE created_at >= ? AND created_at < ? AND result_count = 0 GROUP BY LEFT(query, 80) ORDER BY n DESC`,
    range
  )
  let configChanges: OpsDigest['config_changes'] = []
  try {
    const { configChangesBetween } = await import('../overview/data.js')
    configChanges = (await configChangesBetween(S, E, 60)).map((r) => ({ ...r, at: at(r.at) }))
  } catch {
    configChanges = []
  }
  const [newPlaces] = await rows(
    `SELECT COUNT(*) n FROM nivaro_login_events WHERE created_at >= ? AND created_at < ? AND new_ip = 1 AND method <> 'masquerade'`,
    range
  )
  const [sec] = await rows(
    `SELECT SUM(CASE WHEN collection = 'nivaro_users' AND action = 'update' AND comment LIKE '%role%' THEN 1 ELSE 0 END) rc,
            SUM(CASE WHEN action = 'access-request-grant' THEN 1 ELSE 0 END) g,
            SUM(CASE WHEN action = 'access-request' THEN 1 ELSE 0 END) rq
       FROM nivaro_activity WHERE [timestamp] >= ? AND [timestamp] < ?`,
    range
  )
  const [waitAuth] = await rows(
    `SELECT COUNT(*) n FROM nivaro_users u JOIN nivaro_settings s ON s.access_request_role = u.role WHERE u.status = 'active'`
  )

  const more = await buildMore(win, extras)
  const digest: OpsDigest = {
    version: DIGEST_VERSION,
    window: {
      day: win.day,
      start: S.toISOString(),
      end: E.toISOString(),
      tz: win.tz,
      label: `${win.day}, ${clock(S, win.tz)} – ${clock(E, win.tz)}`
    },
    people,
    traffic: { requests: total, page_views: num(tot?.pv), peak, by_hour: hours },
    speed: {
      avg_ms: num(tot?.av),
      p50: percentileFromBuckets(counts, total, 0.5),
      p90: percentileFromBuckets(counts, total, 0.9),
      p95: percentileFromBuckets(counts, total, 0.95),
      p99: percentileFromBuckets(counts, total, 0.99),
      over1s: num(tot?.o1),
      over5s: num(tot?.o5),
      over30s: num(tot?.o30),
      slow_routes: [...slowBy.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 15)
        .map(([route, e]) => ({
          route,
          n: e.n,
          avg_ms: Math.round(e.sum / e.n),
          max_ms: e.max,
          people: e.people.size
        })),
      heavy_routes: [...heavy.entries()]
        .sort((a, b) => b[1].tot - a[1].tot)
        .slice(0, 12)
        .map(([route, e]) => ({
          route,
          total_s: Math.round(e.tot / 1000),
          n: e.n,
          avg_ms: Math.round(e.tot / e.n)
        })),
      bursts: [...burstBy.values()]
        .filter((b) => b.n >= 5)
        .sort((a, b) => b.n - a.n)
        .slice(0, 10)
        .map((b) => ({
          at: clock(b.at, win.tz),
          route: b.route,
          n: b.n,
          people: b.people.size,
          max_ms: b.max
        }))
    },
    errors: {
      server: e5.slice(0, 40).map((r) => ({
        at: at(r.created_at),
        route: `${r.method} ${routeOf(String(r.path))}`,
        path: String(r.path).slice(0, 200),
        status: num(r.status),
        ms: num(r.ms),
        person: personName(r)
      })),
      server_total: e5.length,
      drain_503: num(tot?.drain),
      client_by_route: [...e4By.values()].sort((a, b) => b.n - a.n).slice(0, 20),
      signed_out_401: num(tot?.s401)
    },
    deploys: deploys.map((r) => {
      const c = String(r.comment ?? '')
      return {
        at: at(r.t),
        version: /version ([0-9][\w.-]*)/.exec(c)?.[1] ?? null,
        release: /release ([\w.-]+)/.exec(c)?.[1] ?? null
      }
    }),
    drains: drains.map((r) => ({ at: at(r.t), n: num(r.n) })),
    database: { deadlocks, timeouts, freezes },
    issues: {
      new: issues
        .filter(
          (r) => new Date(String(r.created_at)) >= S && !/deadlock-sweep/i.test(String(r.title))
        )
        .slice(0, 25)
        .map((r) => ({
          id: num(r.id),
          source: String(r.source ?? ''),
          severity: String(r.severity ?? ''),
          title: String(r.title ?? '').slice(0, 200),
          count: num(r.c)
        })),
      repeating: issues
        .filter((r) => new Date(String(r.created_at)) < S)
        .slice(0, 15)
        .map((r) => ({
          id: num(r.id),
          title: String(r.title ?? '').slice(0, 200),
          count: num(r.c)
        }))
    },
    jobs: {
      runs: num(jobN?.n),
      failed: jobFailed.slice(0, 20).map((r) => ({
        job: String(r.job_id),
        at: at(r.started_at),
        status: String(r.status),
        error: r.err ? String(r.err) : null
      })),
      slowest: jobSlow
        .slice(0, 10)
        .map((r) => ({ job: String(r.job_id), n: num(r.n), max_ms: num(r.mx), avg_ms: num(r.av) }))
    },
    integrations: {
      submissions: subs.map((r) => ({
        api: String(r.api ?? 'unknown'),
        status: String(r.status),
        n: num(r.n)
      })),
      failures: subFail.slice(0, 25).map((r) => ({
        at: at(r.created_at),
        api: String(r.api ?? 'unknown'),
        collection: String(r.collection ?? ''),
        item: String(r.item ?? ''),
        error: errorText(r.err)
      })),
      calls: calls.map((r) => ({
        api: String(r.api ?? 'unknown'),
        n: num(r.n),
        failed: num(r.bad),
        avg_ms: num(r.av),
        max_ms: num(r.mx),
        week_avg_ms: weekAvg.get(String(r.api ?? 'unknown')) ?? null
      })),
      open_alarms: alarms.map((r) => ({
        api: String(r.api),
        kind: String(r.kind),
        outcome: String(r.outcome),
        n: num(r.n)
      })),
      alerts: incidents.map((r) => ({
        title: String(r.title ?? '').slice(0, 160),
        status: String(r.status ?? ''),
        started: at(r.started_at),
        ended: r.ended_at ? at(r.ended_at) : null
      }))
    },
    imports: imports.map((r) => ({
      definition: String(r.def),
      status: String(r.status),
      runs: num(r.n),
      rows: num(r.rws)
    })),
    mail: {
      by_status: mailStatus.map((r) => ({ status: String(r.status), n: num(r.n) })),
      reasons: mailWhy.slice(0, 10).map((r) => ({ reason: String(r.r ?? ''), n: num(r.n) }))
    },
    notifications: notes.map((r) => ({
      category: String(r.category ?? 'other'),
      n: num(r.n),
      recipients: num(r.r),
      read: num(r.rd)
    })),
    work: {
      moves: num(moves?.n),
      movers: num(moves?.u),
      by_state: byState.slice(0, 20).map((r) => ({ state: String(r.st), n: num(r.n) })),
      creates: creates
        .slice(0, 12)
        .map((r) => ({ collection: String(r.collection), n: num(r.n), people: num(r.u) })),
      backlog: backlog.slice(0, 20).map((r) => ({
        state: String(r.st),
        waiting: num(r.n),
        oldest_days: r.oldest
          ? Math.floor((E.getTime() - new Date(String(r.oldest)).getTime()) / 86_400_000)
          : null
      })),
      sla_breaches: more.sla_breaches
    },
    search: {
      n: num(search?.n),
      people: num(search?.u),
      zero: num(search?.z),
      avg_ms: num(search?.av),
      missed: missed.slice(0, 12).map((r) => ({ query: String(r.q), n: num(r.n) }))
    },
    config_changes: configChanges,
    security: {
      new_places: num(newPlaces?.n),
      failed_sign_ins: more.failed_sign_ins,
      view_as: viewAs.map((r) => ({ who: personName(r), at: at(r.created_at) })),
      role_changes: more.role_changes,
      api_key_use: machines
        .filter((r) => r.name && !['session', 'token', 'none'].includes(String(r.name)))
        .slice(0, 10)
        .map((r) => ({ name: String(r.name), requests: num(r.n) })),
      access_grants: num(sec?.g),
      access_requests: num(sec?.rq),
      waiting_authorization: num(waitAuth?.n)
    },
    capacity: more.capacity,
    watch: more.watch,
    sections: more.sections,
    pages: more.pages,
    client_errors: more.client_errors,
    adoption: more.adoption,
    support: more.support,
    ai: more.ai,
    data_quality: more.data_quality,
    owners: more.owners,
    score: { value: 100, parts: [] }
  }
  digest.score = scoreDigest(digest)
  return digest
}

/**
 * The day's health score from the numbers alone (no AI), so the trend exists for every day.
 * Starts at 100; each part takes points off with a cap, and lists itself when it does.
 */
export function scoreDigest(d: OpsDigest): OpsDigest['score'] {
  const parts: Array<{ label: string; points: number }> = []
  const take = (label: string, points: number) => {
    const p = Math.round(points)
    if (p > 0) parts.push({ label, points: p })
  }
  const per1k = d.traffic.requests > 0 ? 1000 / d.traffic.requests : 0
  take(`${d.errors.server_total} server errors`, Math.min(20, d.errors.server_total * 2))
  take(
    `${d.database.deadlocks.length} database deadlocks`,
    Math.min(10, d.database.deadlocks.length * 2.5)
  )
  take(`${d.speed.over5s} requests over 5 s`, Math.min(15, d.speed.over5s * per1k * 20))
  take(
    `p95 ${d.speed.p95 ?? 0} ms`,
    d.speed.p95 != null && d.speed.p95 > 500 ? Math.min(10, (d.speed.p95 - 500) / 100) : 0
  )
  const failedSends = d.integrations.failures.length
  take(`${failedSends} partner sends failed`, Math.min(10, failedSends))
  const alarms = d.integrations.open_alarms.reduce((n, a) => n + a.n, 0)
  take(`${alarms} open integration alarms`, Math.min(10, alarms * 0.5))
  take(`${d.jobs.failed.length} failed jobs`, Math.min(10, d.jobs.failed.length * 2))
  take(`${d.database.freezes.length} server freezes`, Math.min(10, d.database.freezes.length * 5))
  take(`${d.people.trouble.length} people hit trouble`, Math.min(10, d.people.trouble.length))
  take(`${d.client_errors.length} browser errors`, Math.min(5, d.client_errors.length))
  const value = Math.max(0, 100 - parts.reduce((n, p) => n + p.points, 0))
  return { value, parts: parts.sort((a, b) => b.points - a.points) }
}

function personName(r: Row): string | null {
  const n = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim()
  return n || null
}

/** A stored error body → its message, never the raw JSON. */
export function errorText(raw: unknown): string {
  const s = String(raw ?? '')
  const m = /"(?:message|error)"\s*:\s*"([^"]{1,200})/.exec(s)
  return (m?.[1] ?? s).replace(/\s+/g, ' ').slice(0, 200)
}

/** Minutes the zone is ahead of UTC at the window start (grouping by the instance's hour). */
function offsetMinutes(win: ReportWindow): number {
  const local = new Date(new Date(win.start).toLocaleString('en-US', { timeZone: win.tz }))
  const utc = new Date(new Date(win.start).toLocaleString('en-US', { timeZone: 'UTC' }))
  return Math.round((local.getTime() - utc.getTime()) / 60_000)
}

/** Midnight of the window's day (sign-ins earlier the same morning count as today's). */
function dayStart(win: ReportWindow): Date {
  return new Date(win.start.getTime() - hoursSinceMidnight(win) * 3_600_000)
}

function hoursSinceMidnight(win: ReportWindow): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: win.tz,
      hour: '2-digit',
      hourCycle: 'h23'
    }).format(win.start)
  )
}

/** Both sides of a stored deadlock report: what the victim and the other session were running. */
export function deadlockSides(details: string): { victim: string; other: string } {
  const victimIds = new Set([...details.matchAll(/<victimProcess id="([^"]+)"/g)].map((m) => m[1]))
  const procs = [
    ...details.matchAll(/<process id="([^"]+)"[\s\S]*?<inputbuf>([\s\S]*?)<\/inputbuf>/g)
  ].map((m) => ({
    id: m[1],
    sql: stripParamList(m[2])
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220)
  }))
  const victim = procs.find((p) => victimIds.has(p.id))?.sql ?? ''
  const other = procs.find((p) => !victimIds.has(p.id))?.sql ?? (procs.length ? '' : 'not recorded')
  return {
    victim: victim || 'not recorded',
    other: other || 'not recorded (the other side was cut from the stored report)'
  }
}

/** sp_executesql text starts with its parameter list `(@p0 nvarchar(36), …)`: drop it. */
export function stripParamList(sql: string): string {
  const t = sql.trim()
  if (!t.startsWith('(@')) return t
  let depth = 0
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++
    else if (t[i] === ')' && --depth === 0) return t.slice(i + 1)
  }
  return t
}

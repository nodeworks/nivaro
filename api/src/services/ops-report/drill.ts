/**
 * Daily operations report — drill-down (#ops-report): the rows behind any number, for one
 * report's window, down to the single thing (a request, an issue, a job run, a partner send,
 * an outbound call, a mail, a sign-in, a person's day). Administrators only; read-only.
 *
 * Every list row that can go further carries `_drill_metric` + `_drill_key`; a row that is a
 * record carries `_record_collection` + `_record_id` (the page opens the shared record drawer);
 * `_link` is an app path offered as an explicit "Open".
 */
import type { Knex } from 'knex'
import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import { scrubText } from '../ai-explain.js'
import { routeOf } from './digest-route.js'
import type { OpsDigest, OpsDrill, OpsDrillColumn, OpsDrillMetric, OpsTrackedBug } from './types.js'
import { clock } from './window.js'

type Row = Record<string, unknown>
type Cell = string | number | null
type DrillRow = Record<string, Cell>

export interface DrillWindow {
  start: Date
  end: Date
  tz: string
  day: string
}

export class DrillError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v))
const name = (r: Row, f = 'first_name', l = 'last_name') =>
  `${r[f] ?? ''} ${r[l] ?? ''}`.trim() || null
const logs = () => (isMssql(db) ? 'nivaro_api_logs AS l WITH (NOLOCK)' : 'nivaro_api_logs AS l')

async function rows(sql: string, bindings: readonly unknown[] = []): Promise<Row[]> {
  try {
    const r = (await db.raw(sql, bindings as Knex.RawBinding[])) as unknown
    return Array.isArray(r) ? (r as Row[]) : ((r as { rows?: Row[] })?.rows ?? [])
  } catch {
    return []
  }
}

const C = {
  time: { key: 'time', label: 'Time', type: 'time' } as OpsDrillColumn,
  person: { key: 'person', label: 'Person' } as OpsDrillColumn,
  route: { key: 'route', label: 'Route' } as OpsDrillColumn,
  status: { key: 'status', label: 'Status', type: 'status' } as OpsDrillColumn,
  ms: { key: 'ms', label: 'Time taken', type: 'ms' } as OpsDrillColumn,
  n: { key: 'n', label: 'Count', type: 'number' } as OpsDrillColumn,
  people: { key: 'people', label: 'People', type: 'number' } as OpsDrillColumn,
  message: { key: 'message', label: 'Message' } as OpsDrillColumn
}

const LIMIT_MAX = 500

/** "4:00 PM" on the window's day → that minute (for a burst key). */
export function minuteOf(win: DrillWindow, label: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label.trim())
  if (!m) return null
  let h = Number(m[1]) % 12
  if (m[3].toUpperCase() === 'PM') h += 12
  const target = h * 60 + Number(m[2])
  // Walk the window minute by minute is wasteful; step from the start by the local offset.
  const startLocal = new Intl.DateTimeFormat('en-US', {
    timeZone: win.tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
    .format(win.start)
    .split(':')
    .map(Number)
  const startMin = startLocal[0] * 60 + startLocal[1]
  return new Date(win.start.getTime() + (target - startMin) * 60_000)
}

/** The requests query every request-list drill shares: newest or slowest first. */
async function requestRows(
  win: DrillWindow,
  where: string,
  bindings: unknown[],
  limit: number,
  order: 'slow' | 'time' = 'time'
): Promise<{ rows: DrillRow[]; total: number }> {
  const [cnt] = await rows(
    `SELECT COUNT(*) n FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND ${where}`,
    [win.start, win.end, ...bindings]
  )
  const list = await rows(
    `SELECT TOP ${limit} l.id, l.created_at, l.method, l.path, l.status, l.latency_ms, l.[user], l.auth, u.first_name, u.last_name, LEFT(l.error, 200) err
       FROM ${logs()} LEFT JOIN nivaro_users u ON u.id = l.[user]
      WHERE l.created_at >= ? AND l.created_at < ? AND ${where}
      ORDER BY ${order === 'slow' ? 'l.latency_ms DESC' : 'l.created_at'}`,
    [win.start, win.end, ...bindings]
  )
  return {
    total: num(cnt?.n),
    rows: list.map((r) => ({
      time: clock(new Date(String(r.created_at)), win.tz),
      person: name(r) ?? (r.auth === 'none' ? 'Not signed in' : String(r.auth ?? '')),
      route: `${r.method} ${r.path}`,
      status: num(r.status),
      ms: num(r.latency_ms),
      message: r.err ? errorText(r.err) : null,
      _drill_metric: 'request',
      _drill_key: String(r.id)
    }))
  }
}

const REQ_COLS = [C.time, C.person, C.route, C.status, C.ms, C.message]

function errorText(raw: unknown): string {
  const s = String(raw ?? '')
  const m = /"(?:message|error)"\s*:\s*"([^"]{1,200})/.exec(s)
  return (m?.[1] ?? s).replace(/\s+/g, ' ').slice(0, 200)
}

/** "POST /api/x/:id/y" → a LIKE pattern over raw paths, plus the method. */
function routeFilter(route: string): { where: string; bindings: unknown[] } {
  const [method, ...rest] = route.split(' ')
  const pattern = rest.join(' ')
  const like = pattern.replace(/[%_[]/g, '[$&]').replace(/:uuid|:id|:key/g, '%')
  return {
    where: `l.method = ? AND l.path LIKE ?`,
    bindings: [method, like]
  }
}

/** Requests whose path folds to exactly `route` (LIKE is wider: re-check in code). */
async function routeRequests(
  win: DrillWindow,
  route: string,
  limit: number,
  order: 'slow' | 'time',
  extra = ''
) {
  const f = routeFilter(route)
  const r = await requestRows(
    win,
    `${f.where}${extra}`,
    f.bindings,
    Math.min(LIMIT_MAX * 2, limit * 3),
    order
  )
  const exact = r.rows.filter(
    (x) =>
      `${String(x.route).split(' ')[0]} ${routeOf(String(x.route).split(' ').slice(1).join(' '))}` ===
      route
  )
  return { rows: exact.slice(0, limit), total: r.total }
}

function people(
  rowsIn: Row[],
  win: DrillWindow,
  extra: (r: Row) => DrillRow = () => ({})
): DrillRow[] {
  return rowsIn.map((r) => ({
    person: name(r) ?? String(r.email ?? r.id ?? ''),
    email: str(r.email),
    role: str(r.role),
    ...extra(r),
    _drill_metric: 'person',
    _drill_key: String(r.id),
    _link: `/users/${r.id}`
  }))
}

/** What else happened around one moment: writes by origin, jobs that started, deploys and
 *  drains, imports, partner calls. Two things at the same minute are a lead, not proof. */
export async function aroundBlock(
  at: Date,
  tz: string,
  minutes = 2
): Promise<{ title: string; text: string; kind: 'text' }> {
  const from = new Date(at.getTime() - minutes * 60_000)
  const to = new Date(at.getTime() + minutes * 60_000)
  const lines: string[] = []
  const writes = await rows(
    `SELECT a.action, a.collection, COALESCE(a.origin, 'person') origin, COUNT(*) n, COUNT(DISTINCT a.[user]) u FROM nivaro_activity a
      WHERE a.[timestamp] >= ? AND a.[timestamp] < ? AND a.action NOT IN ('read', 'login', 'lock-acquire', 'lock-release')
      GROUP BY a.action, a.collection, COALESCE(a.origin, 'person') ORDER BY n DESC`,
    [from, to]
  )
  for (const w of writes.slice(0, 15))
    lines.push(
      `write: ${num(w.n)} × ${w.action} ${w.collection} by ${w.origin} (${num(w.u)} people)`
    )
  const jobs = await rows(
    `SELECT job_id, started_at, duration_ms, status FROM nivaro_job_runs WHERE started_at >= ? AND started_at < ? ORDER BY started_at`,
    [from, to]
  )
  for (const j of jobs.slice(0, 12))
    lines.push(
      `job: ${j.job_id} started ${clock(new Date(String(j.started_at)), tz)}, ${num(j.duration_ms)} ms, ${j.status}`
    )
  const dep = await rows(
    `SELECT [timestamp] t, LEFT(comment, 120) c FROM nivaro_activity WHERE action = 'infra-drift-baseline' AND [timestamp] >= ? AND [timestamp] < ?`,
    [new Date(from.getTime() - 10 * 60_000), new Date(to.getTime() + 10 * 60_000)]
  )
  for (const d of dep) lines.push(`deploy: ${clock(new Date(String(d.t)), tz)} ${d.c}`)
  const [dr] = await rows(
    `SELECT COUNT(*) n FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND l.path = '/api/ready' AND l.status = 503`,
    [from, to]
  )
  if (num(dr?.n))
    lines.push(`drain: ${num(dr?.n)} not-ready answers (a server shutting down for a deploy)`)
  const admin = await rows(
    `SELECT l.method, l.path, COUNT(*) n, MAX(l.latency_ms) mx FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND l.method IN ('POST', 'PATCH', 'PUT', 'DELETE') AND l.status < 400
      GROUP BY l.method, l.path HAVING COUNT(*) >= 3 OR MAX(l.latency_ms) >= 5000 ORDER BY COUNT(*) DESC`,
    [from, to]
  )
  for (const a of admin.slice(0, 10))
    lines.push(
      `busy write route: ${a.method} ${routeOf(String(a.path))} × ${num(a.n)} (slowest ${num(a.mx)} ms)`
    )
  const calls = await rows(
    `SELECT a.name api, COUNT(*) n, SUM(CASE WHEN x.response_status >= 400 OR x.error IS NOT NULL THEN 1 ELSE 0 END) bad FROM nivaro_external_api_logs x LEFT JOIN nivaro_external_apis a ON a.id = x.api_id WHERE x.created_at >= ? AND x.created_at < ? GROUP BY a.name`,
    [from, to]
  )
  for (const c of calls) lines.push(`partner calls: ${c.api} × ${num(c.n)} (${num(c.bad)} failed)`)
  return {
    title: `Around ${clock(at, tz)} (±${minutes} min)`,
    text: lines.length ? lines.join('\n') : 'Nothing else recorded.',
    kind: 'text'
  }
}

/** "Invalid column name 'x'" on a field the data model has: say whether it is stored. */
export async function columnHint(text: string): Promise<string | null> {
  const m =
    /Invalid column name '([^']+)'[\s\S]{0,400}?from \[([\w]+)\]|from \[([\w]+)\][\s\S]{0,400}?Invalid column name '([^']+)'/i.exec(
      text
    )
  const field = m?.[1] ?? m?.[4]
  const coll = m?.[2] ?? m?.[3]
  if (!field || !coll) return null
  const [f] = await rows(
    `SELECT field, computed_type FROM nivaro_fields WHERE collection = ? AND field = ?`,
    [coll, field]
  )
  if (!f) return `${coll}.${field} is not in the data model either: a removed or misspelt field.`
  if (f.computed_type)
    return `${coll}.${field} is a calculated field (${f.computed_type}) with no database column: code read it as a column. A code bug, not a dropped column.`
  return `${coll}.${field} is a stored field in the data model but its column is missing: a migration or a manual change dropped it.`
}

/**
 * The rows behind one number. `key` narrows to one list row; leaf metrics return `detail`.
 */
export async function drill(
  win: DrillWindow,
  metric: OpsDrillMetric,
  key: string | null,
  limitRaw = 200,
  ctx: { digest?: OpsDigest | null; tracker?: OpsTrackedBug[] } = {}
): Promise<OpsDrill> {
  const limit = Math.min(Math.max(Number(limitRaw) || 200, 1), LIMIT_MAX)
  const S = win.start
  const E = win.end
  const range = [S, E]
  const t = (v: unknown) => (v ? clock(new Date(String(v)), win.tz) : null)
  const out = (
    title: string,
    description: string,
    columns: OpsDrillColumn[],
    list: DrillRow[],
    total = list.length,
    detail?: OpsDrill['detail']
  ): OpsDrill => ({
    metric,
    key,
    title,
    description,
    columns,
    rows: list,
    total,
    truncated: total > list.length,
    ...(detail ? { detail } : {})
  })

  switch (metric) {
    // ── People ────────────────────────────────────────────────────────────────
    case 'active_people':
    case 'trouble_people': {
      const r = await rows(
        `SELECT u.id, u.first_name, u.last_name, u.email, ro.name role, COUNT(*) n,
                SUM(CASE WHEN l.status >= 500 OR l.status IN (400, 403, 409, 415) THEN 1 ELSE 0 END) errs,
                SUM(CASE WHEN l.latency_ms >= 5000 THEN 1 ELSE 0 END) slow,
                SUM(CASE WHEN l.status = 422 AND l.path LIKE '%/transition' THEN 1 ELSE 0 END) blocked,
                MIN(l.created_at) first_at, MAX(l.created_at) last_at
           FROM ${logs()} JOIN nivaro_users u ON u.id = l.[user] LEFT JOIN nivaro_roles ro ON ro.id = u.role
          WHERE l.created_at >= ? AND l.created_at < ? AND l.auth IN ('session', 'masquerade')
          GROUP BY u.id, u.first_name, u.last_name, u.email, ro.name`,
        range
      )
      const list = (
        metric === 'trouble_people'
          ? r
              .filter((x) => num(x.errs) + num(x.slow) + num(x.blocked) >= 3)
              .sort(
                (a, b) =>
                  num(b.errs) +
                  num(b.slow) +
                  num(b.blocked) -
                  (num(a.errs) + num(a.slow) + num(a.blocked))
              )
          : r.sort((a, b) => num(b.n) - num(a.n))
      ).slice(0, limit)
      return out(
        metric === 'trouble_people' ? 'People who hit trouble' : 'Active people',
        metric === 'trouble_people'
          ? 'People with 3 or more errors, refusals, requests over 5 s or blocked moves in the window.'
          : 'Everyone signed in who made a request in the window, busiest first.',
        [
          C.person,
          { key: 'role', label: 'Role' },
          { key: 'requests', label: 'Requests', type: 'number' },
          { key: 'errors', label: 'Errors', type: 'number' },
          { key: 'slow', label: 'Over 5 s', type: 'number' },
          { key: 'blocked', label: 'Blocked moves', type: 'number' },
          { key: 'first', label: 'First seen', type: 'time' },
          { key: 'last', label: 'Last seen', type: 'time' }
        ],
        people(list, win, (x) => ({
          requests: num(x.n),
          errors: num(x.errs),
          slow: num(x.slow),
          blocked: num(x.blocked),
          first: t(x.first_at),
          last: t(x.last_at)
        })),
        metric === 'trouble_people' ? list.length : r.length
      )
    }
    case 'signed_in_today':
    case 'new_places':
    case 'view_as_sessions': {
      const where =
        metric === 'view_as_sessions'
          ? `e.method = 'masquerade'`
          : metric === 'new_places'
            ? `e.method <> 'masquerade' AND e.new_ip = 1`
            : `e.method <> 'masquerade'`
      const r = await rows(
        `SELECT TOP ${limit} e.id eid, e.created_at, e.method, e.ip, LEFT(e.user_agent, 120) ua, e.new_ip, u.id, u.first_name, u.last_name, u.email, ro.name role
           FROM nivaro_login_events e LEFT JOIN nivaro_users u ON u.id = e.[user] LEFT JOIN nivaro_roles ro ON ro.id = u.role
          WHERE e.created_at >= ? AND e.created_at < ? AND ${where} ORDER BY e.created_at`,
        range
      )
      const [cnt] = await rows(
        `SELECT COUNT(*) n FROM nivaro_login_events e WHERE e.created_at >= ? AND e.created_at < ? AND ${where}`,
        range
      )
      return out(
        metric === 'view_as_sessions'
          ? 'View-as sessions'
          : metric === 'new_places'
            ? 'Sign-ins from new places'
            : 'Microsoft sign-ins today',
        metric === 'view_as_sessions'
          ? 'An administrator opening the app as someone else. Not a person signing in.'
          : metric === 'new_places'
            ? 'Sign-ins from an address this person had not used before (shared proxies make this noisy).'
            : 'Each time someone went through Microsoft sign-in. People still signed in from an earlier day are not here.',
        [
          C.time,
          C.person,
          { key: 'role', label: 'Role' },
          { key: 'ip', label: 'Address' },
          { key: 'browser', label: 'Browser' }
        ],
        r.map((x) => ({
          time: t(x.created_at),
          person: name(x) ?? String(x.email ?? ''),
          role: str(x.role),
          ip: str(x.ip),
          browser: str(x.ua),
          _drill_metric: 'login',
          _drill_key: String(x.eid)
        })),
        num(cnt?.n)
      )
    }
    case 'carried_sessions': {
      const midnight = new Date(
        S.getTime() -
          Number(
            new Intl.DateTimeFormat('en-US', {
              timeZone: win.tz,
              hour: '2-digit',
              hourCycle: 'h23'
            }).format(S)
          ) *
            3_600_000
      )
      const r = await rows(
        `SELECT u.id, u.first_name, u.last_name, u.email, ro.name role, COUNT(*) n, MIN(l.created_at) first_at,
                (SELECT MAX(e.created_at) FROM nivaro_login_events e WHERE e.[user] = u.id AND e.method <> 'masquerade') last_signin
           FROM ${logs()} JOIN nivaro_users u ON u.id = l.[user] LEFT JOIN nivaro_roles ro ON ro.id = u.role
          WHERE l.created_at >= ? AND l.created_at < ? AND l.auth = 'session'
            AND NOT EXISTS (SELECT 1 FROM nivaro_login_events e WHERE e.[user] = l.[user] AND e.created_at >= ? AND e.created_at < ? AND e.method <> 'masquerade')
          GROUP BY u.id, u.first_name, u.last_name, u.email, ro.name ORDER BY COUNT(*) DESC`,
        [S, E, midnight, E]
      )
      return out(
        'Still signed in from an earlier day',
        'People who used the app today without signing in today: their sign-in from an earlier day was still valid (a sign-in lasts several days).',
        [
          C.person,
          { key: 'role', label: 'Role' },
          { key: 'requests', label: 'Requests', type: 'number' },
          { key: 'first', label: 'First seen', type: 'time' },
          { key: 'last_signin', label: 'Last signed in' }
        ],
        people(r.slice(0, limit), win, (x) => ({
          requests: num(x.n),
          first: t(x.first_at),
          last_signin: x.last_signin
            ? new Date(String(x.last_signin)).toISOString().slice(0, 10)
            : 'Before sign-ins were logged'
        })),
        r.length
      )
    }
    case 'new_accounts': {
      const r = await rows(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.created_at, ro.name role FROM nivaro_users u LEFT JOIN nivaro_roles ro ON ro.id = u.role
          WHERE u.created_at >= ? AND u.created_at < ? AND (u.account_kind IS NULL OR u.account_kind = '') ORDER BY u.created_at`,
        range
      )
      return out(
        'New accounts',
        'People whose account was created in the window (their first sign-in).',
        [C.person, { key: 'role', label: 'Role' }, C.time],
        people(r.slice(0, limit), win, (x) => ({ time: t(x.created_at) })),
        r.length
      )
    }
    case 'machine_callers':
    case 'api_key_use': {
      if (key) {
        const r = await requestRows(
          win,
          `(l.auth IN ('token','api_key') OR l.api_key_id IS NOT NULL) AND (l.api_key_id IN (SELECT id FROM nivaro_api_keys WHERE name = ?) OR l.[user] IN (SELECT id FROM nivaro_users WHERE first_name + ' ' + last_name = ?))`,
          [key, key],
          limit
        )
        return out(
          `Requests by ${key}`,
          'Every request this machine caller made in the window.',
          REQ_COLS,
          r.rows,
          r.total
        )
      }
      const r = await rows(
        `SELECT COALESCE(k.name, u.first_name + ' ' + u.last_name, l.auth) nm, COUNT(*) n, SUM(CASE WHEN l.status >= 400 THEN 1 ELSE 0 END) e, MAX(l.created_at) last_at
           FROM ${logs()} LEFT JOIN nivaro_api_keys k ON k.id = l.api_key_id LEFT JOIN nivaro_users u ON u.id = l.[user]
          WHERE l.created_at >= ? AND l.created_at < ? AND (l.auth IN ('token','api_key') OR l.api_key_id IS NOT NULL)
          GROUP BY COALESCE(k.name, u.first_name + ' ' + u.last_name, l.auth) ORDER BY n DESC`,
        range
      )
      return out(
        'Machine callers',
        'Integrations, API keys and service accounts — not people.',
        [
          { key: 'caller', label: 'Caller' },
          C.n,
          { key: 'errors', label: 'Errors', type: 'number' },
          { key: 'last', label: 'Last call', type: 'time' }
        ],
        r.map((x) => ({
          caller: String(x.nm),
          n: num(x.n),
          errors: num(x.e),
          last: t(x.last_at),
          _drill_metric: metric,
          _drill_key: String(x.nm)
        }))
      )
    }
    case 'person': {
      if (!key) throw new DrillError(400, 'Name the person')
      if (!/^[0-9a-f-]{36}$/i.test(key)) {
        const [byName] = await rows(
          `SELECT TOP 1 id FROM nivaro_users WHERE first_name + ' ' + last_name = ? ORDER BY last_access DESC`,
          [key]
        )
        if (!byName) throw new DrillError(404, 'That person is not here')
        return drill(win, 'person', String(byName.id), limit, ctx)
      }
      const [u] = await rows(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.title, u.department, u.status, u.last_access, ro.name role FROM nivaro_users u LEFT JOIN nivaro_roles ro ON ro.id = u.role WHERE u.id = ?`,
        [key]
      )
      if (!u) throw new DrillError(404, 'That person is not here')
      const [s] = await rows(
        `SELECT COUNT(*) n, MIN(l.created_at) f, MAX(l.created_at) la, SUM(CASE WHEN l.status >= 500 THEN 1 ELSE 0 END) e5,
                SUM(CASE WHEN l.status >= 400 AND l.status < 500 AND l.status <> 401 THEN 1 ELSE 0 END) e4,
                SUM(CASE WHEN l.latency_ms >= 5000 THEN 1 ELSE 0 END) slow, AVG(CAST(l.latency_ms AS bigint)) av
           FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND l.[user] = ?`,
        [S, E, key]
      )
      const signins = await rows(
        `SELECT created_at, method FROM nivaro_login_events WHERE [user] = ? AND created_at >= ? AND created_at < ? ORDER BY created_at`,
        [key, S, E]
      )
      const [moves] = await rows(
        `SELECT COUNT(*) n FROM nivaro_workflow_history WHERE [user] = ? AND [timestamp] >= ? AND [timestamp] < ?`,
        [key, S, E]
      )
      const r = await requestRows(
        win,
        `l.[user] = ? AND (l.status >= 400 OR l.latency_ms >= 3000) AND l.status <> 401`,
        [key],
        limit
      )
      return out(
        `${name(u) ?? u.email}'s day`,
        'Their errors, refusals and slow requests in the window; open any one for its full detail.',
        REQ_COLS,
        r.rows,
        r.total,
        {
          fields: [
            { label: 'Email', value: str(u.email) },
            { label: 'Role', value: str(u.role) },
            { label: 'Title', value: str(u.title) },
            { label: 'Department', value: str(u.department) },
            { label: 'Account', value: str(u.status) },
            { label: 'Requests', value: num(s?.n) },
            { label: 'First seen', value: t(s?.f) },
            { label: 'Last seen', value: t(s?.la) },
            { label: 'Average response', value: `${num(s?.av)} ms` },
            { label: 'Server errors', value: num(s?.e5) },
            { label: 'Refused (4xx)', value: num(s?.e4) },
            { label: 'Over 5 s', value: num(s?.slow) },
            { label: 'Workflow moves', value: num(moves?.n) },
            {
              label: 'Signed in today',
              value: signins.length
                ? signins.map((x) => `${t(x.created_at)} (${x.method})`).join(', ')
                : 'No — still signed in from an earlier day'
            },
            { label: 'Profile', value: 'Open', link: `/users/${key}` }
          ],
          blocks: []
        }
      )
    }
    case 'login': {
      if (!key) throw new DrillError(400, 'Name the sign-in')
      const [e] = await rows(
        `SELECT e.*, u.first_name, u.last_name, u.email FROM nivaro_login_events e LEFT JOIN nivaro_users u ON u.id = e.[user] WHERE e.id = ?`,
        [Number(key)]
      )
      if (!e) throw new DrillError(404, 'That sign-in is not here')
      return out('Sign-in', 'One sign-in event.', [], [], 0, {
        fields: [
          {
            label: 'Person',
            value: name(e) ?? str(e.email),
            link: e.user ? `/users/${e.user}` : null
          },
          { label: 'When', value: t(e.created_at) },
          { label: 'How', value: str(e.method) },
          { label: 'Address', value: str(e.ip) },
          { label: 'New place', value: e.new_ip ? 'Yes' : 'No' }
        ],
        blocks: [{ title: 'Browser', text: String(e.user_agent ?? ''), kind: 'text' }]
      })
    }

    // ── Traffic + speed ───────────────────────────────────────────────────────
    case 'requests':
    case 'requests_by_hour': {
      let where = '1 = 1'
      const b: unknown[] = []
      if (metric === 'requests_by_hour' && key != null) {
        const h = Number(key)
        const from = minuteOf(win, `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`)
        if (from) {
          where = 'l.created_at >= ? AND l.created_at < ?'
          b.push(from, new Date(from.getTime() + 3_600_000))
        }
      }
      if (metric === 'requests' && key) {
        const r = await routeRequests(win, key, limit, 'slow')
        return out(key, 'Requests on this route, slowest first.', REQ_COLS, r.rows, r.total)
      }
      const vol = await rows(
        `SELECT l.method, l.path, COUNT(*) n, COUNT(DISTINCT l.[user]) u, SUM(CAST(l.latency_ms AS bigint)) tot, MAX(l.latency_ms) mx,
                SUM(CASE WHEN l.status >= 500 THEN 1 ELSE 0 END) e5
           FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND ${where} GROUP BY l.method, l.path`,
        [...range, ...b]
      )
      const by = new Map<string, { n: number; tot: number; mx: number; u: number; e5: number }>()
      for (const r of vol) {
        const k = `${r.method} ${routeOf(String(r.path))}`
        const e = by.get(k) ?? { n: 0, tot: 0, mx: 0, u: 0, e5: 0 }
        e.n += num(r.n)
        e.tot += num(r.tot)
        e.mx = Math.max(e.mx, num(r.mx))
        e.u = Math.max(e.u, num(r.u))
        e.e5 += num(r.e5)
        by.set(k, e)
      }
      const list = [...by.entries()].sort((a, b2) => b2[1].n - a[1].n)
      return out(
        metric === 'requests_by_hour'
          ? `Requests ${key}:00–${Number(key) + 1}:00`
          : 'Requests by route',
        'Every route called, busiest first. Open one for its requests.',
        [
          C.route,
          C.n,
          { key: 'avg_ms', label: 'Average', type: 'ms' },
          { key: 'max_ms', label: 'Slowest', type: 'ms' },
          { key: 'e5', label: 'Server errors', type: 'number' }
        ],
        list.slice(0, limit).map(([route, e]) => ({
          route,
          n: e.n,
          avg_ms: Math.round(e.tot / e.n),
          max_ms: e.mx,
          e5: e.e5,
          _drill_metric: 'slow_route',
          _drill_key: route
        })),
        list.length
      )
    }
    case 'over5s': {
      const ms = key === '1s' ? 1000 : key === '30s' ? 30000 : 5000
      const r = await requestRows(win, `l.latency_ms >= ${ms}`, [], limit, 'slow')
      return out(
        `Requests over ${ms / 1000} seconds`,
        'Slowest first. Open one for the person, the error and what else was slow then.',
        REQ_COLS,
        r.rows,
        r.total
      )
    }
    case 'latency': {
      const vol = await rows(
        `SELECT l.method, l.path, COUNT(*) n, SUM(CAST(l.latency_ms AS bigint)) tot, MAX(l.latency_ms) mx, SUM(CASE WHEN l.latency_ms >= 1000 THEN 1 ELSE 0 END) o1
           FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? GROUP BY l.method, l.path`,
        range
      )
      const by = new Map<string, { n: number; tot: number; mx: number; o1: number }>()
      for (const r of vol) {
        const k = `${r.method} ${routeOf(String(r.path))}`
        const e = by.get(k) ?? { n: 0, tot: 0, mx: 0, o1: 0 }
        e.n += num(r.n)
        e.tot += num(r.tot)
        e.mx = Math.max(e.mx, num(r.mx))
        e.o1 += num(r.o1)
        by.set(k, e)
      }
      const list = [...by.entries()]
        .filter(([, e]) => e.n >= 5)
        .sort((a, b2) => b2[1].tot / b2[1].n - a[1].tot / a[1].n)
      return out(
        'Response time by route',
        'Routes called 5 times or more, slowest on average first. Open one for its slowest requests.',
        [
          C.route,
          C.n,
          { key: 'avg_ms', label: 'Average', type: 'ms' },
          { key: 'max_ms', label: 'Slowest', type: 'ms' },
          { key: 'over1s', label: 'Over 1 s', type: 'number' }
        ],
        list.slice(0, limit).map(([route, e]) => ({
          route,
          n: e.n,
          avg_ms: Math.round(e.tot / e.n),
          max_ms: e.mx,
          over1s: e.o1,
          _drill_metric: 'slow_route',
          _drill_key: route
        })),
        list.length
      )
    }
    case 'slow_route': {
      if (!key) throw new DrillError(400, 'Name the route')
      const r = await routeRequests(win, key, limit, 'slow', ' AND l.latency_ms >= 1000')
      return out(
        key,
        'Requests on this route that took a second or more, slowest first.',
        REQ_COLS,
        r.rows,
        r.total
      )
    }
    case 'burst': {
      if (!key) throw new DrillError(400, 'Name the burst')
      const [route, at] = key.split('@')
      const from = at ? minuteOf(win, at) : null
      const f = routeFilter(route)
      const r = await requestRows(
        {
          ...win,
          start: from ? new Date(from.getTime() - 60_000) : S,
          end: from ? new Date(from.getTime() + 3 * 60_000) : E
        },
        `${f.where} AND l.latency_ms >= 3000`,
        f.bindings,
        limit,
        'slow'
      )
      return out(
        `${route} burst at ${at ?? ''}`,
        'Many slow requests on one route within a minute — usually one shared cause (a lock, a cold cache, a heavy job, a burst of writes elsewhere).',
        REQ_COLS,
        r.rows,
        r.total,
        from ? { fields: [], blocks: [await aroundBlock(from, win.tz)] } : undefined
      )
    }
    case 'page_views': {
      if (key) {
        const r = await rows(
          `SELECT TOP ${limit} v.viewed_at, v.page_url, v.duration_seconds, v.device_type, u.id, u.first_name, u.last_name FROM nivaro_page_views v LEFT JOIN nivaro_users u ON u.id = v.user_id
            WHERE v.viewed_at >= ? AND v.viewed_at < ? AND v.page_url LIKE ? ORDER BY v.viewed_at`,
          [S, E, `%${key.replace(/:uuid|:id|:key/g, '%')}%`]
        )
        return out(
          `Views of ${key}`,
          'Each time someone opened this screen.',
          [
            C.time,
            C.person,
            { key: 'seconds', label: 'Seconds on page', type: 'number' },
            { key: 'device', label: 'Device' }
          ],
          r.map((x) => ({
            time: t(x.viewed_at),
            person: name(x),
            seconds: x.duration_seconds == null ? null : num(x.duration_seconds),
            device: str(x.device_type),
            ...(x.id ? { _drill_metric: 'person', _drill_key: String(x.id) } : {})
          }))
        )
      }
      const r = await rows(
        `SELECT page_url p, user_id u FROM nivaro_page_views WHERE viewed_at >= ? AND viewed_at < ?`,
        range
      )
      const by = new Map<string, { n: number; u: Set<string> }>()
      for (const x of r) {
        let p = String(x.p ?? '')
        try {
          p = new URL(p, 'http://x').pathname
        } catch {
          /* as given */
        }
        p = routeOf(p).replace(/\/+$/, '') || '/'
        const e = by.get(p) ?? { n: 0, u: new Set<string>() }
        e.n++
        if (x.u) e.u.add(String(x.u))
        by.set(p, e)
      }
      const list = [...by.entries()].sort((a, b2) => b2[1].n - a[1].n)
      return out(
        'Screens opened',
        'Page views by screen.',
        [{ key: 'screen', label: 'Screen' }, C.n, C.people],
        list.slice(0, limit).map(([screen, e]) => ({
          screen,
          n: e.n,
          people: e.u.size,
          _drill_metric: 'page_views',
          _drill_key: screen
        })),
        list.length
      )
    }
    case 'request': {
      if (!key) throw new DrillError(400, 'Name the request')
      const [r] = await rows(
        `SELECT l.*, u.first_name, u.last_name, k.name key_name FROM ${logs()} LEFT JOIN nivaro_users u ON u.id = l.[user] LEFT JOIN nivaro_api_keys k ON k.id = l.api_key_id WHERE l.id = ?`,
        [Number(key)]
      )
      if (!r) throw new DrillError(404, 'That request is no longer in the log (it keeps 14 days)')
      const when = new Date(String(r.created_at))
      const around = r.user
        ? await requestRows(
            {
              ...win,
              start: new Date(when.getTime() - 120_000),
              end: new Date(when.getTime() + 120_000)
            },
            `l.[user] = ? AND l.id <> ?`,
            [r.user, r.id],
            40
          )
        : { rows: [], total: 0 }
      const sameMinute = await rows(
        `SELECT COUNT(*) n, SUM(CASE WHEN l.latency_ms >= 3000 THEN 1 ELSE 0 END) slow, SUM(CASE WHEN l.status >= 500 THEN 1 ELSE 0 END) e5
           FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ?`,
        [new Date(when.getTime() - 60_000), new Date(when.getTime() + 60_000)]
      )
      const issue =
        r.status && num(r.status) >= 500
          ? (
              await rows(
                `SELECT TOP 1 id, title FROM nivaro_issues WHERE source = 'server' AND created_at <= ? AND last_seen_at >= ? AND title LIKE ? ORDER BY last_seen_at DESC`,
                [
                  new Date(when.getTime() + 5_000),
                  new Date(when.getTime() - 5_000),
                  `%${String(r.method)} %`
                ]
              )
            )[0]
          : undefined
      const blocks: NonNullable<OpsDrill['detail']>['blocks'] = []
      if (r.error)
        blocks.push({
          title: 'Response the person got',
          text: scrubText(String(r.error)),
          kind: 'json'
        })
      if (r.request_body)
        blocks.push({
          title: 'Request body',
          text: scrubText(String(r.request_body)).slice(0, 8000),
          kind: 'json'
        })
      if (r.query) blocks.push({ title: 'Query string', text: String(r.query), kind: 'code' })
      blocks.push(await aroundBlock(when, win.tz, 1))
      if (issue) {
        const [d] = await rows(`SELECT details FROM nivaro_issues WHERE id = ?`, [issue.id])
        if (d?.details)
          blocks.push({
            title: `Server error (issue #${issue.id})`,
            text: scrubText(String(d.details)).slice(0, 12000),
            kind: 'code'
          })
      }
      return out(
        `${r.method} ${r.path}`,
        'One request, as the server logged it. Below: what the same person did two minutes either side.',
        REQ_COLS,
        around.rows,
        around.total,
        {
          fields: [
            { label: 'When', value: clock(when, win.tz) },
            { label: 'Person', value: name(r) ?? str(r.key_name) ?? str(r.auth) },
            { label: 'Status', value: num(r.status) },
            { label: 'Time taken', value: `${num(r.latency_ms)} ms` },
            { label: 'Signed in by', value: str(r.auth) },
            { label: 'Server', value: str(r.instance) },
            { label: 'Request id', value: str(r.request_id) },
            { label: 'Address', value: str(r.ip) },
            { label: 'Browser', value: str(r.user_agent) },
            { label: 'GraphQL operation', value: str(r.graphql_operation) },
            {
              label: 'Same minute, whole server',
              value: `${num(sameMinute[0]?.n)} requests, ${num(sameMinute[0]?.slow)} over 3 s, ${num(sameMinute[0]?.e5)} server errors`
            },
            ...(issue
              ? [{ label: 'Issue', value: `#${issue.id}`, link: `/issues?id=${issue.id}` }]
              : []),
            ...(r.user ? [{ label: 'Profile', value: 'Open', link: `/users/${r.user}` }] : [])
          ],
          blocks
        }
      )
    }

    // ── Errors ────────────────────────────────────────────────────────────────
    case 'server_errors': {
      const base = `l.status >= 500 AND l.path <> '/api/ready'`
      if (key === '503') {
        const r = await requestRows(win, `l.path = '/api/ready' AND l.status = 503`, [], limit)
        return out(
          'Deploy-drain answers',
          'A server shutting down for a deploy answers "not ready" so traffic moves to the new one. Expected; not an error people saw.',
          REQ_COLS,
          r.rows,
          r.total
        )
      }
      if (key) {
        const r = await routeRequests(win, key, limit, 'time', ` AND ${base}`)
        return out(
          `Server errors on ${key}`,
          'Each failed request; open one for the stack and what the person saw.',
          REQ_COLS,
          r.rows,
          r.total
        )
      }
      const r = await requestRows(win, base, [], limit)
      return out(
        'Server errors',
        'Real 500s. Deploy-drain answers (503 on /api/ready) are left out.',
        REQ_COLS,
        r.rows,
        r.total
      )
    }
    case 'client_errors': {
      if (key && /^\d{3}$/.test(key)) {
        const r = await requestRows(win, `l.status = ${Number(key)}`, [], limit)
        return out(
          key === '401' ? 'Signed-out answers (401)' : `${key} answers`,
          key === '401'
            ? 'Requests from a tab whose sign-in had ended. Normal: the app asks the person to sign in again.'
            : 'Every request answered with this status.',
          REQ_COLS,
          r.rows,
          r.total
        )
      }
      if (key) {
        const [status, ...rest] = key.split(' ')
        const route = rest.join(' ')
        const r = await routeRequests(
          win,
          route,
          limit,
          'time',
          ` AND l.status = ${Number(status) || 0}`
        )
        return out(
          `${status} on ${route}`,
          'Each refused request with the message the person got.',
          REQ_COLS,
          r.rows,
          r.total
        )
      }
      const r = await requestRows(
        win,
        'l.status >= 400 AND l.status < 500 AND l.status <> 401',
        [],
        limit
      )
      return out('Refused requests', 'Every 4xx except signed-out 401s.', REQ_COLS, r.rows, r.total)
    }
    case 'failed_sign_ins': {
      const r = await requestRows(
        win,
        `(l.path LIKE '/api/auth/callback%' OR l.path LIKE '/api/auth/login%') AND l.status >= 400`,
        [],
        limit
      )
      return out(
        'Failed sign-ins',
        'Sign-in attempts the server refused.',
        REQ_COLS,
        r.rows,
        r.total
      )
    }
    case 'deploys': {
      const d = await rows(
        `SELECT id, [timestamp] t, comment FROM nivaro_activity WHERE [timestamp] >= ? AND [timestamp] < ? AND action = 'infra-drift-baseline' ORDER BY [timestamp]`,
        range
      )
      const drains = await rows(
        `SELECT MIN(l.created_at) f, MAX(l.created_at) la, COUNT(*) n FROM ${logs()} WHERE l.created_at >= ? AND l.created_at < ? AND l.path = '/api/ready' AND l.status = 503
          GROUP BY DATEPART(dayofyear, l.created_at), DATEPART(hour, l.created_at), DATEPART(minute, l.created_at) / 10 ORDER BY MIN(l.created_at)`,
        range
      )
      const list: DrillRow[] = [
        ...d.map((x) => ({
          time: t(x.t),
          what: 'Deploy',
          detail: String(x.comment ?? '').slice(0, 160),
          _link: `/activity/${x.id}`
        })),
        ...drains.map((x) => ({
          time: t(x.f),
          what: 'Drain',
          detail: `${num(x.n)} not-ready answers until ${t(x.la)} (old version shutting down)`
        }))
      ].sort((a, b2) => String(a.time).localeCompare(String(b2.time)))
      return out(
        'Deploys and drains',
        'Each deploy, and the minutes a server answered "not ready" while it shut down.',
        [C.time, { key: 'what', label: 'What' }, { key: 'detail', label: 'Detail' }],
        list
      )
    }
    case 'deadlocks':
    case 'issues':
    case 'browser_errors': {
      const where =
        metric === 'deadlocks'
          ? `title LIKE '%deadlock-sweep%'`
          : metric === 'browser_errors'
            ? `source = 'client'`
            : `title NOT LIKE '%deadlock-sweep%'`
      const r = await rows(
        `SELECT TOP ${limit} id, source, severity, status, title, occurrence_count c, created_at, last_seen_at FROM nivaro_issues
          WHERE ((created_at >= ? AND created_at < ?) OR (last_seen_at >= ? AND last_seen_at < ?)) AND ${where} ORDER BY created_at`,
        [S, E, S, E]
      )
      return out(
        metric === 'deadlocks'
          ? 'Database deadlocks'
          : metric === 'browser_errors'
            ? 'Browser errors'
            : 'Issues',
        metric === 'deadlocks'
          ? 'Two sessions blocked each other and the database cancelled one. Open one for both statements.'
          : 'Open one for the full error and stack.',
        [
          { key: 'id', label: '#', type: 'number' },
          { key: 'title', label: 'Title' },
          { key: 'severity', label: 'Severity' },
          { key: 'count', label: 'Times', type: 'number' },
          { key: 'first', label: 'First', type: 'time' },
          { key: 'last', label: 'Last', type: 'time' }
        ],
        r.map((x) => ({
          id: num(x.id),
          title: String(x.title ?? '').slice(0, 200),
          severity: str(x.severity),
          count: num(x.c),
          first: t(x.created_at),
          last: t(x.last_seen_at),
          _drill_metric: 'issue',
          _drill_key: String(x.id),
          _link: `/issues?id=${x.id}`
        }))
      )
    }
    case 'issue': {
      if (!key) throw new DrillError(400, 'Name the issue')
      const [x] = await rows(`SELECT * FROM nivaro_issues WHERE id = ?`, [Number(key)])
      if (!x) throw new DrillError(404, 'That issue is not here')
      const details = scrubText(String(x.details ?? ''))
      const blocks: NonNullable<OpsDrill['detail']>['blocks'] = []
      if (/deadlock-sweep/.test(String(x.title))) {
        const victims = new Set(
          [...details.matchAll(/<victimProcess id="([^"]+)"/g)].map((m) => m[1])
        )
        for (const m of details.matchAll(
          /<process id="([^"]+)"[\s\S]*?<inputbuf>([\s\S]*?)<\/inputbuf>/g
        ))
          blocks.push({
            title: victims.has(m[1]) ? 'Cancelled (victim) statement' : 'Other statement',
            text: m[2].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim(),
            kind: 'code'
          })
      }
      const hint = await columnHint(`${x.title} ${details}`)
      if (hint) blocks.unshift({ title: 'What the data model says', text: hint, kind: 'text' })
      blocks.push({ title: 'Full detail', text: details.slice(0, 20000), kind: 'code' })
      blocks.push(await aroundBlock(new Date(String(x.created_at)), win.tz))
      const reqs = await requestRows(
        win,
        `l.status >= 500 AND l.path <> '/api/ready' AND l.created_at >= ? AND l.created_at <= ?`,
        [
          new Date(new Date(String(x.created_at)).getTime() - 60_000),
          new Date(new Date(String(x.last_seen_at ?? x.created_at)).getTime() + 60_000)
        ],
        40
      )
      return out(
        `#${x.id} ${String(x.title).slice(0, 120)}`,
        'The issue as recorded, and the server errors around it.',
        REQ_COLS,
        reqs.rows,
        reqs.total,
        {
          fields: [
            { label: 'Source', value: str(x.source) },
            { label: 'Severity', value: str(x.severity) },
            { label: 'Status', value: str(x.status) },
            { label: 'Times seen', value: num(x.occurrence_count) },
            { label: 'First', value: t(x.created_at) },
            { label: 'Last', value: t(x.last_seen_at) },
            { label: 'Issue', value: 'Open', link: `/issues?id=${x.id}` }
          ],
          blocks
        }
      )
    }

    // ── Jobs ──────────────────────────────────────────────────────────────────
    case 'job_failures':
    case 'job': {
      const where =
        metric === 'job' ? `job_id = ?` : `status NOT IN ('completed', 'running', 'skipped')`
      const b = metric === 'job' ? [key] : []
      if (metric === 'job' && !key) throw new DrillError(400, 'Name the job')
      const r = await rows(
        `SELECT TOP ${limit} id, job_id, status, started_at, duration_ms, LEFT(error, 200) err, instance FROM nivaro_job_runs WHERE started_at >= ? AND started_at < ? AND ${where} ORDER BY started_at`,
        [S, E, ...b]
      )
      return out(
        metric === 'job' ? `Runs of ${key}` : 'Failed jobs',
        'Open a run for its error and progress.',
        [C.time, { key: 'job', label: 'Job' }, C.status, C.ms, C.message],
        r.map((x) => ({
          time: t(x.started_at),
          job: String(x.job_id),
          status: String(x.status),
          ms: num(x.duration_ms),
          message: str(x.err),
          _drill_metric: 'job_run',
          _drill_key: String(x.id),
          _link: `/jobs?run=${x.id}`
        }))
      )
    }
    case 'job_run': {
      if (!key) throw new DrillError(400, 'Name the run')
      const [x] = await rows(`SELECT * FROM nivaro_job_runs WHERE id = ?`, [Number(key)])
      if (!x) throw new DrillError(404, 'That run is not here (job history keeps 30 days)')
      return out(`${x.job_id} run`, 'One run of a scheduled job.', [], [], 0, {
        fields: [
          { label: 'Job', value: str(x.label) ?? str(x.job_id) },
          { label: 'Status', value: str(x.status) },
          { label: 'Started', value: t(x.started_at) },
          { label: 'Took', value: `${num(x.duration_ms)} ms` },
          { label: 'Server', value: str(x.instance) },
          { label: 'Triggered by', value: str(x.triggered_by) ?? str(x.trigger_kind) },
          { label: 'Jobs page', value: 'Open', link: `/jobs?run=${x.id}` }
        ],
        blocks: [
          ...(x.error
            ? [{ title: 'Error', text: scrubText(String(x.error)), kind: 'code' as const }]
            : []),
          ...(x.outcome
            ? [{ title: 'Outcome', text: scrubText(String(x.outcome)).slice(0, 8000), kind: 'json' as const }]
            : []),
          ...(x.progress
            ? [
                {
                  title: 'Progress',
                  text: scrubText(String(x.progress)).slice(0, 8000),
                  kind: 'json' as const
                }
              ]
            : [])
        ]
      })
    }

    // ── Integrations ──────────────────────────────────────────────────────────
    case 'integration_failures': {
      const r = await rows(
        `SELECT TOP ${limit} s.id, s.created_at, s.collection, s.item, s.status, LEFT(s.last_error, 240) err, a.name api FROM nivaro_erp_submissions s LEFT JOIN nivaro_external_apis a ON a.id = s.external_api
          WHERE s.created_at >= ? AND s.created_at < ? AND s.status NOT IN ('accepted', 'pending', 'skipped') ${key ? 'AND a.name = ?' : ''} ORDER BY s.created_at`,
        key ? [S, E, key] : range
      )
      return out(
        key ? `${key} sends that failed` : 'Partner sends that failed',
        "Open one for the payload and the partner's answer; the record opens in the drawer.",
        [
          C.time,
          { key: 'api', label: 'Partner' },
          { key: 'record', label: 'Record' },
          C.status,
          C.message
        ],
        r.map((x) => ({
          time: t(x.created_at),
          api: str(x.api),
          record: `${x.collection} ${x.item}`,
          status: String(x.status),
          message: errorText(x.err),
          _drill_metric: 'submission',
          _drill_key: String(x.id),
          _record_collection: str(x.collection),
          _record_id: str(x.item)
        }))
      )
    }
    case 'submission': {
      if (!key) throw new DrillError(400, 'Name the send')
      const [x] = await rows(
        `SELECT s.*, a.name api FROM nivaro_erp_submissions s LEFT JOIN nivaro_external_apis a ON a.id = s.external_api WHERE s.id = ?`,
        [Number(key)]
      )
      if (!x) throw new DrillError(404, 'That send is not here')
      const calls = await rows(
        `SELECT TOP 20 id, created_at, method, url, response_status, duration_ms, LEFT(error, 160) err FROM nivaro_external_api_logs WHERE api_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at`,
        [
          x.external_api,
          new Date(new Date(String(x.created_at)).getTime() - 60_000),
          new Date(new Date(String(x.updated_at ?? x.created_at)).getTime() + 60_000)
        ]
      )
      return out(
        `${x.api} send for ${x.collection} ${x.item}`,
        'One partner send and the calls made for it.',
        [C.time, { key: 'call', label: 'Call' }, C.status, C.ms, C.message],
        calls.map((c) => ({
          time: t(c.created_at),
          call: `${c.method} ${String(c.url ?? '').replace(/\?.*$/, '')}`,
          status: num(c.response_status),
          ms: num(c.duration_ms),
          message: str(c.err),
          _drill_metric: 'outbound_call',
          _drill_key: String(c.id)
        })),
        calls.length,
        {
          fields: [
            { label: 'Partner', value: str(x.api) },
            { label: 'Record', value: `${x.collection} ${x.item}` },
            { label: 'Status', value: str(x.status) },
            { label: 'Attempts', value: num(x.attempts) },
            { label: 'Partner reference', value: str(x.external_ref) },
            { label: 'Error kind', value: str(x.error_class) },
            { label: 'Sent', value: t(x.created_at) },
            { label: 'Updated', value: t(x.updated_at) },
            {
              label: 'Integrations console',
              value: 'Open',
              link: `/integration-health?tab=erp&collection=${x.collection}&item=${x.item}`
            }
          ],
          blocks: [
            ...(x.last_error
              ? [{ title: 'Error', text: scrubText(String(x.last_error)), kind: 'text' as const }]
              : []),
            ...(x.payload
              ? [
                  {
                    title: 'What was sent',
                    text: scrubText(String(x.payload)).slice(0, 12000),
                    kind: 'json' as const
                  }
                ]
              : []),
            ...(x.response
              ? [
                  {
                    title: 'What the partner answered',
                    text: scrubText(String(x.response)).slice(0, 12000),
                    kind: 'json' as const
                  }
                ]
              : [])
          ]
        }
      )
    }
    case 'integration_calls': {
      const r = await rows(
        `SELECT TOP ${limit} x.id, x.created_at, x.method, x.url, x.response_status, x.duration_ms, LEFT(x.error, 200) err, a.name api FROM nivaro_external_api_logs x LEFT JOIN nivaro_external_apis a ON a.id = x.api_id
          WHERE x.created_at >= ? AND x.created_at < ? ${key ? 'AND a.name = ?' : ''} ORDER BY CASE WHEN x.response_status >= 400 OR x.error IS NOT NULL THEN 0 ELSE 1 END, x.duration_ms DESC`,
        key ? [S, E, key] : range
      )
      return out(
        key ? `Calls to ${key}` : 'Partner calls',
        'Failed calls first, then slowest. Open one for what was sent and answered.',
        [
          C.time,
          { key: 'api', label: 'Partner' },
          { key: 'call', label: 'Call' },
          C.status,
          C.ms,
          C.message
        ],
        r.map((x) => ({
          time: t(x.created_at),
          api: str(x.api),
          call: `${x.method} ${String(x.url ?? '').replace(/\?.*$/, '')}`,
          status: num(x.response_status),
          ms: num(x.duration_ms),
          message: str(x.err),
          _drill_metric: 'outbound_call',
          _drill_key: String(x.id)
        }))
      )
    }
    case 'outbound_call': {
      if (!key) throw new DrillError(400, 'Name the call')
      const [x] = await rows(
        `SELECT x.*, a.name api FROM nivaro_external_api_logs x LEFT JOIN nivaro_external_apis a ON a.id = x.api_id WHERE x.id = ?`,
        [Number(key)]
      )
      if (!x) throw new DrillError(404, 'That call is not here')
      return out(
        `${x.api}: ${x.method} ${String(x.url ?? '').replace(/\?.*$/, '')}`,
        'One call to a partner. Credentials are never shown.',
        [],
        [],
        0,
        {
          fields: [
            { label: 'Partner', value: str(x.api) },
            { label: 'When', value: t(x.created_at) },
            { label: 'Status', value: num(x.response_status) },
            { label: 'Took', value: `${num(x.duration_ms)} ms` },
            { label: 'Triggered by', value: str(x.triggered_by) }
          ],
          blocks: [
            ...(x.error
              ? [{ title: 'Error', text: scrubText(String(x.error)), kind: 'text' as const }]
              : []),
            ...(x.request_body
              ? [
                  {
                    title: 'Sent',
                    text: scrubText(String(x.request_body)).slice(0, 12000),
                    kind: 'json' as const
                  }
                ]
              : []),
            ...(x.response_body
              ? [
                  {
                    title: 'Answered',
                    text: scrubText(String(x.response_body)).slice(0, 12000),
                    kind: 'json' as const
                  }
                ]
              : [])
          ]
        }
      )
    }
    case 'open_alarms': {
      const r = await rows(
        `SELECT TOP ${limit} o.id, o.api, o.kind, o.collection, o.item, o.outcome, LEFT(o.reason, 200) reason, o.due_at FROM nivaro_integration_obligations o
          WHERE o.outcome IN ('missing', 'failed', 'overdue') AND o.id = (SELECT MAX(id) FROM nivaro_integration_obligations x WHERE x.collection = o.collection AND x.item = o.item AND x.kind = o.kind)
          ${key ? 'AND o.api = ?' : ''} ORDER BY o.due_at`,
        key ? [key] : []
      )
      return out(
        'Open integration alarms',
        'Things a partner should have been told and was not (yet). The record opens in the drawer.',
        [
          { key: 'api', label: 'Partner' },
          { key: 'kind', label: 'What' },
          { key: 'record', label: 'Record' },
          C.status,
          { key: 'reason', label: 'Why' },
          { key: 'due', label: 'Due since' }
        ],
        r.map((x) => ({
          api: str(x.api),
          kind: str(x.kind),
          record: `${x.collection} ${x.item}`,
          status: str(x.outcome),
          reason: str(x.reason),
          due: x.due_at
            ? new Date(String(x.due_at)).toISOString().slice(0, 16).replace('T', ' ')
            : null,
          _record_collection: str(x.collection),
          _record_id: str(x.item),
          _link: `/integration-health?collection=${x.collection}&item=${x.item}`
        }))
      )
    }
    case 'imports': {
      const r = await rows(
        `SELECT TOP ${limit} q.id, q.status, q.started_at, q.finished_at, q.row_count, COALESCE(d.label, d.[key]) def FROM nivaro_import_queue q LEFT JOIN nivaro_import_definitions d ON d.id = q.definition
          WHERE q.created_at >= ? AND q.created_at < ? ORDER BY q.created_at`,
        range
      )
      return out(
        'Imports',
        'Each staged import run.',
        [
          C.time,
          { key: 'definition', label: 'Import' },
          C.status,
          { key: 'rows', label: 'Rows', type: 'number' },
          { key: 'finished', label: 'Finished', type: 'time' }
        ],
        r.map((x) => ({
          time: t(x.started_at),
          definition: str(x.def),
          status: str(x.status),
          rows: num(x.row_count),
          finished: t(x.finished_at),
          _link: `/imports?run=${x.id}`
        }))
      )
    }

    // ── Mail + notifications ──────────────────────────────────────────────────
    case 'mail': {
      const r = await rows(
        `SELECT TOP ${limit} id, created_at, [to], subject, template, status, LEFT(error, 200) err, collection, item FROM nivaro_mail_log
          WHERE created_at >= ? AND created_at < ? ${key ? 'AND status = ?' : ''} ORDER BY created_at`,
        key ? [S, E, key] : range
      )
      return out(
        key ? `Mail: ${key}` : 'Mail',
        'Open one for the message as sent.',
        [
          C.time,
          { key: 'to', label: 'To' },
          { key: 'subject', label: 'Subject' },
          C.status,
          C.message
        ],
        r.map((x) => ({
          time: t(x.created_at),
          to: str(x.to),
          subject: str(x.subject),
          status: str(x.status),
          message: str(x.err),
          _drill_metric: 'mail_message',
          _drill_key: String(x.id),
          ...(x.collection && x.item
            ? { _record_collection: String(x.collection), _record_id: String(x.item) }
            : {})
        }))
      )
    }
    case 'mail_message': {
      if (!key) throw new DrillError(400, 'Name the message')
      const [x] = await rows(`SELECT * FROM nivaro_mail_log WHERE id = ?`, [Number(key)])
      if (!x) throw new DrillError(404, 'That message is not here')
      const text = String(x.body ?? '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return out(
        String(x.subject ?? 'Message'),
        'One email as the server sent it (text only).',
        [],
        [],
        0,
        {
          fields: [
            { label: 'To', value: str(x.to) },
            { label: 'When', value: t(x.created_at) },
            { label: 'Template', value: str(x.template) },
            { label: 'Status', value: str(x.status) },
            { label: 'Error', value: str(x.error) }
          ],
          blocks: text ? [{ title: 'Message', text: scrubText(text).slice(0, 8000), kind: 'text' }] : []
        }
      )
    }
    case 'notifications': {
      const r = await rows(
        `SELECT TOP ${limit} n.[timestamp] t, n.subject, n.category, n.read_at, n.collection, n.item, u.id, u.first_name, u.last_name FROM nivaro_notifications n LEFT JOIN nivaro_users u ON u.id = n.recipient
          WHERE n.[timestamp] >= ? AND n.[timestamp] < ? ${key ? 'AND n.category = ?' : ''} ORDER BY n.[timestamp]`,
        key ? [S, E, key] : range
      )
      return out(
        key ? `Notifications: ${key}` : 'Notifications',
        'Who was told what, and whether they read it.',
        [C.time, C.person, { key: 'subject', label: 'Subject' }, { key: 'read', label: 'Read' }],
        r.map((x) => ({
          time: t(x.t),
          person: name(x),
          subject: str(x.subject),
          read: x.read_at ? t(x.read_at) : 'No',
          ...(x.collection && x.item && !String(x.collection).startsWith('nivaro_')
            ? { _record_collection: String(x.collection), _record_id: String(x.item) }
            : {})
        }))
      )
    }

    // ── Work ──────────────────────────────────────────────────────────────────
    case 'moves': {
      const r = await rows(
        `SELECT TOP ${limit} h.[timestamp] t, i.collection, i.item, fs.label fl, ts.label tl, u.id, u.first_name, u.last_name FROM nivaro_workflow_history h
           JOIN nivaro_workflow_instances i ON i.id = h.instance LEFT JOIN nivaro_workflow_states fs ON fs.id = h.from_state JOIN nivaro_workflow_states ts ON ts.id = h.to_state
           LEFT JOIN nivaro_users u ON u.id = h.[user] WHERE h.[timestamp] >= ? AND h.[timestamp] < ? ${key ? 'AND ts.label = ?' : ''} ORDER BY h.[timestamp]`,
        key ? [S, E, key] : range
      )
      return out(
        key ? `Moves to ${key}` : 'Workflow moves',
        'Each move; the record opens in the drawer.',
        [
          C.time,
          { key: 'record', label: 'Record' },
          { key: 'from', label: 'From' },
          { key: 'to', label: 'To' },
          C.person
        ],
        r.map((x) => ({
          time: t(x.t),
          record: `${x.collection} ${x.item}`,
          from: str(x.fl),
          to: str(x.tl),
          person: name(x) ?? 'Automatic',
          _record_collection: str(x.collection),
          _record_id: str(x.item)
        }))
      )
    }
    case 'creates': {
      const r = await rows(
        `SELECT TOP ${limit} a.[timestamp] t, a.collection, a.item, a.origin, u.first_name, u.last_name FROM nivaro_activity a LEFT JOIN nivaro_users u ON u.id = a.[user]
          WHERE a.[timestamp] >= ? AND a.[timestamp] < ? AND a.action = 'create' AND a.collection NOT LIKE 'nivaro[_]%' ${key ? 'AND a.collection = ?' : ''} ORDER BY a.[timestamp]`,
        key ? [S, E, key] : range
      )
      return out(
        key ? `New ${key}` : 'Records created',
        'Each record created; it opens in the drawer.',
        [C.time, { key: 'record', label: 'Record' }, C.person, { key: 'origin', label: 'How' }],
        r.map((x) => ({
          time: t(x.t),
          record: `${x.collection} ${x.item}`,
          person: name(x),
          origin: str(x.origin),
          _record_collection: str(x.collection),
          _record_id: str(x.item)
        }))
      )
    }
    case 'backlog':
    case 'sla_breaches': {
      if (!key) throw new DrillError(400, metric === 'backlog' ? 'Name the step' : 'Name the rule')
      let stateIds: Row[] = []
      let overHours: number | null = null
      if (metric === 'backlog')
        stateIds = await rows(`SELECT id FROM nivaro_workflow_states WHERE label = ?`, [key])
      else {
        const [rule] = await rows(
          `SELECT r.duration_hours, s.id FROM nivaro_sla_rules r JOIN nivaro_workflow_states s ON s.template = r.workflow_template AND s.[key] = r.state_key WHERE r.name = ?`,
          [key]
        )
        if (rule) {
          stateIds = [{ id: rule.id }]
          overHours = num(rule.duration_hours)
        }
      }
      if (!stateIds.length) return out(key, 'Nothing found for that step.', [], [])
      const ids = stateIds.map((s) => num(s.id))
      const r = await rows(
        `SELECT TOP ${limit} i.collection, i.item, i.started_at,
                (SELECT MAX(h.[timestamp]) FROM nivaro_workflow_history h WHERE h.instance = i.id AND h.to_state = i.current_state) entered
           FROM nivaro_workflow_instances i WHERE i.completed_at IS NULL AND i.current_state IN (${ids.map(() => '?').join(',')})
          ORDER BY (SELECT MAX(h.[timestamp]) FROM nivaro_workflow_history h WHERE h.instance = i.id AND h.to_state = i.current_state)`,
        ids
      )
      const list = r
        .map((x) => {
          const entered = x.entered
            ? new Date(String(x.entered))
            : x.started_at
              ? new Date(String(x.started_at))
              : null
          const hours = entered ? (E.getTime() - entered.getTime()) / 3_600_000 : null
          return { x, entered, hours }
        })
        .filter((v) => overHours == null || (v.hours != null && v.hours > overHours))
      return out(
        metric === 'backlog' ? `Waiting at ${key}` : `Over the SLA: ${key}`,
        'Longest waiting first; the record opens in the drawer.',
        [
          { key: 'record', label: 'Record' },
          { key: 'since', label: 'Waiting since' },
          { key: 'days', label: 'Days', type: 'number' }
        ],
        list.map((v) => ({
          record: `${v.x.collection} ${v.x.item}`,
          since: v.entered ? v.entered.toISOString().slice(0, 10) : null,
          days: v.hours == null ? null : Math.floor(v.hours / 24),
          _record_collection: str(v.x.collection),
          _record_id: str(v.x.item)
        }))
      )
    }
    case 'owners': {
      const r = await rows(
        `SELECT TOP ${limit} q.name queue, q.id qid, s.owned, s.sla_breached, s.at_risk, u.id, u.first_name, u.last_name FROM nivaro_queue_owner_snapshots s
           JOIN nivaro_users u ON u.id = s.[user] LEFT JOIN nivaro_queues q ON q.id = s.queue_id
          WHERE s.snapshot_date = (SELECT MAX(snapshot_date) FROM nivaro_queue_owner_snapshots WHERE snapshot_date <= ?) ${key ? `AND u.first_name + ' ' + u.last_name = ?` : ''}
          ORDER BY s.owned DESC`,
        key ? [win.day, key] : [win.day]
      )
      return out(
        key ? `Waiting on ${key}` : 'Who holds the waiting work',
        'Items waiting per person per queue (latest nightly snapshot). Open a queue for the items.',
        [
          C.person,
          { key: 'queue', label: 'Queue' },
          { key: 'waiting', label: 'Waiting', type: 'number' },
          { key: 'breached', label: 'Over SLA', type: 'number' },
          { key: 'at_risk', label: 'At risk', type: 'number' }
        ],
        r.map((x) => ({
          person: name(x),
          queue: str(x.queue),
          waiting: num(x.owned),
          breached: num(x.sla_breached),
          at_risk: num(x.at_risk),
          _drill_metric: 'person',
          _drill_key: String(x.id),
          ...(x.qid ? { _link: `/queues/${x.qid}` } : {})
        }))
      )
    }
    case 'searches':
    case 'search_zero': {
      const r = await rows(
        `SELECT TOP ${limit} s.created_at, s.query, s.result_count, s.duration_ms, s.surface, s.opened_collection, s.opened_item, u.id, u.first_name, u.last_name FROM nivaro_search_log s LEFT JOIN nivaro_users u ON u.id = s.[user]
          WHERE s.created_at >= ? AND s.created_at < ? ${metric === 'search_zero' ? 'AND s.result_count = 0' : ''} ${key ? 'AND s.query = ?' : ''} ORDER BY s.created_at`,
        key ? [S, E, key] : range
      )
      return out(
        metric === 'search_zero' ? 'Searches that found nothing' : 'Searches',
        'What people typed and what they opened.',
        [
          C.time,
          C.person,
          { key: 'query', label: 'Search' },
          { key: 'results', label: 'Results', type: 'number' },
          C.ms,
          { key: 'opened', label: 'Opened' }
        ],
        r.map((x) => ({
          time: t(x.created_at),
          person: name(x),
          query: str(x.query),
          results: num(x.result_count),
          ms: num(x.duration_ms),
          opened: x.opened_item ? `${x.opened_collection} ${x.opened_item}` : null,
          ...(x.opened_collection && x.opened_item
            ? { _record_collection: String(x.opened_collection), _record_id: String(x.opened_item) }
            : {})
        }))
      )
    }
    case 'config_changes': {
      const r = await rows(
        `SELECT TOP ${limit} a.id, a.[timestamp] t, a.action, a.collection, a.item, u.first_name, u.last_name FROM nivaro_activity a LEFT JOIN nivaro_users u ON u.id = a.[user]
          WHERE a.[timestamp] >= ? AND a.[timestamp] < ? AND a.collection LIKE 'nivaro[_]%' AND a.collection NOT IN ('nivaro_users', 'nivaro_activity', 'nivaro_presence')
            AND (a.action IN ('create', 'update', 'delete', 'restore', 'publish', 'revert') OR a.action LIKE '%-create' OR a.action LIKE '%-update' OR a.action LIKE '%-delete' OR a.action LIKE '%-publish')
          ORDER BY a.[timestamp]`,
        range
      )
      return out(
        'Config changes',
        'Who changed what in the setup. Open one for the before/after.',
        [C.time, C.person, { key: 'action', label: 'Change' }, { key: 'what', label: 'What' }],
        r.map((x) => ({
          time: t(x.t),
          person: name(x),
          action: str(x.action),
          what: `${x.collection}${x.item ? ` ${x.item}` : ''}`,
          _link: `/activity/${x.id}`
        }))
      )
    }
    case 'role_changes': {
      const r = await rows(
        `SELECT a.id, a.[timestamp] t, r.item, r.delta, w.first_name, w.last_name, p.first_name pf, p.last_name pl FROM nivaro_revisions r JOIN nivaro_activity a ON a.id = r.activity
           LEFT JOIN nivaro_users w ON w.id = a.[user] LEFT JOIN nivaro_users p ON CAST(p.id AS nvarchar(64)) = r.item
          WHERE r.collection = 'nivaro_users' AND a.[timestamp] >= ? AND a.[timestamp] < ? AND r.delta LIKE '%"role"%' ORDER BY a.[timestamp]`,
        range
      )
      return out(
        'Role changes',
        'Who changed whose role.',
        [C.time, { key: 'by', label: 'Changed by' }, C.person],
        r.map((x) => ({
          time: t(x.t),
          by: name(x),
          person: `${x.pf ?? ''} ${x.pl ?? ''}`.trim() || null,
          _drill_metric: 'person',
          _drill_key: String(x.item),
          _link: `/activity/${x.id}`
        }))
      )
    }
    case 'adoption': {
      if (!key) throw new DrillError(400, 'Name the feature')
      const like = key.replace(/[%_[]/g, '[$&]').replace(/:uuid|:id|:key/g, '%')
      const r = await rows(
        `SELECT u.id, u.first_name, u.last_name, u.email, ro.name role, COUNT(*) n FROM ${logs()} JOIN nivaro_users u ON u.id = l.[user] LEFT JOIN nivaro_roles ro ON ro.id = u.role
          WHERE l.created_at >= ? AND l.created_at < ? AND l.path LIKE ? GROUP BY u.id, u.first_name, u.last_name, u.email, ro.name ORDER BY n DESC`,
        [S, E, `${like}%`]
      )
      return out(
        `Who used ${key}`,
        'People who used this feature in the window.',
        [C.person, { key: 'role', label: 'Role' }, C.n],
        people(r.slice(0, limit), win, (x) => ({ n: num(x.n) })),
        r.length
      )
    }
    case 'support': {
      const r = await rows(
        `SELECT TOP ${limit} t.id, t.title, t.status, t.created_at, t.completed_at, c.first_name, c.last_name FROM nivaro_tasks t LEFT JOIN nivaro_users c ON c.id = t.created_by
          WHERE t.kind = 'support' AND ((t.created_at >= ? AND t.created_at < ?) OR (t.completed_at >= ? AND t.completed_at < ?) OR (t.completed_at IS NULL AND ? = 'open'))
          ORDER BY t.created_at`,
        [S, E, S, E, key ?? '']
      )
      return out(
        key === 'open' ? 'Open support tickets' : 'Support tickets',
        'Opened or closed in the window. Open one on the Support desk.',
        [{ key: 'opened', label: 'Opened' }, C.person, { key: 'title', label: 'Ticket' }, C.status],
        r.map((x) => ({
          opened: new Date(String(x.created_at)).toISOString().slice(0, 10),
          person: name(x),
          title: str(x.title),
          status: str(x.status),
          _link: `/support?ticket=${x.id}`
        }))
      )
    }
    case 'ai_calls': {
      if (key === 'thumbs_up' || key === 'thumbs_down') {
        const f = await rows(
          `SELECT TOP ${limit} f.created_at, f.rating, f.comment, u.first_name, u.last_name FROM nivaro_ai_feedback f LEFT JOIN nivaro_users u ON u.id = f.[user]
            WHERE f.created_at >= ? AND f.created_at < ? AND f.rating ${key === 'thumbs_up' ? '> 0' : '< 0'} ORDER BY f.created_at`,
          range
        )
        return out(
          key === 'thumbs_up' ? 'AI answers people liked' : 'AI answers people disliked',
          'Feedback on AI answers.',
          [C.time, C.person, { key: 'comment', label: 'Comment' }],
          f.map((x) => ({
            time: t(x.created_at),
            person: name(x),
            comment: str(x.comment),
            _link: '/ai/quality'
          }))
        )
      }
      const special =
        key === 'errors'
          ? `AND c.status <> 'ok' AND c.status <> 'success'`
          : key === 'refusals'
            ? `AND c.stop_reason = 'refusal'`
            : ''
      if (special) {
        const r = await rows(
          `SELECT TOP ${limit} c.created_at, c.feature, c.model, c.status, LEFT(c.error, 200) err, u.first_name, u.last_name FROM nivaro_ai_calls c LEFT JOIN nivaro_users u ON u.id = c.[user]
            WHERE c.created_at >= ? AND c.created_at < ? ${special} ORDER BY c.created_at`,
          range
        )
        return out(
          key === 'errors' ? 'AI calls that failed' : 'AI refusals',
          'Each call with what went wrong.',
          [
            C.time,
            C.person,
            { key: 'feature', label: 'Feature' },
            { key: 'model', label: 'Model' },
            C.status,
            C.message
          ],
          r.map((x) => ({
            time: t(x.created_at),
            person: name(x) ?? 'System',
            feature: str(x.feature),
            model: str(x.model),
            status: str(x.status),
            message: str(x.err),
            _link: '/ai/quality'
          }))
        )
      }
      const r = await rows(
        `SELECT TOP ${limit} c.created_at, c.feature, c.model, c.status, c.input_tokens, c.output_tokens, c.cost_usd, c.latency_ms, LEFT(c.error, 160) err, u.first_name, u.last_name FROM nivaro_ai_calls c LEFT JOIN nivaro_users u ON u.id = c.[user]
          WHERE c.created_at >= ? AND c.created_at < ? ${key ? 'AND c.feature = ?' : ''} ORDER BY c.created_at`,
        key ? [S, E, key] : range
      )
      return out(
        key ? `AI: ${key}` : 'AI calls',
        'Each AI call with its cost.',
        [
          C.time,
          C.person,
          { key: 'feature', label: 'Feature' },
          { key: 'model', label: 'Model' },
          { key: 'tokens', label: 'Tokens', type: 'number' },
          { key: 'cost', label: 'Cost', type: 'usd' },
          C.ms,
          C.message
        ],
        r.map((x) => ({
          time: t(x.created_at),
          person: name(x) ?? 'System',
          feature: str(x.feature),
          model: str(x.model),
          tokens: num(x.input_tokens) + num(x.output_tokens),
          cost: Math.round(num(x.cost_usd) * 10000) / 10000,
          ms: num(x.latency_ms),
          message: str(x.err),
          _link: '/ai/quality'
        }))
      )
    }
    case 'data_quality': {
      if (!key) throw new DrillError(400, 'Name the collection')
      const [run] = await rows(
        `SELECT TOP 1 id FROM nivaro_conformance_runs WHERE collection = ? AND finished_at >= ? AND finished_at < ? ORDER BY finished_at DESC`,
        [key, S, E]
      )
      if (!run) return out(key, 'No data-quality run finished for it in the window.', [], [])
      const r = await rows(
        `SELECT TOP ${limit} item_id, item_label, field, rule, message FROM nivaro_conformance_findings WHERE run = ?`,
        [run.id]
      )
      const [cnt] = await rows(`SELECT COUNT(*) n FROM nivaro_conformance_findings WHERE run = ?`, [
        run.id
      ])
      return out(
        `Data-quality problems in ${key}`,
        'Each record the sweep flagged; it opens in the drawer.',
        [
          { key: 'record', label: 'Record' },
          { key: 'field', label: 'Field' },
          { key: 'rule', label: 'Rule' },
          C.message
        ],
        r.map((x) => ({
          record: str(x.item_label) ?? str(x.item_id),
          field: str(x.field),
          rule: str(x.rule),
          message: str(x.message),
          _record_collection: key,
          _record_id: str(x.item_id)
        })),
        num(cnt?.n)
      )
    }
    case 'section':
      return out(
        key ?? 'Section',
        'This number comes from an extension; it has no rows behind it to list.',
        [],
        []
      )
    case 'score': {
      const parts = ctx.digest?.score.parts ?? []
      const target = (label: string): { m: OpsDrillMetric; k?: string } | null => {
        if (/server errors/.test(label)) return { m: 'server_errors' }
        if (/deadlocks/.test(label)) return { m: 'deadlocks' }
        if (/over 5 s/.test(label)) return { m: 'over5s' }
        if (/^p95/.test(label)) return { m: 'latency' }
        if (/partner sends/.test(label)) return { m: 'integration_failures' }
        if (/integration alarms/.test(label)) return { m: 'open_alarms' }
        if (/failed jobs/.test(label)) return { m: 'job_failures' }
        if (/freezes/.test(label)) return { m: 'issues' }
        if (/hit trouble/.test(label)) return { m: 'trouble_people' }
        if (/browser errors/.test(label)) return { m: 'browser_errors' }
        return null
      }
      return out(
        `Health score ${ctx.digest?.score.value ?? ''}/100`,
        'The score starts at 100; each line took points off (capped). Open a line for the rows behind it.',
        [
          { key: 'part', label: 'What' },
          { key: 'points', label: 'Points off', type: 'number' }
        ],
        parts.map((p) => {
          const tg = target(p.label)
          return {
            part: p.label,
            points: p.points,
            ...(tg ? { _drill_metric: tg.m, _drill_key: tg.k ?? null } : {})
          }
        })
      )
    }
    case 'bugs':
      return out(
        'Bug tracker',
        "Bugs followed from report to report. Open one for today's rows behind it.",
        [
          { key: 'title', label: 'Bug' },
          C.status,
          { key: 'kind', label: 'Kind' },
          { key: 'first', label: 'First seen' },
          { key: 'days', label: 'Days', type: 'number' },
          { key: 'today', label: 'Today', type: 'number' },
          { key: 'fixed_in', label: 'Fixed in' }
        ],
        (ctx.tracker ?? [])
          .filter((b) => key !== 'open' || b.status !== 'fixed')
          .map((b) => {
            const [kind, ...rest] = b.key.split(':')
            const route = rest.join(':')
            const nav: DrillRow =
              kind === '500'
                ? { _drill_metric: 'server_errors', _drill_key: route }
                : /^\d{3}$/.test(kind)
                  ? { _drill_metric: 'client_errors', _drill_key: `${kind} ${route}` }
                  : kind === 'slow'
                    ? { _drill_metric: 'slow_route', _drill_key: route }
                    : kind === 'deadlock'
                      ? { _drill_metric: 'deadlocks', _drill_key: null }
                      : kind === 'send'
                        ? { _drill_metric: 'integration_failures', _drill_key: route.split(':')[0] }
                        : kind === 'job'
                          ? { _drill_metric: 'job', _drill_key: route }
                          : kind === 'client'
                            ? { _drill_metric: 'browser_errors', _drill_key: null }
                            : {}
            return {
              title: b.title,
              status: b.status,
              kind: b.kind,
              first: b.first_seen,
              days: b.days_seen,
              today: b.today_count,
              fixed_in: b.fixed_in,
              ...nav
            }
          })
      )
    case 'capacity': {
      const backups = isMssql(db)
        ? await rows(
            `SELECT TOP 40 type, backup_start_date s, backup_finish_date f, CAST(backup_size / 1048576 AS bigint) mb, CAST(compressed_backup_size / 1048576 AS bigint) cmb, is_copy_only
               FROM msdb.dbo.backupset WHERE database_name = DB_NAME() AND backup_finish_date >= DATEADD(day, -7, GETDATE()) ORDER BY backup_finish_date DESC`
          )
        : []
      const c = ctx.digest?.capacity
      return out(
        'Capacity',
        'Database backups over the last 7 days (server local time), plus drive space, connection pools and restarts below.',
        [
          { key: 'when', label: 'Finished' },
          { key: 'type', label: 'Type' },
          { key: 'size', label: 'Size (MB)', type: 'number' },
          { key: 'took', label: 'Took (min)', type: 'number' }
        ],
        backups.map((b) => ({
          when: String(b.f).slice(0, 24),
          type:
            b.type === 'D'
              ? 'Full'
              : b.type === 'I'
                ? 'Differential'
                : b.type === 'L'
                  ? 'Log'
                  : String(b.type),
          size: num(b.cmb) || num(b.mb),
          took: Math.round(
            (new Date(String(b.f)).getTime() - new Date(String(b.s)).getTime()) / 60_000
          )
        })),
        backups.length,
        {
          fields: [
            { label: 'Request pool (max connections)', value: c?.pool?.main_max ?? null },
            { label: 'Background pool (max connections)', value: c?.pool?.background_max ?? null },
            {
              label: 'Memory of the reporting process',
              value: c?.memory_mb != null ? `${c.memory_mb} MB` : null
            },
            ...(c?.disk ?? []).map((d) => ({
              label: `Drive ${d.path}`,
              value: `${d.free_gb} GB free (${d.free_pct}%)`
            })),
            ...(c?.restarts ?? []).map((r) => ({ label: `Restart at ${r.at}`, value: r.what }))
          ],
          blocks: []
        }
      )
    }
    case 'access': {
      const r = await rows(
        `SELECT TOP ${limit} a.id, a.[timestamp] t, a.action, LEFT(a.comment, 200) c, u.id uid, u.first_name, u.last_name FROM nivaro_activity a LEFT JOIN nivaro_users u ON u.id = a.[user]
          WHERE a.[timestamp] >= ? AND a.[timestamp] < ? AND a.action IN ('access-request', 'access-request-grant', 'access-request-remind') ORDER BY a.[timestamp]`,
        range
      )
      const waiting = await rows(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.created_at FROM nivaro_users u JOIN nivaro_settings s ON s.access_request_role = u.role WHERE u.status = 'active'`
      )
      return out(
        'Access requests',
        'Requests and grants in the window; people still waiting for a role are listed first.',
        [C.time, C.person, { key: 'what', label: 'What' }, C.message],
        [
          ...waiting.map((x) => ({
            time: 'Waiting',
            person: name(x) ?? str(x.email),
            what: 'Waiting for a role',
            message: str(x.email),
            _drill_metric: 'person',
            _drill_key: String(x.id),
            _link: `/users/${x.id}`
          })),
          ...r.map((x) => ({
            time: t(x.t),
            person: name(x),
            what:
              x.action === 'access-request-grant'
                ? 'Granted'
                : x.action === 'access-request-remind'
                  ? 'Admins reminded'
                  : 'Asked',
            message: str(x.c),
            _link: `/activity/${x.id}`
          }))
        ]
      )
    }
    case 'pending_sends': {
      const r = await rows(
        `SELECT TOP ${limit} s.id, s.created_at, s.collection, s.item, s.status, s.next_retry_at, a.name api FROM nivaro_erp_submissions s LEFT JOIN nivaro_external_apis a ON a.id = s.external_api
          WHERE s.status IN ('pending', 'retrying', 'queued') ${key ? 'AND a.name = ?' : ''} ORDER BY s.created_at`,
        key ? [key] : []
      )
      return out(
        'Partner sends waiting',
        'Sends queued or waiting to retry; the record opens in the drawer.',
        [
          { key: 'api', label: 'Partner' },
          { key: 'record', label: 'Record' },
          C.status,
          { key: 'since', label: 'Since' },
          { key: 'retry', label: 'Next try' }
        ],
        r.map((x) => ({
          api: str(x.api),
          record: `${x.collection} ${x.item}`,
          status: str(x.status),
          since: new Date(String(x.created_at)).toISOString().slice(0, 16).replace('T', ' '),
          retry: x.next_retry_at
            ? new Date(String(x.next_retry_at)).toISOString().slice(0, 16).replace('T', ' ')
            : null,
          _drill_metric: 'submission',
          _drill_key: String(x.id),
          _record_collection: str(x.collection),
          _record_id: str(x.item)
        }))
      )
    }
    case 'expiring': {
      const list = ctx.digest?.watch.expiring ?? []
      const keys = await rows(
        `SELECT id, name, expires_at, last_used_at FROM nivaro_api_keys WHERE expires_at IS NOT NULL AND expires_at < ? ORDER BY expires_at`,
        [new Date(E.getTime() + 30 * 86_400_000)]
      )
      return out(
        'Expiring soon',
        'API keys and certificates that expire within 30 days.',
        [
          { key: 'what', label: 'What' },
          { key: 'name', label: 'Name' },
          { key: 'expires', label: 'Expires' },
          { key: 'days', label: 'Days left', type: 'number' },
          { key: 'last_used', label: 'Last used' }
        ],
        [
          ...list
            .filter((x) => x.what !== 'api_key')
            .map((x) => ({
              what: x.what === 'certificate' ? 'Certificate' : 'Secret',
              name: x.name,
              expires: x.expires,
              days: x.days,
              last_used: null
            })),
          ...keys.map((k) => ({
            what: 'API key',
            name: str(k.name),
            expires: new Date(String(k.expires_at)).toISOString().slice(0, 10),
            days: Math.ceil((new Date(String(k.expires_at)).getTime() - E.getTime()) / 86_400_000),
            last_used: k.last_used_at
              ? new Date(String(k.last_used_at)).toISOString().slice(0, 10)
              : null,
            _link: '/api-keys'
          }))
        ]
      )
    }
    default:
      throw new DrillError(400, `Unknown metric "${metric}"`)
  }
}

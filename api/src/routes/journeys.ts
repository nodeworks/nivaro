import type { FastifyInstance } from 'fastify'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Journey trail — per-session admin route breadcrumbs, persisted by the
 * page:at socket handler. Admin-only: this is user tracking; keep it out of
 * regular hands.
 */

interface JourneyRow {
  id: number
  user: string
  session_id: string
  path: string
  entered_at: Date
  duration_seconds: number | null
}

// ─── One day of one person (#1367) ───────────────────────────────────────────

/** Per-lane row caps; a lane that hits its cap is named in `capped`. */
export const DAY_CAPS = { recordings: 200, pages: 2000, transitions: 500, tasks: 500 } as const
/** Raw request rows read when the database cannot bucket by minute itself. */
const REQUEST_ROW_CAP = 50_000
/** A real zone sits within UTC−12…UTC+14; anything further is clamped. */
const MAX_TZ_OFFSET = 14 * 60

export interface DayWindow {
  date: string
  /** Minutes, as the browser's getTimezoneOffset() gives them (UTC − local). */
  tzOffset: number
  start: Date
  end: Date
}

/**
 * The viewer's calendar day as two UTC instants. `tz_offset` is the viewer's
 * getTimezoneOffset() at local midnight of that date; without one the
 * server's own offset is used, as GET /journeys/user does. A date that is not
 * a real calendar day (2026-02-31) or an offset that is not a whole number is
 * refused; an offset past ±14 hours is clamped.
 */
export function dayWindow(
  dateRaw: string | undefined,
  tzRaw: string | number | undefined,
  now: Date = new Date()
): DayWindow | { error: string } {
  let tzOffset: number | null = null
  if (tzRaw !== undefined && String(tzRaw).trim() !== '') {
    const n = Number(tzRaw)
    if (!Number.isInteger(n)) return { error: 'tz_offset must be a whole number of minutes' }
    tzOffset = Math.max(-MAX_TZ_OFFSET, Math.min(MAX_TZ_OFFSET, n))
  }
  const date =
    dateRaw ??
    (tzOffset == null
      ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      : new Date(now.getTime() - tzOffset * 60_000).toISOString().slice(0, 10))
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return { error: 'date must be YYYY-MM-DD' }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const utcMidnight = Date.UTC(y, mo - 1, d)
  if (new Date(utcMidnight).toISOString().slice(0, 10) !== date) {
    return { error: 'date must be a real calendar day' }
  }
  if (tzOffset == null) tzOffset = new Date(y, mo - 1, d).getTimezoneOffset()
  const start = new Date(utcMidnight + tzOffset * 60_000)
  return { date, tzOffset, start, end: new Date(start.getTime() + 86_400_000) }
}

/** Raw request rows → per-minute counts (the portable fallback to SQL bucketing). */
export function bucketByMinute(
  rows: ReadonlyArray<{ created_at: Date | string; status: number | string }>,
  start: Date
): Array<{ m: number; n: number; errors: number }> {
  const out = new Map<number, { m: number; n: number; errors: number }>()
  for (const r of rows) {
    const t = new Date(r.created_at).getTime()
    if (!Number.isFinite(t)) continue
    const m = Math.floor((t - start.getTime()) / 60_000)
    const b = out.get(m) ?? { m, n: 0, errors: 0 }
    b.n++
    if (Number(r.status) >= 400) b.errors++
    out.set(m, b)
  }
  return [...out.values()].sort((a, b) => a.m - b.m)
}

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
const fmtOffset = (tzOffset: number) => {
  const east = -tzOffset
  const a = Math.abs(east)
  return `UTC${east < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

type TaskRow = { id: number; title: string; collection: string | null; item: string | null }

/**
 * Everything one person did on one day, one list per lane. A lane whose table
 * is missing (or whose read fails) answers null so the timeline drops that
 * lane instead of the whole day failing.
 */
export async function loadPersonDay(userId: string, w: DayWindow) {
  const { start, end } = w
  const capped = new Set<string>()
  const lane = async <T>(name: string, read: () => Promise<T[]>, cap?: number) => {
    try {
      const rows = await read()
      if (cap != null && rows.length >= cap) capped.add(name)
      return rows
    } catch {
      return null
    }
  }

  const readRecordings = async () => {
    const rows = (await db('nivaro_session_recordings')
      .where('user', userId)
      .where('started_at', '<', end)
      .where((q) =>
        q
          .where('started_at', '>=', start)
          .orWhere('ended_at', '>=', start)
          .orWhere('last_event_at', '>=', start)
      )
      .orderBy('started_at', 'asc')
      .limit(DAY_CAPS.recordings)
      .select('id', 'app', 'started_at', 'ended_at', 'last_event_at')) as Array<{
      id: string
      app: string | null
      started_at: Date
      ended_at: Date | null
      last_event_at: Date | null
    }>
    const liveSince = Date.now() - 2 * 60_000
    return rows.map((r) => ({
      id: String(r.id),
      app: r.app ?? null,
      start: iso(r.started_at),
      end: iso(r.ended_at ?? r.last_event_at ?? r.started_at),
      live:
        r.ended_at == null &&
        r.last_event_at != null &&
        new Date(r.last_event_at).getTime() > liveSince
    }))
  }

  const readPages = async () => {
    const rows = (await db('nivaro_admin_journeys')
      .where({ user: userId })
      .where('entered_at', '>=', start)
      .where('entered_at', '<', end)
      .orderBy('entered_at', 'asc')
      .limit(DAY_CAPS.pages)
      .select('session_id', 'path', 'entered_at', 'duration_seconds')) as Array<
      Pick<JourneyRow, 'session_id' | 'path' | 'entered_at' | 'duration_seconds'>
    >
    // A step with no duration lasted until the next step of its session (at
    // most 30 minutes), else a nominal minute.
    const next = new Map<number, number>()
    const seen = new Map<string, number>()
    for (let i = rows.length - 1; i >= 0; i--) {
      const n = seen.get(rows[i].session_id)
      if (n != null) next.set(i, n)
      seen.set(rows[i].session_id, new Date(rows[i].entered_at).getTime())
    }
    return rows.map((r, i) => {
      const s = new Date(r.entered_at).getTime()
      const n = next.get(i)
      const e =
        r.duration_seconds != null
          ? s + r.duration_seconds * 1000
          : n != null && n - s <= 30 * 60_000
            ? n
            : s + 60_000
      return {
        path: r.path,
        session_id: r.session_id,
        start: iso(r.entered_at),
        end: new Date(Math.max(s, e)).toISOString(),
        duration_seconds: r.duration_seconds
      }
    })
  }

  const readRequests = async () => {
    let buckets: Array<{ m: number; n: number; errors: number }>
    if (isMssql(db)) {
      // Bucket in a derived table so the DATEDIFF parameter appears once —
      // SQL Server will not match a parameterised SELECT expression to the
      // same expression in GROUP BY.
      const inner = db('nivaro_api_logs')
        .where('user', userId)
        .where('created_at', '>=', start)
        .where('created_at', '<', end)
        .select(db.raw('DATEDIFF(minute, ?, created_at) AS m', [start]), 'status')
      const rows = (await db
        .from(inner.as('x'))
        .select('m')
        .count({ n: '*' })
        .select(db.raw('SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors'))
        .groupBy('m')
        .orderBy('m', 'asc')) as Array<{ m: number; n: number | string; errors: number | string }>
      buckets = rows.map((r) => ({ m: Number(r.m), n: Number(r.n), errors: Number(r.errors) }))
    } else {
      const rows = (await db('nivaro_api_logs')
        .where('user', userId)
        .where('created_at', '>=', start)
        .where('created_at', '<', end)
        .limit(REQUEST_ROW_CAP)
        .select('created_at', 'status')) as Array<{ created_at: Date; status: number }>
      if (rows.length >= REQUEST_ROW_CAP) capped.add('requests')
      buckets = bucketByMinute(rows, start)
    }
    return buckets
      .filter((b) => b.m >= 0 && b.m < 1440)
      .map((b) => ({
        minute: new Date(start.getTime() + b.m * 60_000).toISOString(),
        count: b.n,
        errors: b.errors
      }))
  }

  const readTransitions = async () => {
    const rows = (await db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .leftJoin('nivaro_workflow_states as fs', 'fs.id', 'h.from_state')
      .leftJoin('nivaro_workflow_states as ts', 'ts.id', 'h.to_state')
      .leftJoin('nivaro_workflow_transitions as tr', 'tr.id', 'h.transition')
      .where('h.user', userId)
      .where('h.timestamp', '>=', start)
      .where('h.timestamp', '<', end)
      .orderBy('h.timestamp', 'asc')
      .limit(DAY_CAPS.transitions)
      .select(
        'h.id',
        'h.timestamp',
        'i.collection',
        'i.item',
        'fs.label as from_label',
        'ts.label as to_label',
        'tr.label as transition_label'
      )) as Array<{
      id: number
      timestamp: Date
      collection: string
      item: string
      from_label: string | null
      to_label: string | null
      transition_label: string | null
    }>
    return rows.map((r) => ({
      id: Number(r.id),
      at: iso(r.timestamp),
      collection: r.collection,
      item: String(r.item),
      from: r.from_label ?? null,
      to: r.to_label ?? null,
      label: r.transition_label ?? null
    }))
  }

  // Created and completed are two reads: completed_by arrived with migration
  // 372, and a database behind it still shows the tasks they created.
  const readTasks = async () => {
    const [created, completed] = await Promise.all([
      lane('tasks', async () =>
        (
          (await db('nivaro_tasks')
            .where('created_by', userId)
            .where('created_at', '>=', start)
            .where('created_at', '<', end)
            .orderBy('created_at', 'asc')
            .limit(DAY_CAPS.tasks)
            .select('id', 'title', 'collection', 'item', 'created_at')) as Array<
            TaskRow & { created_at: Date }
          >
        ).map((r) => ({ ...r, at: r.created_at, kind: 'created' as const }))
      ),
      lane('tasks', async () =>
        (
          (await db('nivaro_tasks')
            .where('completed_by', userId)
            .where('completed_at', '>=', start)
            .where('completed_at', '<', end)
            .orderBy('completed_at', 'asc')
            .limit(DAY_CAPS.tasks)
            .select('id', 'title', 'collection', 'item', 'completed_at')) as Array<
            TaskRow & { completed_at: Date }
          >
        ).map((r) => ({ ...r, at: r.completed_at, kind: 'completed' as const }))
      )
    ])
    if (!created && !completed) return null
    const all = [...(created ?? []), ...(completed ?? [])]
      .map((r) => ({
        id: Number(r.id),
        at: iso(r.at),
        kind: r.kind,
        title: String(r.title ?? ''),
        collection: r.collection || null,
        item: r.item != null && r.item !== '' ? String(r.item) : null
      }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    if (all.length >= DAY_CAPS.tasks) capped.add('tasks')
    return all.slice(0, DAY_CAPS.tasks)
  }

  const [recordings, pages, requests, transitions, tasks] = await Promise.all([
    lane('recordings', readRecordings, DAY_CAPS.recordings),
    lane('pages', readPages, DAY_CAPS.pages),
    lane('requests', readRequests),
    lane('transitions', readTransitions, DAY_CAPS.transitions),
    readTasks()
  ])

  return {
    date: w.date,
    tz_offset: w.tzOffset,
    day_start: start.toISOString(),
    day_end: end.toISOString(),
    recordings,
    pages,
    requests,
    transitions,
    tasks,
    capped: [...capped]
  }
}

export async function journeyRoutes(app: FastifyInstance) {
  // #42 — live "who else is here": the page-presence pings admin pages send
  // (page:at), filtered to one path. The caller is excluded client-side.
  app.get<{ Querystring: { path?: string } }>(
    '/here',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const path = String(req.query.path ?? '').slice(0, 200)
      if (!/^\/(?!\/)[A-Za-z0-9/_\-?=&.%~]*$/.test(path))
        return reply.code(400).send({ error: 'Bad path' })
      const { usersOnPath } = await import('../plugins/socketio.js')
      return { data: usersOnPath(path) }
    }
  )
  // GET /journeys/user/:id?date=YYYY-MM-DD  (defaults to today)
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    '/user/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const dateStr = req.query.date ?? new Date().toISOString().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return reply.code(400).send({ error: 'date must be YYYY-MM-DD' })
      }
      const dayStart = new Date(`${dateStr}T00:00:00`)
      const dayEnd = new Date(dayStart.getTime() + 86_400_000)

      const rows = (await db('nivaro_admin_journeys')
        .where({ user: req.params.id })
        .where('entered_at', '>=', dayStart)
        .where('entered_at', '<', dayEnd)
        .orderBy('entered_at', 'asc')
        .limit(2000)) as JourneyRow[]

      // Group into sessions, ordered by first entry
      const sessions = new Map<string, JourneyRow[]>()
      for (const r of rows) {
        const list = sessions.get(r.session_id) ?? []
        list.push(r)
        sessions.set(r.session_id, list)
      }

      return reply.send({
        data: {
          date: dateStr,
          sessions: [...sessions.values()].map((steps) => ({
            session_id: steps[0].session_id,
            started_at: steps[0].entered_at,
            steps: steps.map((s) => ({
              path: s.path,
              entered_at: s.entered_at,
              duration_seconds: s.duration_seconds
            }))
          }))
        }
      })
    }
  )

  // GET /journeys/day/:id?date=YYYY-MM-DD&tz_offset=<minutes> — #1367, the
  // People page's Day view: recordings, pages, requests per minute,
  // transitions and tasks for one day in the VIEWER's zone. Reading someone's
  // day writes an activity row, as an administrator reading the chat log does.
  app.get<{ Params: { id: string }; Querystring: { date?: string; tz_offset?: string } }>(
    '/day/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const w = dayWindow(req.query.date, req.query.tz_offset)
      if ('error' in w) return reply.code(400).send({ error: w.error })
      const data = await loadPersonDay(req.params.id, w)
      void logActivity({
        action: 'person-day-read',
        user: req.user?.id,
        collection: 'nivaro_users',
        item: req.params.id,
        comment: `Opened the day of ${w.date} (${fmtOffset(w.tzOffset)}) on the People page`,
        req
      })
      return reply.send({ data })
    }
  )

  // GET /journeys/days/:id — which days have data (for the day picker), last 30
  app.get<{ Params: { id: string } }>(
    '/days/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const cutoff = new Date(Date.now() - 30 * 86_400_000)
      const rows = (await db('nivaro_admin_journeys')
        .where({ user: req.params.id })
        .where('entered_at', '>', cutoff)
        .select(db.raw('CAST(entered_at AS DATE) as day'))
        .count({ n: '*' })
        .groupByRaw('CAST(entered_at AS DATE)')
        .orderBy('day', 'desc')) as Array<{ day: string | Date; n: number | string }>
      return reply.send({
        data: rows.map((r) => ({
          date:
            r.day instanceof Date
              ? `${r.day.getFullYear()}-${String(r.day.getMonth() + 1).padStart(2, '0')}-${String(r.day.getDate()).padStart(2, '0')}`
              : String(r.day).slice(0, 10),
          steps: Number(r.n)
        }))
      })
    }
  )
}

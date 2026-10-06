// A manager's view of their direct reports (#1030–#1043): who reports to whom,
// what the team finished and missed this week, the SLA trend, tasks owed,
// time off ahead, 1:1 preparation, new starters and access that may be stale.
//
// "Report" = a user whose nivaro_users.manager_id is the manager. Every count
// and every record listed is narrowed to what the VIEWER may read — the same
// rule the profile's Working on card follows — so two people asking about the
// same person may see different numbers.

import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { selectInChunks } from './db-batch.js'

export interface Viewer {
  id: string
  isAdmin: boolean
  role?: string | null
}

// ── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_STUCK_HOURS = 240
let stuckCache: { at: number; value: number } | null = null

export function bustTeamSettings(): void {
  stuckCache = null
}

/** Hours an open record may sit in one state before the team view calls it stuck. */
export async function teamStuckHours(): Promise<number> {
  if (stuckCache && Date.now() - stuckCache.at < 60_000) return stuckCache.value
  let value = DEFAULT_STUCK_HOURS
  if (await hasColumn('nivaro_settings', 'team_stuck_hours')) {
    const row = (await db('nivaro_settings')
      .where('id', 1)
      .first('team_stuck_hours')
      .catch(() => undefined)) as { team_stuck_hours?: number | null } | undefined
    const n = Number(row?.team_stuck_hours)
    if (Number.isInteger(n) && n > 0) value = n
  }
  stuckCache = { at: Date.now(), value }
  return value
}

// ── Who reports to whom ──────────────────────────────────────────────────────

export const nameOf = (r: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  id?: string
}): string => [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || String(r.id ?? '')

const same = (a: unknown, b: unknown) =>
  String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()

export interface ReportRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  title: string | null
  status: string | null
  role: string | null
  created_at: Date | null
  last_access: Date | null
  is_out_of_office: boolean | number | null
  ooo_start: Date | null
  ooo_end: Date | null
  delegate_id: string | null
  delegate_expires_at: Date | null
  preferences: string | null
}

/** Active, human direct reports (the people the profile lists a colleague). */
export async function reportsOf(managerId: string): Promise<ReportRow[]> {
  return (await db('nivaro_users')
    .where('manager_id', managerId)
    .where((w) => w.where('is_redacted', false).orWhereNull('is_redacted'))
    .where((w) => w.where('status', 'active').orWhereNull('status'))
    .whereNull('account_kind')
    .orderBy('first_name')
    .select(
      'id',
      'first_name',
      'last_name',
      'email',
      'title',
      'status',
      'role',
      'created_at',
      'last_access',
      'is_out_of_office',
      'ooo_start',
      'ooo_end',
      'delegate_id',
      'delegate_expires_at',
      'preferences'
    )) as ReportRow[]
}

/** Whether `userId` has at least one active, human direct report. */
export async function hasReports(userId: string): Promise<boolean> {
  const row = await db('nivaro_users')
    .where('manager_id', userId)
    .where((w) => w.where('is_redacted', false).orWhereNull('is_redacted'))
    .where((w) => w.where('status', 'active').orWhereNull('status'))
    .whereNull('account_kind')
    .first('id')
    .catch(() => undefined)
  return !!row
}

/** Whether `managerId` is `userId`'s manager. */
export async function isManagerOf(managerId: string, userId: string): Promise<boolean> {
  const row = (await db('nivaro_users')
    .where('id', userId)
    .first('manager_id')
    .catch(() => undefined)) as { manager_id?: string | null } | undefined
  return !!row?.manager_id && same(row.manager_id, managerId)
}

/** The viewer as a full user row (role, flags) for permission checks. */
export async function viewerUser(viewer: Viewer): Promise<User | null> {
  return ((await db('nivaro_users')
    .where('id', viewer.id)
    .first()
    .catch(() => null)) ?? null) as User | null
}

// ── Record visibility ────────────────────────────────────────────────────────

/**
 * The records (collection, id) the viewer may open, through the same gates a
 * record read applies (role, row filter, user scopes).
 */
export async function readableRecords(
  viewer: User | null,
  byCollection: Map<string, Set<string>>
): Promise<Set<string>> {
  const out = new Set<string>()
  if (!viewer) return out
  const { compileAccessGates, visibleIds } = await import('./record-access.js')
  for (const [collection, ids] of byCollection) {
    if (!collection || ids.size === 0) continue
    try {
      const gates = await compileAccessGates(viewer, collection)
      if (!gates.permitted) continue
      const visible = await visibleIds(gates, [...ids])
      for (const id of visible) out.add(`${collection}:${id}`)
    } catch {
      // An unreadable or unregistered collection: none of its records show.
    }
  }
  return out
}

async function labelsFor(byCollection: Map<string, Set<string>>): Promise<Record<string, string>> {
  if (byCollection.size === 0) return {}
  const { getLabels } = await import('./queues.js')
  return getLabels(byCollection).catch(() => ({}))
}

// ── Workflow history for people ──────────────────────────────────────────────

export interface HistoryFigures {
  completions: number
  send_backs: number
  records: Array<{ collection: string; item_id: string; at: Date }>
}

/**
 * Per person: pipeline moves they made into a finished (terminal, not
 * cancelled) state, and moves they made backwards — the throughput report's
 * definitions, across every bound collection.
 */
export async function historyFor(
  userIds: string[],
  from: Date,
  to = new Date()
): Promise<Map<string, HistoryFigures>> {
  const out = new Map<string, HistoryFigures>()
  for (const u of userIds) out.set(u.toUpperCase(), { completions: 0, send_backs: 0, records: [] })
  if (userIds.length === 0) return out
  const rows = await selectInChunks(userIds, 1500, async (chunk) =>
    rawRows<{
      usr: string
      collection: string
      item: string
      ts: Date
      done: number
      back: number
    }>(
      await db.raw(
        `SELECT h.[user] AS usr, i.collection, i.item, h.[timestamp] AS ts,
                CASE WHEN st.is_terminal = 1 AND st.[key] <> 'canceled' THEN 1 ELSE 0 END AS done,
                CASE WHEN sf.sort IS NOT NULL AND sf.sort > st.sort THEN 1 ELSE 0 END AS back
         FROM nivaro_workflow_history h
         JOIN nivaro_workflow_instances i ON i.id = h.instance
         JOIN nivaro_workflow_states st ON st.id = h.to_state
         LEFT JOIN nivaro_workflow_states sf ON sf.id = h.from_state
         WHERE h.[timestamp] >= ? AND h.[timestamp] < ?
           AND NOT (h.from_state IS NULL AND h.[transition] IS NULL)
           AND h.[user] IN (${chunk.map(() => '?').join(',')})`,
        [from, to, ...chunk]
      )
    )
  ).catch(() => [])
  for (const r of rows) {
    const f = out.get(String(r.usr).toUpperCase())
    if (!f) continue
    if (Number(r.done) === 1) {
      f.completions++
      f.records.push({
        collection: String(r.collection),
        item_id: String(r.item),
        at: new Date(r.ts)
      })
    }
    if (Number(r.back) === 1) f.send_backs++
  }
  for (const f of out.values()) f.records.sort((a, b) => b.at.getTime() - a.at.getTime())
  return out
}

/** Partner pushes each person sent that the partner accepted (requested_by). */
export async function acceptedPushesFor(
  userIds: string[],
  from: Date
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (userIds.length === 0) return out
  if (!(await hasColumn('nivaro_erp_submissions', 'requested_by'))) return out
  const rows = (await selectInChunks(userIds, 1500, (chunk) =>
    db('nivaro_erp_submissions')
      .whereIn('requested_by', chunk)
      .where('status', 'accepted')
      .where('created_at', '>=', from)
      .groupBy('requested_by')
      .select('requested_by')
      .count({ n: '*' })
  ).catch(() => [])) as Array<{ requested_by: string; n: number | string }>
  for (const r of rows) out.set(String(r.requested_by).toUpperCase(), Number(r.n) || 0)
  return out
}

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const t = new Date(d)
  return Number.isFinite(t.getTime()) ? t.toISOString() : null
}

// ── #1032 Coverage countdown ─────────────────────────────────────────────────

export interface CoverageEntry {
  user: { id: string; name: string }
  currently_out: boolean
  ooo_start: string | null
  ooo_end: string | null
  delegate: { id: string; name: string } | null
  open: number
  reminded_at: string | null
}

export async function buildTeamCoverage(
  managerId: string,
  viewer: Viewer,
  days = 14
): Promise<CoverageEntry[]> {
  const { buildTeamLoad } = await import('./user-profile.js')
  const load = await buildTeamLoad(managerId, viewer)
  const horizon = Date.now() + days * 86_400_000
  const picked = load.reports.filter((r) => {
    if (r.out) return true
    const s = r.ooo_start ? new Date(r.ooo_start).getTime() : null
    return s != null && s > Date.now() && s <= horizon
  })
  const reminded = await lastReminders(picked.map((r) => r.id))
  const entries = picked.map((r) => ({
    user: { id: r.id, name: r.name },
    currently_out: r.out,
    ooo_start: r.ooo_start,
    ooo_end: r.ooo_end,
    delegate: r.delegate,
    open: r.open,
    reminded_at: reminded.get(r.id.toUpperCase()) ?? null
  }))
  entries.sort(
    (a, b) =>
      Number(!!a.delegate) - Number(!!b.delegate) ||
      Number(b.currently_out) - Number(a.currently_out) ||
      (a.ooo_start ?? '').localeCompare(b.ooo_start ?? '')
  )
  return entries
}

const REMIND_WINDOW_MS = 24 * 60 * 60_000

async function lastReminders(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (userIds.length === 0) return out
  const rows = (await db('nivaro_activity')
    .where('action', 'delegate-remind')
    .where('collection', 'nivaro_users')
    .whereIn('item', userIds)
    .where('timestamp', '>=', new Date(Date.now() - 30 * 86_400_000))
    .groupBy('item')
    .select('item')
    .max({ at: 'timestamp' })
    .catch(() => [])) as Array<{ item: string; at: Date }>
  for (const r of rows) {
    const at = iso(r.at)
    if (at) out.set(String(r.item).toUpperCase(), at)
  }
  return out
}

export class TeamError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public extra?: Record<string, unknown>
  ) {
    super(message)
  }
}

/** Ask a report to name a delegate before their time off (#1032). Once a day. */
export async function remindToDelegate(
  app: FastifyInstance,
  managerId: string,
  userId: string
): Promise<void> {
  const last = (await lastReminders([userId])).get(userId.toUpperCase())
  if (last && Date.now() - new Date(last).getTime() < REMIND_WINDOW_MS) {
    throw new TeamError(429, 'Already asked in the last day', 'REMIND_TOO_SOON', {
      next_at: new Date(new Date(last).getTime() + REMIND_WINDOW_MS).toISOString()
    })
  }
  const [manager, person] = (await Promise.all([
    db('nivaro_users').where('id', managerId).first('first_name', 'last_name', 'email', 'id'),
    db('nivaro_users').where('id', userId).first('id', 'ooo_start', 'is_out_of_office')
  ])) as [Parameters<typeof nameOf>[0] | undefined, { ooo_start?: Date | null } | undefined]
  if (!person) throw new TeamError(404, 'Not found')
  const who = manager ? nameOf(manager) : 'Your manager'
  const when = person.ooo_start
    ? new Date(person.ooo_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null
  const { notifyUser } = await import('./notification-channels.js')
  await notifyUser(app, userId, {
    subject: 'Set a delegate before your time off',
    message: `${who} asked you to name someone to cover your approvals${when ? ` from ${when}` : ''}, so your records keep moving while you are out.`,
    category: 'workflow',
    sender: managerId,
    always_inbox: true,
    why: `${who} is your manager and asked for this.`,
    source: { kind: 'manager', label: 'Manager request' },
    target: { kind: 'home', focus: 'delegate-prompt', action: 'open' }
  })
  await logActivity({
    action: 'delegate-remind',
    collection: 'nivaro_users',
    item: userId,
    user: managerId,
    comment: when ? `Asked to set a delegate before ${when}` : 'Asked to set a delegate'
  })
}

// ── #1034 Weekly team summary ────────────────────────────────────────────────

export interface TeamWeek {
  from: string
  to: string
  completions: number
  send_backs: number
  new_breaches: number
  per_report: Array<{
    id: string
    name: string
    completions: number
    send_backs: number
    new_breaches: number
  }>
  out: Array<{ id: string; name: string; ooo_start: string | null; ooo_end: string | null }>
  gaps_ahead: Array<{ id: string; name: string; ooo_start: string; open: number }>
}

export async function buildTeamWeek(managerId: string, viewer: Viewer): Promise<TeamWeek> {
  const { buildTeamLoad } = await import('./user-profile.js')
  const to = new Date()
  const from = new Date(to.getTime() - 7 * 86_400_000)
  const [load, rows] = await Promise.all([buildTeamLoad(managerId, viewer), reportsOf(managerId)])
  const hist = await historyFor(
    rows.map((r) => r.id),
    from,
    to
  )
  const loadById = new Map(load.reports.map((r) => [r.id.toUpperCase(), r]))
  const per_report = rows.map((r) => {
    const h = hist.get(r.id.toUpperCase())
    return {
      id: r.id,
      name: nameOf(r),
      completions: h?.completions ?? 0,
      send_backs: h?.send_backs ?? 0,
      new_breaches: loadById.get(r.id.toUpperCase())?.breached_week ?? 0
    }
  })
  const sum = (k: 'completions' | 'send_backs' | 'new_breaches') =>
    per_report.reduce((m, r) => m + r[k], 0)
  // Out at any point this week: a window that overlaps it, or the flag now.
  const out = rows
    .filter((r) => {
      if (r.is_out_of_office) return true
      const s = r.ooo_start ? new Date(r.ooo_start).getTime() : null
      const e = r.ooo_end ? new Date(r.ooo_end).getTime() : null
      return s != null && s <= to.getTime() && (e == null || e >= from.getTime())
    })
    .map((r) => ({
      id: r.id,
      name: nameOf(r),
      ooo_start: iso(r.ooo_start),
      ooo_end: iso(r.ooo_end)
    }))
  const horizon = to.getTime() + 14 * 86_400_000
  const gaps_ahead = load.reports
    .filter((r) => {
      const s = r.ooo_start ? new Date(r.ooo_start).getTime() : null
      return s != null && s > to.getTime() && s <= horizon && !r.delegate
    })
    .map((r) => ({ id: r.id, name: r.name, ooo_start: r.ooo_start as string, open: r.open }))
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    completions: sum('completions'),
    send_backs: sum('send_backs'),
    new_breaches: sum('new_breaches'),
    per_report,
    out,
    gaps_ahead
  }
}

// ── #1035 Team tasks ─────────────────────────────────────────────────────────

export interface TeamTask {
  id: number
  title: string
  due_date: string | null
  status: string
  priority: string | null
  overdue: boolean
  requested_by: { id: string; name: string } | null
  collection: string | null
  item: string | null
  label: string | null
  nudged_at: string | null
}

const ACTIVE_TASKS = ['open', 'in_progress']

const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

export async function buildTeamTasks(
  managerId: string,
  viewer: Viewer
): Promise<{
  hidden: number
  reports: Array<{ id: string; name: string; open: number; overdue: number; tasks: TeamTask[] }>
}> {
  const rows = await reportsOf(managerId)
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return { hidden: 0, reports: [] }
  const nudgedCol = await hasColumn('nivaro_tasks', 'nudged_at')
  const tasks = (await selectInChunks(ids, 1500, (chunk) =>
    db('nivaro_tasks as t')
      .leftJoin('nivaro_users as c', 'c.id', 't.created_by')
      .whereIn('t.assignee', chunk)
      .whereIn('t.status', ACTIVE_TASKS)
      .where((w) => w.whereNull('t.kind').orWhereNot('t.kind', 'support'))
      .select(
        't.id',
        't.title',
        't.due_date',
        't.status',
        't.priority',
        't.assignee',
        't.collection',
        't.item',
        't.created_by',
        ...(nudgedCol ? ['t.nudged_at'] : []),
        'c.first_name as c_first',
        'c.last_name as c_last',
        'c.email as c_email'
      )
  ).catch(() => [])) as Array<Record<string, unknown>>
  const user = await viewerUser(viewer)
  const byCollection = new Map<string, Set<string>>()
  for (const t of tasks) {
    if (!t.collection || !t.item) continue
    const c = String(t.collection)
    if (!byCollection.has(c)) byCollection.set(c, new Set())
    byCollection.get(c)!.add(String(t.item))
  }
  const readable = viewer.isAdmin
    ? new Set([...byCollection].flatMap(([c, s]) => [...s].map((i) => `${c}:${i}`)))
    : await readableRecords(user, byCollection)
  const readableByCollection = new Map<string, Set<string>>()
  for (const key of readable) {
    const [c, ...rest] = key.split(':')
    const id = rest.join(':')
    if (!readableByCollection.has(c)) readableByCollection.set(c, new Set())
    readableByCollection.get(c)!.add(id)
  }
  const labels = await labelsFor(readableByCollection)
  const today = startOfToday().getTime()
  let hidden = 0
  const byReport = new Map<string, TeamTask[]>()
  for (const t of tasks) {
    const onRecord = !!t.collection && !!t.item
    if (onRecord && !readable.has(`${t.collection}:${t.item}`)) {
      hidden++
      continue
    }
    const due = t.due_date ? new Date(t.due_date as string) : null
    const task: TeamTask = {
      id: Number(t.id),
      title: String(t.title ?? ''),
      due_date: iso(due),
      status: String(t.status),
      priority: (t.priority as string | null) ?? null,
      overdue: !!due && due.getTime() < today,
      requested_by: t.created_by
        ? {
            id: String(t.created_by),
            name: nameOf({
              first_name: t.c_first as string,
              last_name: t.c_last as string,
              email: t.c_email as string
            })
          }
        : null,
      collection: onRecord ? String(t.collection) : null,
      item: onRecord ? String(t.item) : null,
      label: onRecord ? (labels[`${t.collection}:${t.item}`] ?? null) : null,
      nudged_at: iso(t.nudged_at as Date | null)
    }
    const k = String(t.assignee).toUpperCase()
    if (!byReport.has(k)) byReport.set(k, [])
    byReport.get(k)!.push(task)
  }
  const reports = rows.map((r) => {
    const list = (byReport.get(r.id.toUpperCase()) ?? []).sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') ||
        a.id - b.id
    )
    return {
      id: r.id,
      name: nameOf(r),
      open: list.length,
      overdue: list.filter((t) => t.overdue).length,
      tasks: list.slice(0, 20)
    }
  })
  reports.sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.name.localeCompare(b.name))
  return { hidden, reports }
}

// ── #1038 Team SLA trend ─────────────────────────────────────────────────────

export interface TeamTrend {
  days: number
  since: string | null
  series: Array<{ date: string; breached: number; warning: number; at_risk: number }>
  change: { breached: number; at_risk: number }
  days_since_new_breach: number | null
}

const dayKey = (d: Date | string) => {
  const t = new Date(d)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/**
 * The per-owner daily queue snapshots, summed over the manager's reports. A
 * person counted by two queues on one day is counted once, at the larger of
 * the two, so a record never doubles for sitting in two worklists.
 */
export function trendFromSnapshots(
  rows: Array<{
    snapshot_date: Date | string
    user: string
    sla_breached: number
    sla_warning: number
    at_risk: number
  }>,
  days: number,
  today = new Date()
): TeamTrend {
  const perUserDay = new Map<string, { breached: number; warning: number; at_risk: number }>()
  let first: string | null = null
  for (const r of rows) {
    const d = dayKey(r.snapshot_date)
    if (!first || d < first) first = d
    const k = `${d}|${String(r.user).toUpperCase()}`
    const cur = perUserDay.get(k) ?? { breached: 0, warning: 0, at_risk: 0 }
    cur.breached = Math.max(cur.breached, Number(r.sla_breached) || 0)
    cur.warning = Math.max(cur.warning, Number(r.sla_warning) || 0)
    cur.at_risk = Math.max(cur.at_risk, Number(r.at_risk) || 0)
    perUserDay.set(k, cur)
  }
  const perDay = new Map<string, { breached: number; warning: number; at_risk: number }>()
  for (const [k, v] of perUserDay) {
    const d = k.split('|')[0]
    const cur = perDay.get(d) ?? { breached: 0, warning: 0, at_risk: 0 }
    cur.breached += v.breached
    cur.warning += v.warning
    cur.at_risk += v.at_risk
    perDay.set(d, cur)
  }
  const dates: string[] = []
  for (let i = 2 * days - 1; i >= 0; i--)
    dates.push(dayKey(new Date(today.getTime() - i * 86_400_000)))
  const all = dates.map((date) => ({ date, ...(perDay.get(date) ?? null) }))
  const window = all
    .slice(days)
    .filter((p) => 'breached' in p && p.breached !== undefined) as Array<{
    date: string
    breached: number
    warning: number
    at_risk: number
  }>
  const prev = all
    .slice(0, days)
    .filter((p) => 'breached' in p && p.breached !== undefined) as typeof window
  const avg = (list: typeof window, k: 'breached' | 'at_risk') =>
    list.length ? list.reduce((m, p) => m + p[k], 0) / list.length : 0
  const round = (n: number) => Math.round(n * 10) / 10
  const change = {
    breached:
      window.length && prev.length ? round(avg(window, 'breached') - avg(prev, 'breached')) : 0,
    at_risk: window.length && prev.length ? round(avg(window, 'at_risk') - avg(prev, 'at_risk')) : 0
  }
  // Newest day on which the breached count rose over the day before.
  const known = all.filter((p) => 'breached' in p && p.breached !== undefined) as typeof window
  let lastRise: string | null = null
  for (let i = known.length - 1; i > 0; i--) {
    if (known[i].breached > known[i - 1].breached) {
      lastRise = known[i].date
      break
    }
  }
  const days_since_new_breach =
    lastRise == null
      ? null
      : Math.round((Date.parse(dayKey(today)) - Date.parse(lastRise)) / 86_400_000)
  return { days, since: first, series: window, change, days_since_new_breach }
}

export async function buildTeamTrend(managerId: string, days = 30): Promise<TeamTrend> {
  const rows = await reportsOf(managerId)
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return trendFromSnapshots([], days)
  const since = new Date(Date.now() - 2 * days * 86_400_000)
  const snaps = (await selectInChunks(ids, 1500, (chunk) =>
    db('nivaro_queue_owner_snapshots')
      .whereIn('user', chunk)
      .where('snapshot_date', '>=', since)
      .select('snapshot_date', 'user', 'sla_breached', 'sla_warning', 'at_risk')
  ).catch(() => [])) as Parameters<typeof trendFromSnapshots>[0]
  const out = trendFromSnapshots(snaps, days)
  if (snaps.length > 0) {
    const first = (await selectInChunks(ids, 1500, (chunk) =>
      db('nivaro_queue_owner_snapshots').whereIn('user', chunk).min({ d: 'snapshot_date' })
    ).catch(() => [])) as Array<{ d: Date | null }>
    const earliest = first
      .map((f) => (f.d ? dayKey(f.d) : null))
      .filter(Boolean)
      .sort()[0]
    if (earliest) out.since = earliest
  }
  return out
}

// ── #1040 Wins ───────────────────────────────────────────────────────────────

export interface TeamWinPerson {
  id: string
  name: string
  completions: number
  pushes_accepted: number
  records: Array<{ collection: string; item_id: string; label: string }>
}

export async function buildTeamWins(
  managerId: string,
  viewer: Viewer,
  days = 7
): Promise<TeamWinPerson[]> {
  const rows = await reportsOf(managerId)
  const ids = rows.map((r) => r.id)
  const from = new Date(Date.now() - days * 86_400_000)
  const [hist, pushes] = await Promise.all([historyFor(ids, from), acceptedPushesFor(ids, from)])
  const byCollection = new Map<string, Set<string>>()
  for (const h of hist.values())
    for (const r of h.records.slice(0, 25)) {
      if (!byCollection.has(r.collection)) byCollection.set(r.collection, new Set())
      byCollection.get(r.collection)!.add(r.item_id)
    }
  const user = await viewerUser(viewer)
  const readable = viewer.isAdmin
    ? new Set([...byCollection].flatMap(([c, s]) => [...s].map((i) => `${c}:${i}`)))
    : await readableRecords(user, byCollection)
  const readableByCollection = new Map<string, Set<string>>()
  for (const key of readable) {
    const i = key.indexOf(':')
    const c = key.slice(0, i)
    if (!readableByCollection.has(c)) readableByCollection.set(c, new Set())
    readableByCollection.get(c)!.add(key.slice(i + 1))
  }
  const labels = await labelsFor(readableByCollection)
  const people = rows.map((r) => {
    const h = hist.get(r.id.toUpperCase())
    const seen = new Set<string>()
    const records: TeamWinPerson['records'] = []
    for (const rec of h?.records ?? []) {
      const key = `${rec.collection}:${rec.item_id}`
      if (seen.has(key) || !readable.has(key)) continue
      seen.add(key)
      records.push({
        collection: rec.collection,
        item_id: rec.item_id,
        label: labels[key] ?? rec.item_id
      })
      if (records.length >= 5) break
    }
    return {
      id: r.id,
      name: nameOf(r),
      completions: h?.completions ?? 0,
      pushes_accepted: pushes.get(r.id.toUpperCase()) ?? 0,
      records
    }
  })
  people.sort(
    (a, b) =>
      b.completions - a.completions ||
      b.pushes_accepted - a.pushes_accepted ||
      a.name.localeCompare(b.name)
  )
  return people
}

// ── #1039 1:1 prep ───────────────────────────────────────────────────────────

export interface OneOnOne {
  user: { id: string; name: string; title: string | null }
  since: string
  last_one_on_one: string | null
  oldest: Array<{
    collection: string
    item_id: string
    label: string
    state_label: string | null
    state_color: string | null
    sla_status: 'ok' | 'warning' | 'breached' | null
    aging_hours: number | null
  }>
  stuck: number
  open: number
  breached: number
  completions: number
  send_backs: number
  tasks_owed: Array<{ id: number; title: string; due_date: string | null; overdue: boolean }>
  tasks_requested: Array<{
    id: number
    title: string
    assignee: string | null
    due_date: string | null
  }>
  time_off: { ooo_start: string | null; ooo_end: string | null; out: boolean } | null
  access_changes: Array<{ at: string; text: string; by: string | null }>
  wins: { completions: number; pushes_accepted: number }
}

const parsePrefs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const ROLE_FIELDS: Record<string, string> = {
  role: 'Role',
  status: 'Account status',
  manager_id: 'Manager',
  delegate_id: 'Delegate'
}

async function accessChangesOf(userId: string, since: Date): Promise<OneOnOne['access_changes']> {
  const out: OneOnOne['access_changes'] = []
  const ids = [...new Set([userId, userId.toUpperCase(), userId.toLowerCase()])]
  const [userEdits, scopeEdits, requests] = await Promise.all([
    db('nivaro_activity as a')
      .leftJoin('nivaro_revisions as r', 'r.activity', 'a.id')
      .leftJoin('nivaro_users as by', 'by.id', 'a.user')
      .where('a.collection', 'nivaro_users')
      .whereIn('a.item', ids)
      .where('a.timestamp', '>=', since)
      .whereNot('a.action', 'delegate-remind')
      .orderBy('a.timestamp', 'desc')
      .limit(40)
      .select(
        'a.timestamp',
        'a.action',
        'a.comment',
        'r.delta',
        'by.first_name',
        'by.last_name',
        'by.email'
      )
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_activity as a')
      .leftJoin('nivaro_users as by', 'by.id', 'a.user')
      .where('a.collection', 'nivaro_user_scopes')
      .where((w) => {
        for (const id of ids) w.orWhere('a.item', 'like', `${id}:%`)
      })
      .where('a.timestamp', '>=', since)
      .orderBy('a.timestamp', 'desc')
      .limit(20)
      .select('a.timestamp', 'a.item', 'by.first_name', 'by.last_name', 'by.email')
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_access_requests')
      .whereIn('user', ids)
      .where((w) => w.where('created_at', '>=', since).orWhere('resolved_at', '>=', since))
      .orderBy('created_at', 'desc')
      .limit(10)
      .select('created_at', 'resolved_at', 'status', 'collection')
      .catch(() => []) as Promise<Array<Record<string, unknown>>>
  ])
  const by = (r: Record<string, unknown>) =>
    r.first_name || r.last_name || r.email
      ? nameOf({
          first_name: r.first_name as string,
          last_name: r.last_name as string,
          email: r.email as string
        })
      : null
  for (const r of userEdits) {
    let fields: string[] = []
    if (typeof r.delta === 'string') {
      try {
        const d = JSON.parse(r.delta) as Record<string, unknown>
        fields = Object.keys(d).filter((k) => k in ROLE_FIELDS)
      } catch {
        /* not JSON */
      }
    }
    const action = String(r.action ?? '')
    let text: string | null = null
    if (fields.length) text = `${fields.map((f) => ROLE_FIELDS[f]).join(', ')} changed`
    else if (action === 'directory-suspend') text = 'Suspended: no longer in the company directory'
    else if (action === 'user-offboard') text = 'Offboarded'
    else if (action === 'user-retention-suspend') text = 'Suspended for inactivity'
    else if (action === 'manager-access-flag')
      text = `Flagged to admins${r.comment ? `: ${String(r.comment)}` : ''}`
    if (!text) continue
    out.push({ at: iso(r.timestamp as Date) ?? '', text, by: by(r) })
  }
  for (const r of scopeEdits) {
    const dim = String(r.item ?? '').split(':')[1] ?? 'scope'
    out.push({ at: iso(r.timestamp as Date) ?? '', text: `${dim} limits changed`, by: by(r) })
  }
  for (const r of requests) {
    const status = String(r.status ?? 'pending')
    const what = r.collection ? `access to ${String(r.collection)}` : 'access'
    out.push({
      at: iso((r.resolved_at ?? r.created_at) as Date) ?? '',
      text: status === 'pending' ? `Asked for ${what}` : `Request for ${what} ${status}`,
      by: null
    })
  }
  out.sort((a, b) => b.at.localeCompare(a.at))
  return out.slice(0, 20)
}

export async function buildOneOnOne(
  managerId: string,
  viewer: Viewer,
  userId: string,
  since: Date
): Promise<OneOnOne | null> {
  const person = (await db('nivaro_users')
    .where('id', userId)
    .first(
      'id',
      'first_name',
      'last_name',
      'email',
      'title',
      'is_out_of_office',
      'ooo_start',
      'ooo_end'
    )
    .catch(() => undefined)) as
    | (Parameters<typeof nameOf>[0] & {
        id: string
        title?: string | null
        is_out_of_office?: boolean | number | null
        ooo_start?: Date | null
        ooo_end?: Date | null
      })
    | undefined
  if (!person) return null
  const { buildWorkingOn } = await import('./user-profile.js')
  const stuckHours = await teamStuckHours()
  const [load, hist, pushes, owed, requested, changes, manager] = await Promise.all([
    buildWorkingOn(userId, viewer as never, Number.MAX_SAFE_INTEGER).catch(() => null),
    historyFor([userId], since),
    acceptedPushesFor([userId], since),
    db('nivaro_tasks')
      .where('assignee', userId)
      .whereIn('status', ACTIVE_TASKS)
      .where((w) => w.whereNull('kind').orWhereNot('kind', 'support'))
      .orderBy('due_date', 'asc')
      .limit(20)
      .select('id', 'title', 'due_date')
      .catch(() => []) as Promise<Array<{ id: number; title: string; due_date: Date | null }>>,
    db('nivaro_tasks as t')
      .leftJoin('nivaro_users as a', 'a.id', 't.assignee')
      .where('t.created_by', userId)
      .whereIn('t.status', ACTIVE_TASKS)
      .where((w) => w.whereNull('t.assignee').orWhereNot('t.assignee', userId))
      .where((w) => w.whereNull('t.kind').orWhereNot('t.kind', 'support'))
      .orderBy('t.due_date', 'asc')
      .limit(20)
      .select('t.id', 't.title', 't.due_date', 'a.first_name', 'a.last_name', 'a.email')
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    accessChangesOf(userId, since),
    db('nivaro_users')
      .where('id', managerId)
      .first('preferences')
      .catch(() => undefined) as Promise<{ preferences?: unknown } | undefined>
  ])
  const items = load?.items ?? []
  const byAge = items
    .filter((x) => x.aging_hours != null)
    .sort((a, b) => (b.aging_hours ?? 0) - (a.aging_hours ?? 0))
  const today = startOfToday().getTime()
  const h = hist.get(userId.toUpperCase())
  const now = Date.now()
  const out =
    !!person.is_out_of_office ||
    (!!person.ooo_start &&
      new Date(person.ooo_start).getTime() <= now &&
      (!person.ooo_end || new Date(person.ooo_end).getTime() >= now))
  const ahead = !!person.ooo_start && new Date(person.ooo_start).getTime() > now
  const oneOnOnes = parsePrefs(manager?.preferences).one_on_one as
    | Record<string, unknown>
    | undefined
  const last = oneOnOnes ? Object.entries(oneOnOnes).find(([k]) => same(k, userId))?.[1] : undefined
  return {
    user: { id: person.id, name: nameOf(person), title: person.title ?? null },
    since: since.toISOString(),
    last_one_on_one: typeof last === 'string' ? last : null,
    oldest: byAge.slice(0, 5).map((x) => ({
      collection: x.collection,
      item_id: x.item_id,
      label: x.label,
      state_label: x.state_label,
      state_color: x.state_color,
      sla_status: x.sla_status,
      aging_hours: x.aging_hours
    })),
    stuck: byAge.filter((x) => (x.aging_hours ?? 0) >= stuckHours).length,
    open: load?.total ?? 0,
    breached: items.filter((x) => x.sla_status === 'breached').length,
    completions: h?.completions ?? 0,
    send_backs: h?.send_backs ?? 0,
    tasks_owed: owed.map((t) => ({
      id: Number(t.id),
      title: String(t.title ?? ''),
      due_date: iso(t.due_date),
      overdue: !!t.due_date && new Date(t.due_date).getTime() < today
    })),
    tasks_requested: requested.map((t) => ({
      id: Number(t.id),
      title: String(t.title ?? ''),
      assignee:
        t.first_name || t.last_name || t.email
          ? nameOf({
              first_name: t.first_name as string,
              last_name: t.last_name as string,
              email: t.email as string
            })
          : null,
      due_date: iso(t.due_date as Date | null)
    })),
    time_off:
      out || ahead ? { ooo_start: iso(person.ooo_start), ooo_end: iso(person.ooo_end), out } : null,
    access_changes: changes,
    wins: {
      completions: h?.completions ?? 0,
      pushes_accepted: pushes.get(userId.toUpperCase()) ?? 0
    }
  }
}

/** A short plain-text brief of a 1:1 payload, from nothing but that payload. */
export async function summarizeOneOnOne(data: OneOnOne): Promise<string | null> {
  const { getAiClient, getAiModelSettings } = await import('./ai-client.js')
  const client = await getAiClient()
  if (!client) return null
  const { summarizeModel } = await getAiModelSettings()
  const message = await client.messages.create({
    model: summarizeModel,
    max_tokens: 400,
    system:
      'You help a manager prepare a one-to-one with a direct report. From the JSON provided and nothing else, write 4-6 short plain-text bullet lines (start each with "- "): what is going well, what looks stuck or late and why it matters, time off or access to raise, and one or two questions worth asking. Name records by their label. No markdown headers, no invented facts.',
    messages: [{ role: 'user', content: JSON.stringify(data).slice(0, 14000) }]
  })
  const text = message.content[0]?.type === 'text' ? message.content[0].text.trim() : ''
  return text || null
}

// ── #1041 New starters ───────────────────────────────────────────────────────

export interface Onboarding {
  id: string
  name: string
  created_at: string | null
  role_name: string | null
  awaiting_role: boolean
  first_sign_in: string | null
  last_sign_in: string | null
  first_request_at: string | null
  first_approval_at: string | null
  steps: {
    scope_defaults: boolean
    notification_rules: boolean
    timezone: boolean
    watching: boolean
    delegate: boolean
  }
  pending_requests: Array<{
    id: number
    collection: string | null
    item: string | null
    note: string | null
    created_at: string
  }>
}

async function awaitingRoles(): Promise<Set<string>> {
  const out = new Set<string>()
  for (const col of ['new_user_role', 'access_request_role']) {
    if (!(await hasColumn('nivaro_settings', col))) continue
    const row = (await db('nivaro_settings')
      .where('id', 1)
      .first(col)
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (row?.[col]) out.add(String(row[col]).toUpperCase())
  }
  return out
}

export async function buildOnboarding(people: ReportRow[]): Promise<Onboarding[]> {
  if (people.length === 0) return []
  const ids = people.map((p) => p.id)
  const { onboardingState } = await import('./dashboard-feed.js')
  const [awaiting, roles, logins, firstRequests, firstApprovals, requests, states] =
    await Promise.all([
      awaitingRoles(),
      db('nivaro_roles')
        .select('id', 'name')
        .catch(() => []) as Promise<Array<{ id: string; name: string }>>,
      selectInChunks(ids, 1500, (chunk) =>
        db('nivaro_login_events')
          .whereIn('user', chunk)
          .groupBy('user')
          .select('user')
          .min({ first: 'created_at' })
          .max({ last: 'created_at' })
      ).catch(() => []) as Promise<Array<{ user: string; first: Date; last: Date }>>,
      selectInChunks(ids, 1500, async (chunk) => {
        const bound = (await db('nivaro_workflow_bindings')
          .distinct('collection')
          .catch(() => [])) as Array<{
          collection: string
        }>
        const cols = bound.map((b) => String(b.collection))
        if (cols.length === 0) return []
        return db('nivaro_activity')
          .whereIn('user', chunk)
          .where('action', 'create')
          .whereIn('collection', cols)
          .groupBy('user')
          .select('user')
          .min({ at: 'timestamp' })
      }).catch(() => []) as Promise<Array<{ user: string; at: Date }>>,
      selectInChunks(ids, 1500, (chunk) =>
        db('nivaro_workflow_history')
          .whereIn('user', chunk)
          .groupBy('user')
          .select('user')
          .min({ at: 'timestamp' })
      ).catch(() => []) as Promise<Array<{ user: string; at: Date }>>,
      selectInChunks(ids, 1500, (chunk) =>
        db('nivaro_access_requests')
          .whereIn('user', chunk)
          .where('status', 'pending')
          .orderBy('created_at', 'desc')
          .select('id', 'user', 'collection', 'item', 'note', 'created_at')
      ).catch(() => []) as Promise<Array<Record<string, unknown>>>,
      Promise.all(
        people.map((p) =>
          onboardingState({ user: { id: p.id } as unknown as User }).catch(() => null)
        )
      )
    ])
  const roleName = new Map(roles.map((r) => [String(r.id).toUpperCase(), r.name]))
  const keyed = <T extends { user: string }>(rows: T[]) =>
    new Map(rows.map((r) => [String(r.user).toUpperCase(), r]))
  const loginBy = keyed(logins)
  const reqBy = keyed(firstRequests)
  const apprBy = keyed(firstApprovals)
  return people.map((p, i) => {
    const k = p.id.toUpperCase()
    const st = states[i]
    return {
      id: p.id,
      name: nameOf(p),
      created_at: iso(p.created_at),
      role_name: p.role ? (roleName.get(String(p.role).toUpperCase()) ?? null) : null,
      awaiting_role: !p.role || awaiting.has(String(p.role).toUpperCase()),
      first_sign_in: iso(loginBy.get(k)?.first),
      last_sign_in: iso(loginBy.get(k)?.last) ?? iso(p.last_access),
      first_request_at: iso(reqBy.get(k)?.at),
      first_approval_at: iso(apprBy.get(k)?.at),
      steps: st?.steps ?? {
        scope_defaults: false,
        notification_rules: false,
        timezone: false,
        watching: false,
        delegate: false
      },
      pending_requests: requests
        .filter((r) => same(r.user, p.id))
        .map((r) => ({
          id: Number(r.id),
          collection: (r.collection as string | null) ?? null,
          item: (r.item as string | null) ?? null,
          note: (r.note as string | null) ?? null,
          created_at: iso(r.created_at as Date) ?? ''
        }))
    }
  })
}

export async function buildTeamOnboarding(managerId: string, days = 60): Promise<Onboarding[]> {
  const cutoff = Date.now() - days * 86_400_000
  const awaiting = await awaitingRoles()
  const rows = (await reportsOf(managerId)).filter(
    (r) =>
      (r.created_at && new Date(r.created_at).getTime() >= cutoff) ||
      (!!r.role && awaiting.has(String(r.role).toUpperCase()))
  )
  const out = await buildOnboarding(rows)
  return out.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
}

/** Admins to tell about a manager's vouch or flag (the access-request audience). */
async function adminIds(): Promise<string[]> {
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where((w) => w.where('u.status', 'active').orWhereNull('u.status'))
    .whereNull('u.account_kind')
    .limit(10)
    .select('u.id')
    .catch(() => [])) as Array<{ id: string }>
  return rows.map((r) => String(r.id))
}

/** A manager vouches for a report's pending access request (#1041): tells admins, grants nothing. */
export async function vouchForRequest(
  app: FastifyInstance,
  manager: Viewer,
  requestId: number,
  note: string | null
): Promise<void> {
  const req = (await db('nivaro_access_requests')
    .where('id', requestId)
    .first()
    .catch(() => undefined)) as
    | { id: number; user: string; status: string; collection?: string | null; item?: string | null }
    | undefined
  if (!req) throw new TeamError(404, 'Access request not found')
  if (!manager.isAdmin && !(await isManagerOf(manager.id, req.user))) {
    throw new TeamError(403, 'Only their manager can vouch for this request')
  }
  if (req.status !== 'pending') throw new TeamError(409, 'This request is no longer pending')
  const [m, p] = (await Promise.all([
    db('nivaro_users').where('id', manager.id).first('id', 'first_name', 'last_name', 'email'),
    db('nivaro_users').where('id', req.user).first('id', 'first_name', 'last_name', 'email')
  ])) as [Parameters<typeof nameOf>[0], Parameters<typeof nameOf>[0]]
  const who = nameOf(m ?? { id: manager.id })
  const whom = nameOf(p ?? { id: req.user })
  const what = req.collection
    ? `access to ${req.collection}${req.item ? ` #${req.item}` : ''}`
    : 'access'
  const clean = note?.trim().slice(0, 500) || null
  await logActivity({
    action: 'access-request-vouch',
    collection: 'nivaro_access_requests',
    item: String(req.id),
    user: manager.id,
    comment: clean ? `${who} vouched: ${clean}` : `${who} vouched`
  })
  const { notifyUser } = await import('./notification-channels.js')
  for (const admin of await adminIds()) {
    await notifyUser(app, admin, {
      subject: `${who} vouched for ${whom}'s access request`,
      message: `${whom} asked for ${what}. Their manager, ${who}, vouched for it${clean ? `: “${clean}”` : '.'}`,
      category: 'system',
      sender: manager.id,
      why: 'You are an administrator and this request is waiting for a decision.',
      source: { kind: 'manager', label: 'Manager vouch' },
      target: { kind: 'access_request', action: 'review' }
    }).catch(() => undefined)
  }
}

// ── #1042 Access check ───────────────────────────────────────────────────────

export interface AccessCheck {
  id: string
  name: string
  role_name: string | null
  status: string
  scopes: Array<{ dimension: string; label: string; values: string[] }>
  directory_status: 'active' | 'disabled' | 'missing' | null
  last_sign_in: string | null
  stale_sign_in: boolean
  has_token: boolean
  pending_requests: number
  delegation_expired: boolean
}

const STALE_SIGN_IN_MS = 45 * 86_400_000

export async function buildTeamAccess(managerId: string): Promise<AccessCheck[]> {
  const rows = await reportsOf(managerId)
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return []
  const dirCol = await hasColumn('nivaro_users', 'directory_status')
  const { listScopeDimensions, resolveScopeLabelsForUsers } = await import('./user-scopes.js')
  const dims = await listScopeDimensions().catch(() => [])
  const [extra, roles, logins, pending, labels] = await Promise.all([
    selectInChunks(ids, 1500, (chunk) =>
      db('nivaro_users')
        .whereIn('id', chunk)
        .select('id', 'static_token', ...(dirCol ? ['directory_status'] : []))
    ).catch(() => []) as Promise<
      Array<{ id: string; static_token?: string | null; directory_status?: string | null }>
    >,
    db('nivaro_roles')
      .select('id', 'name')
      .catch(() => []) as Promise<Array<{ id: string; name: string }>>,
    selectInChunks(ids, 1500, (chunk) =>
      db('nivaro_login_events')
        .whereIn('user', chunk)
        .groupBy('user')
        .select('user')
        .max({ last: 'created_at' })
    ).catch(() => []) as Promise<Array<{ user: string; last: Date }>>,
    selectInChunks(ids, 1500, (chunk) =>
      db('nivaro_access_requests')
        .whereIn('user', chunk)
        .where('status', 'pending')
        .groupBy('user')
        .select('user')
        .count({ n: '*' })
    ).catch(() => []) as Promise<Array<{ user: string; n: number | string }>>,
    resolveScopeLabelsForUsers(
      ids,
      (dims as Array<{ name: string }>).map((d) => d.name)
    ).catch(() => new Map<string, Map<string, string[]>>())
  ])
  const byId = <T extends { id?: string; user?: string }>(list: T[], key: 'id' | 'user') =>
    new Map(list.map((r) => [String(r[key]).toUpperCase(), r]))
  const extraBy = byId(extra, 'id')
  const loginBy = byId(logins, 'user')
  const pendingBy = byId(pending, 'user')
  const roleName = new Map(roles.map((r) => [String(r.id).toUpperCase(), r.name]))
  const labelBy = new Map([...labels].map(([k, v]) => [String(k).toUpperCase(), v]))
  const dimLabel = new Map(
    (dims as Array<{ name: string; label?: string | null }>).map((d) => [d.name, d.label || d.name])
  )
  const now = Date.now()
  return rows.map((r) => {
    const k = r.id.toUpperCase()
    const e = extraBy.get(k)
    const last = iso(loginBy.get(k)?.last) ?? iso(r.last_access)
    const created = r.created_at ? new Date(r.created_at).getTime() : 0
    const scopes = [...(labelBy.get(k) ?? new Map<string, string[]>())].map(
      ([dimension, values]) => ({
        dimension,
        label: dimLabel.get(dimension) ?? dimension,
        values
      })
    )
    const status = e?.directory_status
    return {
      id: r.id,
      name: nameOf(r),
      role_name: r.role ? (roleName.get(String(r.role).toUpperCase()) ?? null) : null,
      status: r.status ?? 'active',
      scopes,
      directory_status:
        status === 'active' || status === 'disabled' || status === 'missing' ? status : null,
      last_sign_in: last,
      // Never signed in counts as stale only once the account is old enough.
      stale_sign_in: last
        ? now - new Date(last).getTime() > STALE_SIGN_IN_MS
        : created > 0 && now - created > STALE_SIGN_IN_MS,
      has_token: !!e?.static_token,
      pending_requests: Number(pendingBy.get(k)?.n ?? 0) || 0,
      delegation_expired:
        !!r.delegate_id &&
        !!r.delegate_expires_at &&
        new Date(r.delegate_expires_at).getTime() < now
    }
  })
}

/** A manager flags a report's access to the admins (#1042). Admins act; nothing is changed here. */
export async function flagAccess(
  app: FastifyInstance,
  manager: Viewer,
  userId: string,
  kind: 'scope' | 'departure',
  note: string
): Promise<void> {
  if (!manager.isAdmin && !(await isManagerOf(manager.id, userId))) {
    throw new TeamError(403, 'Only their manager can flag this person')
  }
  const clean = note.trim().slice(0, 1000)
  if (!clean) throw new TeamError(400, 'Say what should change')
  const [m, p] = (await Promise.all([
    db('nivaro_users').where('id', manager.id).first('id', 'first_name', 'last_name', 'email'),
    db('nivaro_users').where('id', userId).first('id', 'first_name', 'last_name', 'email')
  ])) as [Parameters<typeof nameOf>[0], Parameters<typeof nameOf>[0]]
  if (!p) throw new TeamError(404, 'Not found')
  const who = nameOf(m ?? { id: manager.id })
  const whom = nameOf(p)
  const subject =
    kind === 'departure'
      ? `${who} reports that ${whom} has left`
      : `${who} asks for a change to ${whom}'s access`
  await logActivity({
    action: 'manager-access-flag',
    collection: 'nivaro_users',
    item: userId,
    user: manager.id,
    comment: `${kind === 'departure' ? 'Departure' : 'Scope change'}: ${clean}`
  })
  const { notifyUser } = await import('./notification-channels.js')
  for (const admin of await adminIds()) {
    await notifyUser(app, admin, {
      subject,
      message: clean,
      category: 'system',
      sender: manager.id,
      why: `You are an administrator; ${who} is ${whom}'s manager.`,
      source: { kind: 'manager', label: 'Manager access flag' },
      target: {
        kind: 'external',
        url: `${(adminBaseUrl() ?? '').replace(/\/$/, '')}/users/${userId}?tab=access`,
        action: 'review'
      }
    }).catch(() => undefined)
  }
}

// ── #1037 Team alerts ────────────────────────────────────────────────────────

export interface TeamAlertRules {
  breached_max?: number | null
  uncovered?: boolean
  stuck_hours?: number | null
  silent_days?: number | null
}

/** Validate a `team_alerts` preference: numbers are whole and in range; null clears. */
export function normalizeTeamAlerts(
  raw: unknown
): { value: TeamAlertRules | null } | { error: string } {
  if (raw == null) return { value: null }
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'team_alerts must be an object or null' }
  const r = raw as Record<string, unknown>
  const out: TeamAlertRules = {}
  const num = (k: keyof TeamAlertRules, min: number, max: number) => {
    const v = r[k]
    if (v == null || v === '') return
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`team_alerts.${k} must be a whole number from ${min} to ${max}`)
    ;(out as Record<string, unknown>)[k] = n
  }
  try {
    num('breached_max', 0, 1000)
    num('stuck_hours', 1, 24 * 365)
    num('silent_days', 1, 365)
  } catch (e) {
    return { error: (e as Error).message }
  }
  if (r.uncovered === true) out.uncovered = true
  return { value: Object.keys(out).length ? out : null }
}

export interface TeamAlert {
  report: { id: string; name: string }
  rule: 'breached' | 'uncovered' | 'stuck' | 'silent'
  message: string
}

type LoadReport = Awaited<
  ReturnType<typeof import('./user-profile.js').buildTeamLoad>
>['reports'][number]

/** Which rules a team crosses right now — pure, for the hourly check and its test. */
export function evaluateTeamAlerts(
  rules: TeamAlertRules,
  reports: Array<LoadReport & { last_active?: string | null }>,
  now = Date.now()
): TeamAlert[] {
  const out: TeamAlert[] = []
  for (const r of reports) {
    const person = { id: r.id, name: r.name }
    if (rules.breached_max != null && r.breached > rules.breached_max) {
      out.push({
        report: person,
        rule: 'breached',
        message: `${r.name} has ${r.breached} record${r.breached === 1 ? '' : 's'} past SLA (your line is ${rules.breached_max}).`
      })
    }
    if (rules.uncovered && r.uncovered) {
      out.push({
        report: person,
        rule: 'uncovered',
        message: `${r.name} is out with ${r.open} open record${r.open === 1 ? '' : 's'} and nobody covering.`
      })
    }
    if (rules.stuck_hours != null) {
      const stuck = r.oldest.filter(
        (x) => (x.aging_hours ?? 0) >= (rules.stuck_hours as number)
      ).length
      if (stuck > 0 && r.oldest_hours != null && r.oldest_hours >= rules.stuck_hours) {
        const days = Math.floor((r.oldest_hours ?? 0) / 24)
        out.push({
          report: person,
          rule: 'stuck',
          message: `${r.name} has a record that has not moved in ${days} day${days === 1 ? '' : 's'}.`
        })
      }
    }
    if (rules.silent_days != null && !r.out && r.last_active) {
      const quiet = (now - new Date(r.last_active).getTime()) / 86_400_000
      if (quiet >= rules.silent_days) {
        const d = Math.floor(quiet)
        out.push({
          report: person,
          rule: 'silent',
          message: `${r.name} has not been active in the portal for ${d} day${d === 1 ? '' : 's'}.`
        })
      }
    }
  }
  return out
}

const ALERT_WINDOW_MS = 20 * 60 * 60_000

/** The hourly check: every manager with team alerts set, once a day per report and rule. */
export async function runTeamAlerts(app: FastifyInstance, opts: { dryRun?: boolean } = {}) {
  const managers = (await db('nivaro_users')
    .where('preferences', 'like', '%team_alerts%')
    .where((w) => w.where('status', 'active').orWhereNull('status'))
    .select('id', 'role', 'preferences')
    .catch(() => [])) as Array<{ id: string; role: string | null; preferences: string | null }>
  const { buildTeamLoad } = await import('./user-profile.js')
  let sent = 0
  const would: TeamAlert[] = []
  for (const m of managers) {
    const parsed = normalizeTeamAlerts(parsePrefs(m.preferences).team_alerts)
    if ('error' in parsed || !parsed.value) continue
    const role = m.role
      ? ((await db('nivaro_roles')
          .where('id', m.role)
          .first('admin_access')
          .catch(() => undefined)) as { admin_access?: boolean | number } | undefined)
      : undefined
    const viewer = { ...m, isAdmin: !!role?.admin_access } as Viewer
    const load = await buildTeamLoad(m.id, viewer).catch(() => null)
    if (!load || load.reports.length === 0) continue
    const lastActive = new Map(
      (
        (await selectInChunks(
          load.reports.map((r) => r.id),
          1500,
          (chunk) => db('nivaro_users').whereIn('id', chunk).select('id', 'last_access')
        ).catch(() => [])) as Array<{ id: string; last_access: Date | null }>
      ).map((u) => [String(u.id).toUpperCase(), iso(u.last_access)])
    )
    const alerts = evaluateTeamAlerts(
      parsed.value,
      load.reports.map((r) => ({ ...r, last_active: lastActive.get(r.id.toUpperCase()) ?? null }))
    )
    if (alerts.length === 0) continue
    const recent = (await db('nivaro_activity')
      .where('action', 'team-alert')
      .where('user', m.id)
      .where('timestamp', '>=', new Date(Date.now() - ALERT_WINDOW_MS))
      .select('item', 'comment')
      .catch(() => [])) as Array<{ item: string; comment: string | null }>
    const done = new Set(recent.map((r) => `${String(r.item).toUpperCase()}|${r.comment}`))
    const { notifyUser } = await import('./notification-channels.js')
    for (const a of alerts) {
      if (done.has(`${a.report.id.toUpperCase()}|${a.rule}`)) continue
      if (opts.dryRun) {
        would.push(a)
        continue
      }
      await notifyUser(app, m.id, {
        subject: a.message,
        message: `${a.message} You set this alert on your dashboard's team widget.`,
        category: 'workflow',
        why: 'You asked to be told when your team crosses this line.',
        source: { kind: 'team-alert', label: 'Team alert' },
        target: { kind: 'home', focus: 'team-today', action: 'open' }
      }).catch(() => undefined)
      await logActivity({
        action: 'team-alert',
        collection: 'nivaro_users',
        item: a.report.id,
        user: m.id,
        comment: a.rule
      })
      sent++
    }
  }
  return opts.dryRun
    ? { managers: managers.length, would_send: would }
    : { managers: managers.length, sent }
}

// ── #1034 Monday digest section ──────────────────────────────────────────────

export function registerTeamDigest(): void {
  void import('./daily-digest.js').then(({ registerDigestSection }) =>
    registerDigestSection(async (userId) => {
      if (new Date().getDay() !== 1) return null
      if (!(await hasReports(userId))) return null
      const row = (await db('nivaro_users as u')
        .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
        .where('u.id', userId)
        .first('u.id', 'u.role', 'r.admin_access')
        .catch(() => undefined)) as
        | { id: string; role: string | null; admin_access?: boolean | number }
        | undefined
      if (!row) return null
      const week = await buildTeamWeek(userId, {
        id: userId,
        isAdmin: !!row.admin_access,
        role: row.role
      })
      const lines: Array<{ text: string; sub?: string }> = [
        {
          text: `${week.completions} finished · ${week.send_backs} sent back · ${week.new_breaches} newly past SLA`,
          sub: 'Across your direct reports, the last seven days'
        }
      ]
      for (const r of week.per_report
        .filter((p) => p.completions || p.send_backs || p.new_breaches)
        .slice(0, 8)) {
        lines.push({
          text: `${r.name}: ${r.completions} finished, ${r.new_breaches} newly past SLA`
        })
      }
      if (week.out.length)
        lines.push({ text: `Out this week: ${week.out.map((o) => o.name).join(', ')}` })
      for (const g of week.gaps_ahead) {
        const when = new Date(g.ooo_start).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric'
        })
        lines.push({
          text: `${g.name} is out from ${when} with no delegate`,
          sub: `${g.open} open records`
        })
      }
      return { title: 'Your team this week', lines }
    })
  )
}

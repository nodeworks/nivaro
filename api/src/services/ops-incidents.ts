import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'

/**
 * Incident threads (#2016). When an administrator turns incident mode on, or
 * a critical alert fires, the assistant opens a thread in the ops channel
 * (nivaro_settings.ops_channel — an admin-only channel) and keeps posting
 * under it as things change: new errors, recoveries, actions approved from
 * proposal cards. Turning incident mode off (or, for an alert thread, half an
 * hour of quiet) closes the thread with a summary.
 *
 * Every post re-checks that the room is still admin-only; if it is not, the
 * thread goes quiet rather than tell a non-admin about the incident. Posts
 * carry counts, issue titles and method + path patterns — no record values.
 * One row per thread in nivaro_ops_incidents (migration 442).
 */

export interface IncidentRow {
  id: number
  kind: 'incident' | 'alert'
  title: string
  status: 'open' | 'closed'
  source_key: string | null
  room: string | null
  root_message_id: number | null
  started_by: string | null
  started_at: Date | string
  ended_by: string | null
  ended_at: Date | string | null
  last_update_at: Date | string | null
  state: string | null
  summary: string | null
}

export interface IncidentState {
  /** Server errors in the 5 minutes before the last check. */
  last_e5: number
  peak_e5: number
  /** Issue ids already reported in this thread. */
  issue_ids: number[]
  issue_titles: string[]
  actions: string[]
  /** When the thread last saw something new (alert threads close after quiet). */
  last_signal_at: string
}

const ALERT_QUIET_MS = 30 * 60_000

export function parseState(raw: string | null | undefined): IncidentState {
  const base: IncidentState = {
    last_e5: 0,
    peak_e5: 0,
    issue_ids: [],
    issue_titles: [],
    actions: [],
    last_signal_at: new Date().toISOString()
  }
  if (!raw) return base
  try {
    return { ...base, ...(JSON.parse(raw) as Partial<IncidentState>) }
  } catch {
    return base
  }
}

async function tableReady(): Promise<boolean> {
  return hasColumn('nivaro_ops_incidents', 'root_message_id')
}

// ── Posting ─────────────────────────────────────────────────────────────────

/**
 * Post as the assistant through the one send path. The bot user when the
 * instance has a bot name, otherwise a platform line. Returns the message id.
 */
export async function postAsAssistant(
  app: FastifyInstance,
  room: string,
  text: string,
  parentId?: number | null
): Promise<number | null> {
  try {
    const { botUserId, chatBotName } = await import('./chat-bot.js')
    const { postChatMessage } = await import('./chat-send.js')
    const name = await chatBotName()
    const actor = name
      ? { user: null, senderId: await botUserId(), senderName: name, skipVisibility: true }
      : { user: null, senderId: null, senderName: 'Ops', system: true, skipVisibility: true }
    const row = await postChatMessage(app, actor, {
      room,
      message: text.slice(0, 4000),
      ...(parentId ? { parentId } : {})
    })
    return row.id
  } catch (err) {
    app.log.warn({ err, room }, 'ops assistant post failed')
    return null
  }
}

// ── The ops channel ─────────────────────────────────────────────────────────

export async function opsChannel(): Promise<string | null> {
  if (!(await hasColumn('nivaro_settings', 'ops_channel'))) return null
  const row = (await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first('ops_channel')
    .catch(() => undefined)) as { ops_channel?: string | null } | undefined
  return row?.ops_channel || null
}

export async function setOpsChannel(room: string | null): Promise<void> {
  if (!(await hasColumn('nivaro_settings', 'ops_channel')))
    throw Object.assign(new Error('The ops channel needs migration 442 on this database'), {
      statusCode: 409
    })
  if (room) {
    const { opsRoomVerdict } = await import('./ops-assistant.js')
    const v = await opsRoomVerdict(room)
    if (!v.ok)
      throw Object.assign(new Error(`That room cannot be the ops channel: ${v.reason}`), {
        statusCode: 400
      })
  }
  const row = await db('nivaro_settings').orderBy('id', 'asc').first('id')
  if (!row) throw new Error('No settings row')
  await db('nivaro_settings').where({ id: row.id }).update({ ops_channel: room })
}

/** The ops channel, only while it is still admin-only. */
async function postableChannel(app: FastifyInstance): Promise<string | null> {
  const room = await opsChannel()
  if (!room) return null
  const { opsRoomVerdict } = await import('./ops-assistant.js')
  const v = await opsRoomVerdict(room)
  if (!v.ok) {
    app.log.warn(
      { room, reason: v.reason },
      'ops channel is not admin-only — incident thread skipped'
    )
    return null
  }
  return room
}

/** Post a reply under an open thread (re-checking the room). */
async function postInThread(
  app: FastifyInstance,
  row: IncidentRow,
  text: string
): Promise<boolean> {
  if (!row.room) return false
  const { opsRoomVerdict } = await import('./ops-assistant.js')
  if (!(await opsRoomVerdict(row.room)).ok) return false
  const id = await postAsAssistant(app, row.room, text, row.root_message_id)
  return id != null
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function currentIncident(): Promise<IncidentRow | null> {
  if (!(await tableReady())) return null
  return ((await db('nivaro_ops_incidents')
    .where({ kind: 'incident', status: 'open' })
    .orderBy('id', 'desc')
    .first()
    .catch(() => null)) ?? null) as IncidentRow | null
}

export async function openThreads(): Promise<IncidentRow[]> {
  if (!(await tableReady())) return []
  return (await db('nivaro_ops_incidents')
    .where({ status: 'open' })
    .orderBy('id', 'asc')
    .catch(() => [])) as IncidentRow[]
}

export async function recentIncidents(limit = 10): Promise<IncidentRow[]> {
  if (!(await tableReady())) return []
  return (await db('nivaro_ops_incidents')
    .orderBy('id', 'desc')
    .limit(limit)
    .catch(() => [])) as IncidentRow[]
}

// ── Snapshot ────────────────────────────────────────────────────────────────

async function serverErrorsLast5(): Promise<number> {
  const { instanceScope } = await import('./api-log-instances.js')
  const sc = await instanceScope({})
  const row = (await sc
    .apply(db('nivaro_api_logs as l'), 'l.instance')
    .where('l.created_at', '>=', new Date(Date.now() - 5 * 60_000))
    .where('l.status', '>=', 500)
    .count('* as c')
    .first()
    .catch(() => undefined)) as { c?: number | string } | undefined
  return Number(row?.c ?? 0)
}

async function issuesSince(
  since: Date
): Promise<Array<{ id: number; title: string; severity: string }>> {
  const { scrubText } = await import('./ai-explain.js')
  const rows = (await db('nivaro_issues')
    .whereIn('status', ['open', 'acknowledged'])
    .where('last_seen_at', '>=', since)
    .orderBy('last_seen_at', 'desc')
    .limit(20)
    .select('id', 'title', 'severity')
    .catch(() => [])) as Array<{ id: number; title: string; severity: string }>
  return rows.map((r) => ({
    id: Number(r.id),
    title: scrubText(String(r.title)).slice(0, 140),
    severity: String(r.severity)
  }))
}

/**
 * What changed since the last update, as plain lines. Pure over the two
 * snapshots; exported for tests.
 */
export function describeChange(
  prev: IncidentState,
  now: { e5: number; issues: Array<{ id: number; title: string; severity: string }> }
): { lines: string[]; next: IncidentState; signal: boolean } {
  const lines: string[] = []
  const seen = new Set(prev.issue_ids)
  const fresh = now.issues.filter((i) => !seen.has(i.id))
  if (fresh.length) {
    lines.push(
      `${fresh.length} new issue${fresh.length === 1 ? '' : 's'}: ${fresh
        .slice(0, 3)
        .map((i) => `${i.title} (${i.severity})`)
        .join('; ')}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''}`
    )
  }
  if (now.e5 > 0 && prev.last_e5 === 0)
    lines.push(`Server errors started: ${now.e5} in the last 5 min.`)
  else if (now.e5 === 0 && prev.last_e5 > 0)
    lines.push('Recovering: no server errors in the last 5 min.')
  else if (now.e5 >= Math.max(10, prev.last_e5 * 2))
    lines.push(`Server errors rising: ${now.e5} in the last 5 min (was ${prev.last_e5}).`)
  else if (prev.last_e5 >= 10 && now.e5 <= prev.last_e5 / 2)
    lines.push(`Server errors falling: ${now.e5} in the last 5 min (was ${prev.last_e5}).`)
  const signal = fresh.length > 0 || now.e5 > 0
  return {
    lines,
    signal,
    next: {
      ...prev,
      last_e5: now.e5,
      peak_e5: Math.max(prev.peak_e5, now.e5),
      issue_ids: [...prev.issue_ids, ...fresh.map((i) => i.id)].slice(-200),
      issue_titles: [...prev.issue_titles, ...fresh.map((i) => i.title)].slice(-50),
      last_signal_at: signal ? new Date().toISOString() : prev.last_signal_at
    }
  }
}

export function closingSummary(
  row: Pick<IncidentRow, 'kind' | 'title' | 'started_at'>,
  state: IncidentState,
  endedBy: string | null,
  now = Date.now()
): string {
  const mins = Math.max(1, Math.round((now - new Date(row.started_at).getTime()) / 60_000))
  const dur = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`
  const parts = [
    `${row.kind === 'incident' ? 'Incident' : 'Alert'} closed after ${dur}${endedBy ? ` by ${endedBy}` : ''}: ${row.title}.`,
    `Peak: ${state.peak_e5} server error${state.peak_e5 === 1 ? '' : 's'} in 5 minutes.`,
    state.issue_titles.length
      ? `Issues seen (${state.issue_ids.length}): ${state.issue_titles.slice(0, 5).join('; ')}${state.issue_titles.length > 5 ? '…' : ''}.`
      : 'No new issues were raised.',
    state.actions.length
      ? `Actions: ${state.actions.join(' ')}`
      : 'No actions were taken from the channel.'
  ]
  return parts.join('\n')
}

// ── Open / close ────────────────────────────────────────────────────────────

async function insertThread(
  app: FastifyInstance,
  t: { kind: 'incident' | 'alert'; title: string; source_key: string | null; by: string | null },
  opening: string
): Promise<IncidentRow | null> {
  const room = await postableChannel(app)
  const root = room ? await postAsAssistant(app, room, opening) : null
  const state: IncidentState = {
    ...parseState(null),
    last_e5: await serverErrorsLast5().catch(() => 0)
  }
  // The issue that opened an alert thread is not news in its own thread.
  const seed = /^issue:(\d+)$/.exec(t.source_key ?? '')
  if (seed) {
    state.issue_ids = [Number(seed[1])]
    state.issue_titles = [t.title]
  }
  state.peak_e5 = state.last_e5
  const now = new Date()
  await db('nivaro_ops_incidents').insert({
    kind: t.kind,
    title: t.title.slice(0, 300),
    status: 'open',
    source_key: t.source_key?.slice(0, 200) ?? null,
    room,
    root_message_id: root,
    started_by: t.by,
    started_at: now,
    last_update_at: now,
    state: JSON.stringify(state)
  })
  return ((await db('nivaro_ops_incidents').orderBy('id', 'desc').first()) ??
    null) as IncidentRow | null
}

export class IncidentError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

const nameOf = (u: Partial<User> | null | undefined) =>
  `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim() || String(u?.email ?? 'an administrator')

export async function startIncident(
  app: FastifyInstance,
  user: User,
  title: string | null,
  reason?: string | null
): Promise<IncidentRow> {
  if (!(await tableReady()))
    throw new IncidentError(409, 'Incident mode needs migration 442 on this database')
  if (await currentIncident()) throw new IncidentError(409, 'Incident mode is already on')
  const t = (title || 'Incident').replace(/\s+/g, ' ').trim().slice(0, 200)
  const row = await insertThread(
    app,
    { kind: 'incident', title: t, source_key: null, by: String(user.id) },
    `Incident mode is on — ${t}. Started by ${nameOf(user)}${reason ? ` (${reason})` : ''}. I'll post new errors, recoveries and actions in this thread, and a summary when it ends.`
  )
  if (!row) throw new IncidentError(500, 'Could not record the incident')
  // An alert thread already open folds into the incident: one thread to read.
  for (const t2 of await openThreads()) {
    if (t2.kind !== 'alert') continue
    await postInThread(app, t2, `Folded into the incident "${t}".`)
    await db('nivaro_ops_incidents')
      .where({ id: t2.id })
      .update({
        status: 'closed',
        ended_at: new Date(),
        summary: `Folded into incident #${row.id}`
      })
  }
  await logActivity({ action: 'ops-incident-start', user: user.id, comment: t })
  return row
}

export async function endIncident(
  app: FastifyInstance,
  user: User,
  reason?: string | null
): Promise<IncidentRow> {
  const row = await currentIncident()
  if (!row) throw new IncidentError(409, 'Incident mode is not on')
  const state = parseState(row.state)
  const summary = closingSummary(row, state, nameOf(user))
  await postInThread(app, row, `${summary}${reason ? `\nNote: ${reason}` : ''}`)
  await db('nivaro_ops_incidents')
    .where({ id: row.id })
    .update({ status: 'closed', ended_by: user.id, ended_at: new Date(), summary })
  await logActivity({ action: 'ops-incident-end', user: user.id, comment: row.title })
  return { ...row, status: 'closed', summary }
}

/**
 * A critical alert fired. Into the open incident's thread when there is one;
 * otherwise into an open alert thread with the same key; otherwise a new
 * alert thread.
 */
export async function noteCriticalAlert(
  app: FastifyInstance,
  alert: { key: string; title: string }
): Promise<void> {
  if (!(await tableReady())) return
  const { scrubText } = await import('./ai-explain.js')
  const title = scrubText(alert.title).slice(0, 200)
  const incident = await currentIncident()
  if (incident) {
    await postInThread(app, incident, `Critical alert: ${title}`)
    return
  }
  const same = (await openThreads()).find((t) => t.kind === 'alert' && t.source_key === alert.key)
  if (same) {
    const state = parseState(same.state)
    state.last_signal_at = new Date().toISOString()
    await postInThread(app, same, `Again: ${title}`)
    await db('nivaro_ops_incidents')
      .where({ id: same.id })
      .update({ last_update_at: new Date(), state: JSON.stringify(state) })
    return
  }
  await insertThread(
    app,
    { kind: 'alert', title, source_key: alert.key, by: null },
    `Critical alert: ${title}. I'll follow it here and close the thread once it has been quiet for 30 minutes.`
  )
}

/** An approved action, noted in every open thread. */
export async function noteIncidentAction(app: FastifyInstance, line: string): Promise<void> {
  for (const row of await openThreads()) {
    const state = parseState(row.state)
    state.actions = [...state.actions, line].slice(-20)
    await postInThread(app, row, line)
    await db('nivaro_ops_incidents')
      .where({ id: row.id })
      .update({ last_update_at: new Date(), state: JSON.stringify(state) })
  }
}

let lastCriticalCheck = 0

/**
 * The cron tick: new critical issues open or feed a thread; every open thread
 * gets an update when something changed; quiet alert threads close.
 */
export async function runIncidentUpdates(
  app: FastifyInstance
): Promise<{ updated: number; closed: number }> {
  if (!(await tableReady())) return { updated: 0, closed: 0 }
  const since = new Date(lastCriticalCheck || Date.now() - 5 * 60_000)
  lastCriticalCheck = Date.now()
  const critical = (await db('nivaro_issues')
    .where('severity', 'critical')
    .where('status', 'open')
    .where('created_at', '>=', since)
    .orderBy('created_at', 'asc')
    .limit(10)
    .select('id', 'title')
    .catch(() => [])) as Array<{ id: number; title: string }>
  for (const c of critical) await noteCriticalAlert(app, { key: `issue:${c.id}`, title: c.title })

  let updated = 0
  let closed = 0
  const e5 = await serverErrorsLast5().catch(() => 0)
  for (const row of await openThreads()) {
    const prev = parseState(row.state)
    const issues = await issuesSince(new Date(row.started_at))
    const change = describeChange(prev, { e5, issues })
    if (change.lines.length) {
      await postInThread(app, row, change.lines.join('\n'))
      updated++
    }
    if (
      row.kind === 'alert' &&
      Date.now() - new Date(change.next.last_signal_at).getTime() > ALERT_QUIET_MS
    ) {
      const summary = closingSummary(row, change.next, null)
      await postInThread(app, row, summary)
      await db('nivaro_ops_incidents')
        .where({ id: row.id })
        .update({
          status: 'closed',
          ended_at: new Date(),
          summary,
          state: JSON.stringify(change.next)
        })
      closed++
      continue
    }
    await db('nivaro_ops_incidents')
      .where({ id: row.id })
      .update({
        state: JSON.stringify(change.next),
        ...(change.lines.length ? { last_update_at: new Date() } : {})
      })
  }
  return { updated, closed }
}

import { onOwnersChanged } from '../db/owner-signal.js'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { listScopeDimensions, resolveScopeLabelsForUsers } from './user-scopes.js'

/**
 * One read model behind the people page (shared ProfileView) — the same
 * payload for the admin and every headless host, so both draw the same
 * person. Everything an authenticated colleague may know about someone
 * (name, role, availability, who covers them, the teams and pipeline seats
 * they hold, the scopes that shape their view) rides the top level; what
 * only an admin may see (directory verdict, employee id, sessions, sign-in
 * history, account kind) rides `admin`, which is null for everyone else.
 */

export interface PersonRef {
  id: string
  name: string
  email: string | null
  title?: string | null
  is_out_of_office?: boolean
  ooo_end?: string | null
}

export interface PersonProfile {
  id: string
  first_name: string | null
  last_name: string | null
  name: string
  email: string
  title: string | null
  department: string | null
  company: string | null
  phone: string | null
  office_location: string | null
  status: string
  role_id: string | null
  role_name: string | null
  role_admin: boolean
  is_out_of_office: boolean
  ooo_start: string | null
  ooo_end: string | null
  delegate: (PersonRef & { expires_at: string | null }) | null
  manager: PersonRef | null
  /** The directory's manager when they have no account here (nightly sync). */
  manager_external: { name: string | null; email: string | null } | null
  /** Upward chain from the direct manager: [manager, their manager, …]. */
  org_chain: Array<PersonRef & { title?: string | null }>
  /** People with the same manager. */
  peers: PersonRef[]
  direct_reports: PersonRef[]
  /** People who currently route their work to this person. */
  covers_for: PersonRef[]
  custom_status: { text: string; emoji?: string | null; expires_at?: string | null } | null
  timezone: string | null
  last_access: string | null
  created_at: string | null
  presence: { online: boolean; idle_minutes: number | null; last_seen: string | null }
  teams: Array<{ id: number; name: string; slug: string | null; member_count: number }>
  seats: Array<{
    template_id: string
    template_name: string
    states: Array<{ key: string; label: string; groups: number }>
  }>
  seat_count: number
  scopes: Array<{ dimension: string; label: string; values: string[] }>
  open_tasks: number
  admin: {
    account_kind: string | null
    city: string | null
    state: string | null
    country: string | null
    employee_id: string | null
    external_id: boolean
    directory_status: string | null
    directory_checked_at: string | null
    has_static_token: boolean
    is_redacted: boolean
    link_app: string | null
    current_path: string | null
    sessions: number
    activity_30d: number
    logins: Array<{
      at: string
      method: string
      ip: string | null
      new_ip: boolean
    }>
  } | null
}

const iso = (v: unknown): string | null => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function personName(r: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  id?: string
}): string {
  return (
    [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email || String(r.id ?? '')
  )
}

function toRef(r: Record<string, unknown>): PersonRef {
  return {
    id: String(r.id),
    name: personName(
      r as { first_name?: string | null; last_name?: string | null; email?: string }
    ),
    email: (r.email as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    is_out_of_office: !!r.is_out_of_office,
    ooo_end: iso(r.ooo_end)
  }
}

const REF_COLS = ['id', 'first_name', 'last_name', 'email', 'title', 'is_out_of_office', 'ooo_end']

function parsePrefs(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Live Redis sessions for one person — the same scan the security console runs. */
async function countSessions(app: FastifyInstance | undefined, userId: string): Promise<number> {
  const redis = (
    app as
      | {
          redis?: {
            scan: (...args: unknown[]) => Promise<[string, string[]]>
            get: (key: string) => Promise<string | null>
          }
        }
      | undefined
  )?.redis
  if (!redis) return 0
  const want = userId.toUpperCase()
  let n = 0
  try {
    let cursor = '0'
    let guard = 0
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'sess:*', 'COUNT', 200)
      cursor = next
      for (const key of keys) {
        const raw = await redis.get(key)
        if (!raw) continue
        try {
          const uid = (JSON.parse(raw) as { userId?: string }).userId
          if (uid && String(uid).toUpperCase() === want) n++
        } catch {
          // unparseable blob — not this person's
        }
      }
      guard++
    } while (cursor !== '0' && guard < 100)
  } catch {
    // Redis down = "0 known sessions", never a failed profile
  }
  return n
}

export async function buildUserProfile(
  userId: string,
  viewer: { id: string; isAdmin: boolean },
  app?: FastifyInstance
): Promise<PersonProfile | null> {
  const u = (await db('nivaro_users as u')
    .leftJoin('nivaro_roles as r', 'u.role', 'r.id')
    .where('u.id', userId)
    .first('u.*', 'r.name as role_name', 'r.admin_access as role_admin')) as
    | Record<string, unknown>
    | undefined
  if (!u) return null
  const id = String(u.id)
  const prefs = parsePrefs(u.preferences)
  const isSelf = String(viewer.id).toUpperCase() === id.toUpperCase()

  const [manager, delegate, reports, covering, teamRows, seatRows, dims, openTasks, presenceRow] =
    await Promise.all([
      u.manager_id
        ? db('nivaro_users')
            .where('id', u.manager_id)
            .first(...REF_COLS)
            .catch(() => undefined)
        : Promise.resolve(undefined),
      u.delegate_id
        ? db('nivaro_users')
            .where('id', u.delegate_id)
            .first(...REF_COLS)
            .catch(() => undefined)
        : Promise.resolve(undefined),
      db('nivaro_users')
        .where('manager_id', id)
        .where((qb) => void qb.where('status', 'active').orWhereNull('status'))
        .where((qb) => void qb.where('is_redacted', false).orWhereNull('is_redacted'))
        .orderBy('first_name')
        .limit(50)
        .select(...REF_COLS)
        .catch(() => [] as Array<Record<string, unknown>>),
      db('nivaro_users')
        .where('delegate_id', id)
        .where((qb) => void qb.where('status', 'active').orWhereNull('status'))
        .orderBy('first_name')
        .limit(50)
        .select(...REF_COLS)
        .catch(() => [] as Array<Record<string, unknown>>),
      db('nivaro_user_group_members as m')
        .join('nivaro_user_groups as g', 'm.group_id', 'g.id')
        .where('m.user', id)
        .orderBy('g.name')
        .select('g.id', 'g.name', 'g.slug')
        .catch(() => [] as Array<Record<string, unknown>>),
      db('nivaro_pipeline_owner_group_users as gu')
        .join('nivaro_pipeline_owner_groups as g', 'gu.group', 'g.id')
        .join('nivaro_workflow_states as s', 'g.state', 's.id')
        .join('nivaro_workflow_templates as t', 's.template', 't.id')
        .where('gu.user', id)
        .limit(2000)
        .select(
          's.key as state_key',
          's.label as state_label',
          's.sort as state_sort',
          't.id as template_id',
          't.name as template_name'
        )
        .catch(() => [] as Array<Record<string, unknown>>),
      listScopeDimensions(true).catch(() => []),
      db('nivaro_tasks')
        .where('assignee', id)
        .where('status', 'open')
        .count({ c: '*' })
        .first()
        .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
        .catch(() => 0),
      db('user_presence')
        .where('user_id', id)
        .first()
        .catch(() => undefined) as Promise<Record<string, unknown> | undefined>
    ])

  // Org chain: walk manager_id upward (six hops, cycles cut) and the peers
  // who share the direct manager — one read per hop, one for the peers.
  const chain: Array<Record<string, unknown>> = []
  {
    const seen = new Set<string>([id.toUpperCase()])
    let next = u.manager_id ? String(u.manager_id) : null
    for (let hop = 0; hop < 6 && next && !seen.has(next.toUpperCase()); hop++) {
      seen.add(next.toUpperCase())
      const row = (await db('nivaro_users')
        .where('id', next)
        .first(...REF_COLS, 'manager_id')
        .catch(() => undefined)) as Record<string, unknown> | undefined
      if (!row) break
      chain.push(row)
      next = row.manager_id ? String(row.manager_id) : null
    }
  }
  const peers = u.manager_id
    ? ((await db('nivaro_users')
        .where('manager_id', u.manager_id)
        .whereNot('id', id)
        .where((qb) => void qb.where('status', 'active').orWhereNull('status'))
        .where((qb) => void qb.where('is_redacted', false).orWhereNull('is_redacted'))
        .whereNull('account_kind')
        .orderBy('first_name')
        .limit(24)
        .select(...REF_COLS)
        .catch(() => [])) as Array<Record<string, unknown>>)
    : []
  const managerRef = parsePrefs(u.manager_directory) as {
    name?: string | null
    email?: string | null
  }

  // Team member counts, one grouped query.
  const teamIds = (teamRows as Array<Record<string, unknown>>).map((t) => Number(t.id))
  const counts = new Map<number, number>()
  if (teamIds.length) {
    const rows = (await db('nivaro_user_group_members')
      .whereIn('group_id', teamIds)
      .groupBy('group_id')
      .select('group_id')
      .count({ c: '*' })
      .catch(() => [])) as Array<{ group_id: number; c: number | string }>
    for (const r of rows) counts.set(Number(r.group_id), Number(r.c))
  }

  // Seats: template → distinct states, with how many owner groups seat them there.
  const byTemplate = new Map<
    string,
    {
      template_id: string
      template_name: string
      states: Map<string, { key: string; label: string; sort: number; groups: number }>
    }
  >()
  for (const r of seatRows as Array<Record<string, unknown>>) {
    const tid = String(r.template_id)
    const t = byTemplate.get(tid) ?? {
      template_id: tid,
      template_name: String(r.template_name ?? ''),
      states: new Map()
    }
    const key = String(r.state_key)
    const st = t.states.get(key) ?? {
      key,
      label: String(r.state_label ?? key),
      sort: Number(r.state_sort ?? 0),
      groups: 0
    }
    st.groups++
    t.states.set(key, st)
    byTemplate.set(tid, t)
  }
  const seats = [...byTemplate.values()]
    .map((t) => ({
      template_id: t.template_id,
      template_name: t.template_name,
      states: [...t.states.values()]
        .sort((a, b) => a.sort - b.sort)
        .map(({ key, label, groups }) => ({ key, label, groups }))
    }))
    .sort((a, b) => a.template_name.localeCompare(b.template_name))

  // Restrict-mode scopes as labels — the same org-visible line the online
  // list prints under a name.
  let scopes: PersonProfile['scopes'] = []
  try {
    const names = (dims as Array<{ name: string; label: string }>).map((d) => d.name)
    if (names.length) {
      const labels = await resolveScopeLabelsForUsers([id], names)
      const mine = labels.get(id) ?? labels.get(id.toUpperCase()) ?? labels.get(id.toLowerCase())
      if (mine) {
        for (const d of dims as Array<{ name: string; label: string }>) {
          const values = mine.get(d.name)
          if (values?.length) scopes.push({ dimension: d.name, label: d.label, values })
        }
      }
    }
  } catch {
    scopes = []
  }

  // Presence — the freshness rule /presence/online applies.
  const lastSeen = presenceRow?.last_seen ? new Date(String(presenceRow.last_seen)) : null
  const online =
    !!lastSeen &&
    Date.now() - lastSeen.getTime() < 70_000 &&
    (presenceRow?.is_online == null || !!presenceRow.is_online)
  const lastActive = presenceRow?.last_active ? new Date(String(presenceRow.last_active)) : null
  const idleMinutes =
    online && lastActive
      ? Math.max(0, Math.round((Date.now() - lastActive.getTime()) / 60_000))
      : null

  const cs = prefs.custom_status as
    | { text?: string; emoji?: string | null; expires_at?: string | null }
    | undefined
  const customStatus =
    cs?.text && (!cs.expires_at || new Date(cs.expires_at).getTime() > Date.now())
      ? { text: cs.text, emoji: cs.emoji ?? null, expires_at: cs.expires_at ?? null }
      : null

  let admin: PersonProfile['admin'] = null
  if (viewer.isAdmin) {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    const [sessions, activity, logins] = await Promise.all([
      countSessions(app, id),
      db('nivaro_activity')
        .where('user', id)
        .where('timestamp', '>', since)
        .count({ c: '*' })
        .first()
        .then((r) => Number((r as { c?: number | string } | undefined)?.c ?? 0))
        .catch(() => 0),
      db('nivaro_login_events')
        .where('user', id)
        .orderBy('id', 'desc')
        .limit(5)
        .select('created_at', 'method', 'ip', 'new_ip')
        .catch(() => [] as Array<Record<string, unknown>>)
    ])
    admin = {
      account_kind: (u.account_kind as string | null) ?? null,
      city: (u.city as string | null) ?? null,
      state: (u.state as string | null) ?? null,
      country: (u.country as string | null) ?? null,
      employee_id: (u.employee_id as string | null) ?? null,
      external_id: !!u.external_id,
      directory_status: (u.directory_status as string | null) ?? null,
      directory_checked_at: iso(u.directory_checked_at),
      has_static_token: !!u.static_token,
      is_redacted: !!u.is_redacted,
      link_app: (prefs.link_app as string | null) ?? null,
      current_path: (presenceRow?.current_path as string | null) ?? null,
      sessions,
      activity_30d: activity,
      logins: (logins as Array<Record<string, unknown>>).map((l) => ({
        at: iso(l.created_at) ?? '',
        method: String(l.method ?? ''),
        ip: (l.ip as string | null) ?? null,
        new_ip: !!l.new_ip
      }))
    }
  }

  return {
    id,
    first_name: (u.first_name as string | null) ?? null,
    last_name: (u.last_name as string | null) ?? null,
    name: personName(
      u as { first_name?: string | null; last_name?: string | null; email?: string }
    ),
    email: String(u.email ?? ''),
    title: (u.title as string | null) ?? null,
    department: (u.department as string | null) ?? null,
    company: (u.company as string | null) ?? null,
    // A colleague already sees the phone on the contact card; a redacted
    // account has had its details struck and shows none.
    phone: u.is_redacted ? null : ((u.phone as string | null) ?? null),
    office_location: (u.office_location as string | null) ?? null,
    status: String(u.status ?? 'active'),
    role_id: (u.role as string | null) ?? null,
    role_name: (u.role_name as string | null) ?? null,
    role_admin: !!u.role_admin,
    is_out_of_office: !!u.is_out_of_office,
    ooo_start: iso(u.ooo_start),
    ooo_end: iso(u.ooo_end),
    delegate: delegate
      ? { ...toRef(delegate as Record<string, unknown>), expires_at: iso(u.delegate_expires_at) }
      : null,
    manager: manager ? toRef(manager as Record<string, unknown>) : null,
    manager_external:
      !manager && (managerRef.name || managerRef.email)
        ? { name: managerRef.name ?? null, email: managerRef.email ?? null }
        : null,
    org_chain: chain.map(toRef),
    peers: peers.map(toRef),
    direct_reports: (reports as Array<Record<string, unknown>>).map(toRef),
    covers_for: (covering as Array<Record<string, unknown>>).map(toRef),
    custom_status: customStatus,
    timezone: isSelf || viewer.isAdmin ? ((prefs.timezone as string | null) ?? null) : null,
    last_access: iso(u.last_access),
    created_at: iso(u.created_at),
    presence: { online, idle_minutes: idleMinutes, last_seen: lastSeen?.toISOString() ?? null },
    teams: (teamRows as Array<Record<string, unknown>>).map((t) => ({
      id: Number(t.id),
      name: String(t.name ?? ''),
      slug: (t.slug as string | null) ?? null,
      member_count: counts.get(Number(t.id)) ?? 0
    })),
    seats,
    seat_count: (seatRows as unknown[]).length,
    scopes,
    open_tasks: openTasks,
    admin
  }
}

/**
 * Activity rhythm for one person over the last eight weeks — transitions
 * made, tasks completed, records created — plus the current streak. Shared
 * by `/users/me/stats` (the own-profile card) and `/users/:id/stats` (admin).
 */
export async function computeUserStats(userId: string) {
  const since = new Date(Date.now() - 56 * 24 * 3600 * 1000)
  const [transitions, tasksDone, created] = await Promise.all([
    db('nivaro_workflow_history')
      .where('user', userId)
      .where('timestamp', '>', since)
      .select('timestamp')
      .then((rows) => rows.map((r) => new Date(r.timestamp as Date)))
      .catch(() => [] as Date[]),
    db('nivaro_tasks')
      .where('completed_by', userId)
      .where('completed_at', '>', since)
      .select('completed_at')
      .then((rows) => rows.map((r) => new Date(r.completed_at as Date)))
      .catch(() => [] as Date[]),
    db('nivaro_activity')
      .where('user', userId)
      .where('action', 'create')
      .where('timestamp', '>', since)
      .whereNot('collection', 'like', 'nivaro\\_%')
      .select('timestamp')
      .then((rows) => rows.map((r) => new Date(r.timestamp as Date)))
      .catch(() => [] as Date[])
  ])
  const dayKey = (d: Date) => d.toISOString().slice(0, 10)
  const weekIndex = (d: Date) =>
    Math.min(7, Math.max(0, 7 - Math.floor((Date.now() - d.getTime()) / (7 * 24 * 3600 * 1000))))
  const weeks = Array.from({ length: 8 }, () => ({ transitions: 0, tasks_done: 0, created: 0 }))
  const activeDays = new Set<string>()
  for (const d of transitions) {
    weeks[weekIndex(d)].transitions++
    activeDays.add(dayKey(d))
  }
  for (const d of tasksDone) {
    weeks[weekIndex(d)].tasks_done++
    activeDays.add(dayKey(d))
  }
  for (const d of created) {
    weeks[weekIndex(d)].created++
    activeDays.add(dayKey(d))
  }
  // Streak: consecutive days with ANY activity ending today or yesterday
  // (an in-progress day shouldn't break yesterday's streak at 9am).
  let streak = 0
  const cursor = new Date()
  if (!activeDays.has(dayKey(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1)
  while (activeDays.has(dayKey(cursor))) {
    streak++
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  // Typical hours: the 10th–90th percentile of the UTC hour of every action,
  // so a viewer can render "usually active 8 AM – 5 PM" in their own zone.
  const hours = [...transitions, ...tasksDone, ...created]
    .map((d) => d.getUTCHours() + d.getUTCMinutes() / 60)
    .sort((a, b) => a - b)
  const pct = (q: number) => hours[Math.min(hours.length - 1, Math.floor(q * hours.length))]
  return {
    weeks,
    streak_days: streak,
    active_days: [...activeDays].sort(),
    typical_hours_utc:
      hours.length >= 12 ? { start: pct(0.1), end: pct(0.9), samples: hours.length } : null,
    totals: {
      transitions: transitions.length,
      tasks_done: tasksDone.length,
      created: created.length
    }
  }
}

/**
 * What a person is on the hook for right now: the open records they are a
 * resolved owner of (the queue engine's own answer), narrowed to what the
 * VIEWER may read, SLA-breached first. Capped so the card stays a glance.
 */
// Owner resolution over every open instance costs seconds (the My Work
// profile), so one answer per person is kept for two minutes and shared by
// concurrent callers — a second tab or a refetch never pays twice.
const workingOnCache = new Map<string, { at: number; value: Promise<WorkingOnRaw> }>()
const WORKING_ON_TTL_MS = 120_000
type WorkingOnRaw = Array<{
  collection: string
  item_id: string
  label: string
  state: string | null
  state_label: string | null
  state_color: string | null
  sla_status: 'ok' | 'warning' | 'breached' | null
  aging_hours: number | null
}>

// A transition, a manual owner, a delegate or an owner group changed.
onOwnersChanged(() => workingOnCache.clear())

export function bustWorkingOn(userId?: string): void {
  if (userId) workingOnCache.delete(userId)
  else workingOnCache.clear()
}

export async function buildWorkingOn(
  userId: string,
  viewer: { id: string; isAdmin: boolean; role?: string | null },
  cap = 30
): Promise<{
  items: Array<{
    collection: string
    item_id: string
    label: string
    state: string | null
    state_label: string | null
    state_color: string | null
    sla_status: 'ok' | 'warning' | 'breached' | null
    aging_hours: number | null
  }>
  total: number
  hidden: number
}> {
  const { can } = await import('./permissions.js')
  const cached = workingOnCache.get(userId)
  const fresh =
    cached && Date.now() - cached.at < WORKING_ON_TTL_MS
      ? cached.value
      : (() => {
          const value = resolveWorkingOn(userId)
          workingOnCache.set(userId, { at: Date.now(), value })
          value.catch(() => workingOnCache.delete(userId))
          return value
        })()
  const all = await fresh
  // Permission is judged per VIEWER, on top of the shared per-person answer.
  const readable = new Map<string, boolean>()
  const kept: WorkingOnRaw = []
  for (const it of all) {
    const c = it.collection
    if (!readable.has(c)) {
      readable.set(c, viewer.isAdmin || (await can(viewer as never, 'read', c).catch(() => false)))
    }
    if (readable.get(c)) kept.push(it)
  }
  return { items: kept.slice(0, cap), total: kept.length, hidden: all.length - kept.length }
}

async function resolveWorkingOn(userId: string): Promise<WorkingOnRaw> {
  const { resolveOwnedByMeSource } = await import('./queues.js')
  const { computeStatusBatch } = await import('../routes/sla.js')
  const { selectInChunks } = await import('./db-batch.js')
  const owned = await resolveOwnedByMeSource(userId).catch(() => ({ items: [] }))
  const kept = (owned as { items: Array<Record<string, unknown>> }).items
  // The owned-by-me resolver carries no SLA or aging (it is a membership
  // answer); both come from the SLA batch per collection, which also gives the
  // hours since the record entered its state. State labels ride one instance
  // read per collection.
  const byCollection = new Map<string, string[]>()
  for (const it of kept) {
    const c = String(it.collection)
    if (!byCollection.has(c)) byCollection.set(c, [])
    byCollection.get(c)!.push(String(it.item_id))
  }
  const sla = new Map<string, { status: string | null; elapsed_hours: number }>()
  const labels = new Map<string, string>()
  for (const [c, ids] of byCollection) {
    const batch = await computeStatusBatch(c, ids).catch(
      () => ({}) as Record<string, { status: string | null; elapsed_hours: number }>
    )
    for (const [id, e] of Object.entries(batch)) sla.set(`${c}:${id}`, e)
    const rows = await selectInChunks(ids, 1500, (chunk) =>
      db('nivaro_workflow_instances as wi')
        .join('nivaro_workflow_states as s', 'wi.current_state', 's.id')
        .where('wi.collection', c)
        .whereNull('wi.completed_at')
        .whereIn('wi.item', chunk)
        .select('wi.item', 's.label')
    ).catch(() => [] as Array<{ item: string; label: string }>)
    for (const r of rows as Array<{ item: string; label: string }>) {
      labels.set(`${c}:${r.item}`, r.label)
    }
  }
  const enriched = kept.map((it) => {
    const key = `${it.collection}:${it.item_id}`
    const e = sla.get(key)
    return {
      collection: String(it.collection),
      item_id: String(it.item_id),
      label: String(it.label ?? it.item_id),
      state: (it.state as string | null) ?? null,
      state_label: labels.get(key) ?? null,
      state_color: (it.state_color as string | null) ?? null,
      sla_status: (e?.status as 'ok' | 'warning' | 'breached' | null) ?? null,
      aging_hours: e?.elapsed_hours == null ? null : Math.round(e.elapsed_hours * 10) / 10
    }
  })
  const rank = (v: string | null) => (v === 'breached' ? 0 : v === 'warning' ? 1 : 2)
  enriched.sort(
    (a, b) => rank(a.sla_status) - rank(b.sla_status) || (b.aging_hours ?? 0) - (a.aging_hours ?? 0)
  )
  return enriched
}

/** Open records + SLA escalation rules that would go uncovered if this person is out with no delegate. */
export async function computeOooExposure(userId: string) {
  const { resolveOwnedByMeSource } = await import('./queues.js')
  const [owned, slaRules] = await Promise.all([
    resolveOwnedByMeSource(userId)
      .then((r) => (Array.isArray(r.items) ? r.items.length : 0))
      .catch(() => 0),
    db('nivaro_sla_rules')
      .where({ escalation_user: userId, is_active: 1 })
      .count({ c: '*' })
      .first()
      .then((r) => Number((r as { c?: unknown } | undefined)?.c ?? 0))
      .catch(() => 0)
  ])
  return { owned_open_records: owned, sla_escalations: slaRules }
}

import { isMssql } from '../../db/dialect.js'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { DAY_MS, type Window } from './model.js'
import { distinctRecordsAll, peopleActivity, readableChanges, recordChanges } from './stats.js'

/**
 * The Overview "Today" strip's drill sheets — each one reads the SAME source as its figure
 * (services/overview/stats.ts), over the SAME window the figure was computed for (the client
 * passes the figure's `day_start` and `computed_at`), so the sheet lists exactly the number on
 * the tile:
 *
 *   records  recordChanges(window)   → distinct (collection, item) = "Records changed today"
 *   people   peopleActivity(window)  → distinct people            = "People active today"
 *
 * Administrators read every record change; everyone else only records they can read
 * (readableChanges: role policy, row filter, User Scopes per record), as the figure does.
 */

export const TODAY_LIST_MAX = 200
export const PEOPLE_MAX = 2000

/** The window a sheet reads: the figure's own day start → its computed_at (never the future). */
export function sheetWindow(dayStart: Date, until: unknown, now = new Date()): Window {
  let to = now
  if (typeof until === 'string' && until.trim()) {
    const t = new Date(until.trim()).getTime()
    if (Number.isFinite(t) && t <= now.getTime() && t >= dayStart.getTime()) to = new Date(t)
  }
  return { from: dayStart, to }
}

export interface RecordRow {
  collection: string
  item: string
  changes: number
  last_at: string
  last_id: number | null
  last_action: string | null
  last_user: string | null
}

export interface TodayRecords {
  window: { from: string; to: string }
  scope: 'all' | 'readable'
  records: number
  changes: number
  capped: boolean
  by_collection: Array<{ collection: string; records: number; changes: number }>
  by_person: Array<{ user: string; name: string | null; records: number; changes: number }>
  /** Changes per hour from the window's start, oldest first. */
  hourly: number[]
  rows: RecordRow[]
  total_rows: number
}

const num = (v: unknown) => Number(v ?? 0) || 0
const iso = (v: unknown) => new Date(v as string).toISOString()

function hoursIn(w: Window): number {
  return Math.max(1, Math.min(48, Math.ceil((w.to.getTime() - w.from.getTime()) / 3_600_000)))
}

/** Pure: the breakdown of a set of change rows (non-admin path, and tests). */
export function summarizeChanges(
  rows: Array<{
    collection: string
    item: string
    timestamp: Date | string
    user: string | null
    id?: number
    action?: string | null
  }>,
  w: Window,
  opts: { collection?: string | null; user?: string | null; offset?: number; limit?: number } = {}
): Omit<TodayRecords, 'window' | 'scope' | 'capped' | 'by_person'> & {
  by_person: Array<{ user: string; records: number; changes: number }>
} {
  const inWin = rows.filter((r) => {
    const t = new Date(r.timestamp).getTime()
    return t >= w.from.getTime() && t <= w.to.getTime() && r.collection && r.item != null
  })
  const hours = hoursIn(w)
  const hourly = new Array<number>(hours).fill(0)
  const recs = new Map<string, RecordRow>()
  const byCol = new Map<string, { records: Set<string>; changes: number }>()
  const byUser = new Map<string, { records: Set<string>; changes: number }>()
  for (const r of inWin) {
    const key = `${r.collection}\u0000${r.item}`
    const t = new Date(r.timestamp).getTime()
    const h = Math.min(hours - 1, Math.floor((t - w.from.getTime()) / 3_600_000))
    if (h >= 0) hourly[h]++
    const c = byCol.get(r.collection) ?? { records: new Set(), changes: 0 }
    c.records.add(key)
    c.changes++
    byCol.set(r.collection, c)
    if (r.user) {
      const u = byUser.get(r.user) ?? { records: new Set(), changes: 0 }
      u.records.add(key)
      u.changes++
      byUser.set(r.user, u)
    }
    if (opts.collection && r.collection !== opts.collection) continue
    if (opts.user && r.user !== opts.user) continue
    const cur = recs.get(key)
    if (!cur || new Date(cur.last_at).getTime() < t)
      recs.set(key, {
        collection: r.collection,
        item: String(r.item),
        changes: (cur?.changes ?? 0) + 1,
        last_at: new Date(t).toISOString(),
        last_id: r.id ?? null,
        last_action: r.action ?? null,
        last_user: r.user ?? null
      })
    else cur.changes++
  }
  const all = [...recs.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
  const offset = opts.offset ?? 0
  const limit = opts.limit ?? 50
  const distinct = new Set(inWin.map((r) => `${r.collection}\u0000${r.item}`))
  return {
    records: distinct.size,
    changes: inWin.length,
    hourly,
    by_collection: [...byCol.entries()]
      .map(([collection, v]) => ({ collection, records: v.records.size, changes: v.changes }))
      .sort((a, b) => b.changes - a.changes),
    by_person: [...byUser.entries()]
      .map(([user, v]) => ({ user, records: v.records.size, changes: v.changes }))
      .sort((a, b) => b.changes - a.changes),
    rows: all.slice(offset, offset + limit),
    total_rows: all.length
  }
}

/** id (lower case) → the words for that person: a name, or what the account is (never "Someone"). */
async function namesOf(
  ids: string[],
  revealDeletedName: boolean
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map()
  const { personLabels } = await import('../person-names.js')
  const labels = await personLabels(ids, { revealDeletedName })
  return new Map([...labels].map(([id, label]) => [id.toLowerCase(), label]))
}

/** Records changed in the window, with the breakdown header's numbers. */
export async function loadTodayRecords(
  user: User,
  opts: {
    isAdmin: boolean
    window: Window
    collection?: string | null
    person?: string | null
    offset?: number
    limit?: number
  }
): Promise<TodayRecords> {
  const w = opts.window
  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.min(TODAY_LIST_MAX, Math.max(1, opts.limit ?? 50))
  const win = { from: w.from.toISOString(), to: w.to.toISOString() }

  if (!opts.isAdmin) {
    const changes = await readableChanges(user, w)
    // A View-as write reads as the person's own: the user column already names the person.
    const s = summarizeChanges(
      changes.rows.map((r) => ({ ...r, item: String(r.item) })),
      w,
      { collection: opts.collection, user: opts.person, offset, limit }
    )
    const names = await namesOf(
      s.by_person.map((p) => p.user),
      false
    )
    return {
      ...s,
      window: win,
      scope: 'readable',
      capped: changes.capped,
      by_person: s.by_person
        .slice(0, 12)
        .map((p) => ({ ...p, name: names.get(p.user.toLowerCase()) ?? null })),
      by_collection: s.by_collection.slice(0, 12)
    }
  }

  const mssql = isMssql(db)
  const hours = hoursIn(w)
  const listQ = recordChanges(w)
  if (opts.collection) listQ.where('a.collection', opts.collection)
  if (opts.person) listQ.where('a.user', opts.person)
  const grouped = listQ
    .groupBy('a.collection', 'a.item')
    .select('a.collection', 'a.item')
    .count({ n: '*' })
    .max({ last_id: 'a.id' })
    .max({ last_at: 'a.timestamp' })

  const [records, changes, byCol, byUser, hourRows, page, totalRows] = await Promise.all([
    distinctRecordsAll(w),
    recordChanges(w)
      .count({ n: '*' })
      .then((r) => num((r as Array<{ n: unknown }>)[0]?.n)),
    db
      .from(
        recordChanges(w)
          .select(
            'a.collection',
            mssql
              ? db.raw("CONCAT(a.collection, ':', a.item) as k")
              : db.raw("a.collection || ':' || a.item as k")
          )
          .as('x')
      )
      .select('x.collection')
      .count({ changes: '*' })
      .countDistinct({ records: 'x.k' })
      .groupBy('x.collection')
      .orderBy('changes', 'desc')
      .limit(12) as Promise<Array<Record<string, unknown>>>,
    db
      .from(
        recordChanges(w)
          .whereNotNull('a.user')
          .select(
            'a.user',
            mssql
              ? db.raw("CONCAT(a.collection, ':', a.item) as k")
              : db.raw("a.collection || ':' || a.item as k")
          )
          .as('x')
      )
      .select('x.user')
      .count({ changes: '*' })
      .countDistinct({ records: 'x.k' })
      .groupBy('x.user')
      .orderBy('changes', 'desc')
      .limit(12) as Promise<Array<Record<string, unknown>>>,
    mssql
      ? (db
          .from(
            recordChanges(w)
              .select(db.raw('DATEDIFF(minute, ?, a.timestamp) / 60 as h', [w.from]))
              .as('x')
          )
          .select('x.h')
          .count({ n: '*' })
          .groupBy('x.h') as Promise<Array<{ h: unknown; n: unknown }>>)
      : (
          recordChanges(w).select('a.timestamp').limit(20_000) as Promise<
            Array<{ timestamp: Date }>
          >
        ).then((rows) => {
          const out = new Map<number, number>()
          for (const r of rows) {
            const h = Math.floor((new Date(r.timestamp).getTime() - w.from.getTime()) / 3_600_000)
            out.set(h, (out.get(h) ?? 0) + 1)
          }
          return [...out.entries()].map(([h, n]) => ({ h, n }))
        }),
    grouped
      .clone()
      .orderBy([{ column: 'last_id', order: 'desc' }])
      .offset(offset)
      .limit(limit) as Promise<Array<Record<string, unknown>>>,
    db
      .from(grouped.clone().as('g'))
      .count({ n: '*' })
      .then((r) => num((r as Array<{ n: unknown }>)[0]?.n))
  ])
  const hourly = new Array<number>(hours).fill(0)
  for (const r of hourRows) {
    const h = Number(r.h)
    if (Number.isInteger(h) && h >= 0 && h < hours) hourly[h] += num(r.n)
  }
  // The newest entry of each listed record: who and what.
  const lastIds = page.map((r) => num(r.last_id)).filter(Boolean)
  const last = new Map<number, { user: string | null; action: string | null }>()
  if (lastIds.length) {
    for (const r of (await db('nivaro_activity')
      .whereIn('id', lastIds)
      .select('id', 'user', 'action')) as Array<Record<string, unknown>>)
      last.set(num(r.id), {
        user: r.user ? String(r.user) : null,
        action: r.action ? String(r.action) : null
      })
  }
  const names = await namesOf(
    byUser.map((u) => String(u.user)),
    true
  )
  return {
    window: win,
    scope: 'all',
    records,
    changes,
    capped: false,
    hourly,
    by_collection: byCol.map((r) => ({
      collection: String(r.collection),
      records: num(r.records),
      changes: num(r.changes)
    })),
    by_person: byUser.map((r) => ({
      user: String(r.user),
      name: names.get(String(r.user).toLowerCase()) ?? null,
      records: num(r.records),
      changes: num(r.changes)
    })),
    rows: page.map((r) => {
      const l = last.get(num(r.last_id))
      return {
        collection: String(r.collection),
        item: String(r.item),
        changes: num(r.n),
        last_at: iso(r.last_at),
        last_id: num(r.last_id) || null,
        last_action: l?.action ?? null,
        last_user: l?.user ?? null
      }
    }),
    total_rows: totalRows
  }
}

export interface PersonToday {
  id: string
  /** A name, or what the account is ("Deleted user", "Redacted person") — never empty. */
  name: string | null
  kind: import('../person-names.js').PersonKind
  email: string | null
  role: string | null
  status: string | null
  first_at: string
  last_at: string
  /** Every entry today (reads included). */
  actions: number
  /** Entries that were not reads. */
  writes: number
  /** Distinct records they changed (create / update / delete / moves). */
  records_changed: number
  /** Records they opened (read entries). */
  records_opened: number
}

/** People active in the window — one row per person the figure counts. */
/**
 * One row per person with an entry in the window — the same rows `distinctUsers` counts for the
 * figure (peopleActivity), so first seen / last seen are the first and last entry INSIDE the
 * window (the viewer's day so far), never earlier.
 */
export function todayPeopleQuery(w: Window, mssql: boolean) {
  const k = mssql ? "CONCAT(a.collection, ':', a.item)" : "a.collection || ':' || a.item"
  return db
    .from(
      peopleActivity(w)
        .select(
          'a.user',
          'a.timestamp',
          'a.action',
          db.raw(
            `CASE WHEN a.action IN ('create','update','delete','transition','pipeline-transition','pipeline-start','restore','revert') AND a.item IS NOT NULL AND a.collection NOT LIKE 'nivaro${mssql ? '[_]' : '\\_'}%' AND a.collection NOT LIKE 'directus${mssql ? '[_]' : '\\_'}%' THEN ${k} END as changed_key`
          ),
          db.raw(`CASE WHEN a.action = 'read' AND a.item IS NOT NULL THEN ${k} END as read_key`)
        )
        .as('x')
    )
    .select('x.user')
    .count({ actions: '*' })
    .min({ first_at: 'x.timestamp' })
    .max({ last_at: 'x.timestamp' })
    .countDistinct({ records_changed: 'x.changed_key', records_opened: 'x.read_key' })
    .select(db.raw("SUM(CASE WHEN x.action = 'read' THEN 1 ELSE 0 END) as reads"))
    .groupBy('x.user')
    .orderBy('last_at', 'desc')
    .limit(PEOPLE_MAX + 1)
}

export async function loadTodayPeople(w: Window): Promise<{
  window: { from: string; to: string }
  people: PersonToday[]
  total: number
  capped: boolean
}> {
  const rows = (await todayPeopleQuery(w, isMssql(db))) as Array<Record<string, unknown>>
  const capped = rows.length > PEOPLE_MAX
  const list = rows.slice(0, PEOPLE_MAX)
  const ids = list.map((r) => String(r.user))
  const users = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    for (const u of (await db('nivaro_users as u')
      .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
      .whereIn('u.id', chunk)
      .select(
        'u.id',
        'u.first_name',
        'u.last_name',
        'u.email',
        'u.status',
        'r.name as role'
      )) as Array<Record<string, unknown>>)
      users.set(String(u.id).toLowerCase(), u)
  }
  // Who each one is: a name, or what the account is (deleted, redacted, placeholder, service).
  const { resolvePeople, personLabel } = await import('../person-names.js')
  const who = await resolvePeople(ids)
  const people = list.map((r) => {
    const u = users.get(String(r.user).toLowerCase())
    const actions = num(r.actions)
    const p = who.get(String(r.user).toUpperCase()) ?? {
      id: String(r.user),
      name: null,
      kind: 'deleted' as const
    }
    return {
      id: String(r.user),
      name: personLabel(p, { revealDeletedName: true }),
      kind: p.kind,
      email: u?.email ? String(u.email) : null,
      role: u?.role ? String(u.role) : null,
      status: u?.status ? String(u.status) : null,
      first_at: iso(r.first_at),
      last_at: iso(r.last_at),
      actions,
      writes: actions - num(r.reads),
      records_changed: num(r.records_changed),
      records_opened: num(r.records_opened)
    }
  })
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString() },
    people,
    total: capped ? PEOPLE_MAX : people.length,
    capped
  }
}

/** Failed job runs in the 24 hours the figure counts (`failedJobs`), newest first. */
export function failedJobsWindow(until: Date): Window {
  return { from: new Date(until.getTime() - DAY_MS), to: until }
}

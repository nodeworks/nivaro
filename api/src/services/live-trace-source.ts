import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { liveModeOf } from './collection-live-mode.js'
import { DURABLE_RETENTION_HOURS, flushDurable } from './event-journal-store.js'
import {
  assembleTrace,
  eventFromRow,
  type LiveTrace,
  type RawEventRow,
  type TracePerson,
  type TraceSubscriber,
  type TraceWrite,
  validCollectionName
} from './live-trace.js'
import { ackEvery } from './realtime-ack-sample.js'
import { ackedByForSeqs } from './realtime-delivery-slo.js'
import { splitTenantRoom } from './socket-transport.js'

/** What the trace needs from the running server's socket roster (injected so tests need no sockets). */
export interface RosterSocket {
  id: string
  user: { id: string; name: string } | string | null
  app: string | null
  transport: string | null
  connectedAt: number | null
  rooms: string[]
}

export interface TraceSources {
  sockets: () => RosterSocket[]
  tenant: string | null
}

const EVENT_CAP = 500
const WRITE_CAP = 200

function userOf(s: RosterSocket): { id: string | null; name: string } {
  if (s.user && typeof s.user === 'object') return { id: s.user.id, name: s.user.name || s.user.id }
  if (typeof s.user === 'string' && s.user) return { id: null, name: s.user }
  return { id: null, name: 'not signed in' }
}

/** Who sits in the record's room or the collection's room right now (pure — exported for tests). */
export function subscribersOf(
  sockets: readonly RosterSocket[],
  collection: string,
  item: string
): Array<Omit<TraceSubscriber, 'acked' | 'acked_events'>> {
  const recordRoom = `record:${collection}:${item}`
  const collectionRoom = `collection:${collection}`
  const byPerson = new Map<string, Omit<TraceSubscriber, 'acked' | 'acked_events'>>()
  for (const s of sockets) {
    const rooms = new Set(s.rooms.map((r) => splitTenantRoom(r).room))
    const via: Array<'record' | 'collection'> = []
    if (rooms.has(recordRoom)) via.push('record')
    if (rooms.has(collectionRoom)) via.push('collection')
    if (via.length === 0) continue
    const u = userOf(s)
    const key = (u.id ?? u.name).toUpperCase()
    const cur = byPerson.get(key) ?? {
      user_id: u.id,
      name: u.name,
      sockets: 0,
      via: [] as Array<'record' | 'collection'>,
      apps: [] as string[]
    }
    cur.sockets += 1
    for (const v of via) if (!cur.via.includes(v)) cur.via.push(v)
    if (s.app && !cur.apps.includes(s.app)) cur.apps.push(s.app)
    byPerson.set(key, cur)
  }
  return [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** One person's live connections, rooms capped and ids shortened (pure — exported for tests). */
export function personOf(sockets: readonly RosterSocket[], userId: string): TracePerson {
  const want = userId.toUpperCase()
  const mine = sockets.filter((s) => {
    const u = userOf(s)
    return u.id != null && u.id.toUpperCase() === want
  })
  const name = mine.length > 0 ? userOf(mine[0]).name : null
  return {
    user_id: userId,
    name,
    sockets: mine.map((s) => {
      const rooms = [...new Set(s.rooms.map((r) => splitTenantRoom(r).room))].sort()
      return {
        id: s.id.slice(0, 8),
        app: s.app,
        transport: s.transport,
        connected_at: s.connectedAt ? new Date(s.connectedAt).toISOString() : null,
        rooms: rooms.slice(0, 60),
        rooms_total: rooms.length
      }
    })
  }
}

async function journalRows(
  from: Date,
  to: Date,
  tenant: string | null,
  where: (q: any) => void
): Promise<{ rows: RawEventRow[]; available: boolean; truncated: boolean }> {
  if (!(await hasColumn('nivaro_event_journal', 'seq').catch(() => false)))
    return { rows: [], available: false, truncated: false }
  await flushDurable().catch(() => {})
  const q = db('nivaro_event_journal').where('at', '>=', from).where('at', '<=', to)
  if (tenant) q.where('room', 'like', `t:${tenant}:%`)
  where(q)
  const rows = (await q
    .orderBy('seq', 'desc')
    .limit(EVENT_CAP + 1)
    .select(
      'seq',
      'at',
      'room',
      'event',
      'action',
      'collection',
      'item',
      'changed_fields',
      'extra'
    )) as RawEventRow[]
  const truncated = rows.length > EVENT_CAP
  return { rows: rows.slice(0, EVENT_CAP), available: true, truncated }
}

async function activityWrites(
  collection: string,
  item: string,
  from: Date,
  to: Date
): Promise<TraceWrite[]> {
  const rows = (await db('nivaro_activity')
    .where({ collection, item })
    .where('timestamp', '>=', from)
    .where('timestamp', '<=', to)
    .orderBy('timestamp', 'desc')
    .limit(WRITE_CAP)
    .select('id', 'action', 'user', 'timestamp')) as Array<Record<string, unknown>>
  return rows
    .filter((r) => ['create', 'update', 'delete'].includes(String(r.action)))
    .map((r) => ({
      kind: 'activity' as const,
      at: new Date(r.timestamp as Date).toISOString(),
      action: String(r.action),
      item,
      by: r.user == null ? null : String(r.user),
      fields: [],
      activity_id: Number(r.id),
      announced: false,
      matched_seq: null
    }))
}

/** Announcements from procedures/scripts that were queued and never drained (a drain deletes them). */
async function pendingRawWrites(collection: string, item: string): Promise<TraceWrite[]> {
  if (!(await hasColumn('nivaro_raw_writes', 'collection').catch(() => false))) return []
  const rows = (await db('nivaro_raw_writes')
    .where({ collection })
    .where((w) => w.where('item', item).orWhereNull('item'))
    .orderBy('created_at', 'desc')
    .limit(50)
    .select('item', 'action', 'changed_fields', 'source', 'created_at')) as Array<
    Record<string, unknown>
  >
  return rows.map((r) => ({
    kind: 'raw-pending' as const,
    at: new Date(r.created_at as Date).toISOString(),
    action: r.action == null ? null : String(r.action),
    item: r.item == null ? null : String(r.item),
    by: r.source == null ? null : String(r.source),
    fields: String(r.changed_fields ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50),
    activity_id: null,
    announced: false,
    matched_seq: null
  }))
}

/**
 * A row whose own `date_updated` moved in the window with no activity entry near it was
 * written by something that bypasses the items service (a procedure, a script). Only the
 * timestamp is read — never a field value.
 */
async function rowTimestampWrite(
  collection: string,
  item: string,
  from: Date,
  to: Date,
  activity: readonly TraceWrite[]
): Promise<TraceWrite[]> {
  if (!validCollectionName(collection)) return []
  const known = await db('nivaro_collections')
    .where({ collection })
    .first('collection')
    .catch(() => null)
  if (!known) return []
  if (!(await hasColumn(collection, 'date_updated').catch(() => false))) return []
  const row = (await db(collection)
    .where({ id: item })
    .first('date_updated')
    .catch(() => null)) as { date_updated?: unknown } | null
  if (!row?.date_updated) return []
  const at = new Date(row.date_updated as Date)
  if (Number.isNaN(at.getTime()) || at < from || at > to) return []
  if (activity.some((a) => Math.abs(Date.parse(a.at) - at.getTime()) <= 120_000)) return []
  return [
    {
      kind: 'row-timestamp',
      at: at.toISOString(),
      action: 'update',
      item,
      by: null,
      fields: [],
      activity_id: null,
      announced: false,
      matched_seq: null
    }
  ]
}

export interface TraceParams {
  collection: string | null
  item: string | null
  user: string | null
  from: Date
  to: Date
}

/** Build the trace for a record, or for a person when no record is named. */
export async function loadLiveTrace(
  params: TraceParams,
  sources: TraceSources
): Promise<LiveTrace> {
  const now = new Date()
  const roster = sources.sockets()
  if (params.collection && params.item) {
    const { collection, item } = params
    const [journal, mode, activity, pending] = await Promise.all([
      journalRows(params.from, params.to, sources.tenant, (q) => {
        q.where('collection', collection).where((w: any) =>
          w.where('item', item).orWhere('item', '*')
        )
      }),
      liveModeOf(collection).catch(() => null),
      activityWrites(collection, item, params.from, params.to).catch(() => []),
      pendingRawWrites(collection, item).catch(() => [])
    ])
    const stamped = await rowTimestampWrite(
      collection,
      item,
      params.from,
      params.to,
      activity
    ).catch(() => [])
    const acks = await ackedByForSeqs(journal.rows.map((r) => Number(r.seq)))
    return assembleTrace({
      mode: 'record',
      from: params.from,
      to: params.to,
      collection,
      item,
      liveMode: mode,
      journalAvailable: journal.available,
      journalTruncated: journal.truncated,
      retentionHours: DURABLE_RETENTION_HOURS,
      events: journal.rows.map((r) => eventFromRow(r, acks)),
      writes: [...activity, ...stamped, ...pending],
      subscribers: subscribersOf(roster, collection, item),
      person: null,
      rooms: [],
      ackEvery: ackEvery(),
      now
    })
  }
  // Person mode: the rooms this person is in now, and what went out to them.
  const userId = params.user ?? ''
  const person = personOf(roster, userId)
  const rooms = new Set<string>()
  for (const s of person.sockets)
    for (const r of s.rooms) if (/^(collection|record):/.test(r)) rooms.add(r)
  const roomList = [...rooms].slice(0, 100)
  const scoped = sources.tenant ? roomList.map((r) => `t:${sources.tenant}:${r}`) : roomList
  const journal =
    scoped.length > 0
      ? await journalRows(params.from, params.to, sources.tenant, (q) => {
          q.whereIn('room', scoped)
        })
      : { rows: [] as RawEventRow[], available: true, truncated: false }
  const acks = await ackedByForSeqs(journal.rows.map((r) => Number(r.seq)))
  const events = journal.rows.map((r) => eventFromRow(r, acks))
  const perRoom = new Map<string, number>()
  for (const e of events) {
    const r = splitTenantRoom(e.room).room
    perRoom.set(r, (perRoom.get(r) ?? 0) + 1)
  }
  return assembleTrace({
    mode: 'person',
    from: params.from,
    to: params.to,
    collection: null,
    item: null,
    liveMode: null,
    journalAvailable: journal.available,
    journalTruncated: journal.truncated,
    retentionHours: DURABLE_RETENTION_HOURS,
    events,
    writes: [],
    subscribers: [],
    person,
    rooms: [...perRoom.entries()]
      .map(([room, n]) => ({ room, events: n }))
      .sort((a, b) => b.events - a.events),
    ackEvery: ackEvery(),
    now
  })
}

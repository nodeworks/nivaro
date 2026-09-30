import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { canSeeRoom, parseRoom } from './chat.js'

/**
 * Record rooms ↔ records.
 *
 * An entity room (`<prefix>:<token>`) belongs to one record: the room-type
 * registry maps the prefix to a collection and the column the token matches.
 * This module resolves that in both directions and drives the record-side
 * chat features: the room header's state/SLA/owners (#985), the unread count
 * on the record's chat button (#986), activity lines posted into the room
 * (#933), owners following the room as the record moves (#948) and the
 * assistant knowing which record it is being asked about (#954).
 */

export interface RoomType {
  id: number
  prefix: string
  collection: string
  match_field: string
  label: string | null
  is_active: boolean
  post_activity?: boolean
  owners_follow?: boolean
}

let typeCache: { at: number; rows: RoomType[] } | null = null

export function clearRoomTypeCache(): void {
  typeCache = null
}

export async function roomTypes(): Promise<RoomType[]> {
  if (typeCache && Date.now() - typeCache.at < 30_000) return typeCache.rows
  const rows = (
    (await db('nivaro_chat_room_types').where('is_active', true)) as Array<Record<string, unknown>>
  ).map(
    (r) =>
      ({
        ...r,
        is_active: !!r.is_active,
        post_activity: !!r.post_activity,
        owners_follow: !!r.owners_follow
      }) as RoomType
  )
  typeCache = { at: Date.now(), rows }
  return rows
}

export interface RoomRecord {
  room: string
  prefix: string
  token: string
  collection: string
  match_field: string
  id: string
  label: string
}

/** The record an entity room is about, read AS THE VIEWER (null if unseen). */
export async function resolveRoomRecord(user: User, room: string): Promise<RoomRecord | null> {
  const parsed = parseRoom(room)
  if (parsed.kind !== 'entity' || !parsed.token) return null
  const type = (await roomTypes()).find((t) => t.prefix === parsed.prefix)
  if (!type) return null
  if (!(await canSeeRoom(user, room))) return null
  const { readItems } = await import('./items.js')
  const res = (await readItems(user, type.collection, {
    filter: { [type.match_field]: { _eq: parsed.token } },
    fields: ['id'],
    limit: 1
  }).catch(() => ({ data: [] }))) as { data?: Array<{ id: string | number }> }
  const id = res.data?.[0]?.id
  if (id == null) return null
  const { getLabels } = await import('./queues.js')
  const labels = await getLabels(new Map([[type.collection, new Set([String(id)])]])).catch(
    () => ({}) as Record<string, string>
  )
  return {
    room,
    prefix: type.prefix,
    token: parsed.token,
    collection: type.collection,
    match_field: type.match_field,
    id: String(id),
    label: labels[`${type.collection}:${id}`] ?? parsed.token
  }
}

/**
 * The entity room for a record (raw read — the caller already decided the
 * person may see the record). Null when the collection has no room type.
 */
export async function roomForRecord(
  collection: string,
  id: string | number
): Promise<{ room: string; type: RoomType } | null> {
  const type = (await roomTypes()).find((t) => t.collection === collection)
  if (!type) return null
  let token = String(id)
  if (type.match_field !== 'id') {
    try {
      const row = (await db(collection).where({ id }).first(type.match_field)) as
        | Record<string, unknown>
        | undefined
      const v = row?.[type.match_field]
      if (v == null || v === '') return null
      token = String(v)
    } catch {
      return null
    }
  }
  return { room: `${type.prefix}:${token}`, type }
}

/** Record header facts: state, SLA, owners (#985). */
export async function roomRecordFacts(
  user: User,
  room: string
): Promise<
  | (RoomRecord & {
      state: { key: string; label: string; color: string | null } | null
      sla: { status: string; elapsed_hours: number | null; due_hours: number | null } | null
      owners: Array<{ id: string; name: string }>
    })
  | null
> {
  const rec = await resolveRoomRecord(user, room)
  if (!rec) return null
  let state: { key: string; label: string; color: string | null } | null = null
  let owners: Array<{ id: string; name: string }> = []
  let sla: { status: string; elapsed_hours: number | null; due_hours: number | null } | null = null
  try {
    const inst = (await db('nivaro_workflow_instances as i')
      .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
      .where({ 'i.collection': rec.collection, 'i.item': rec.id })
      .orderByRaw('CASE WHEN i.completed_at IS NULL THEN 0 ELSE 1 END, i.id DESC')
      .first('i.id', 'i.current_state', 's.key', 's.label', 's.color')) as
      | Record<string, unknown>
      | undefined
    if (inst) {
      state = {
        key: String(inst.key),
        label: String(inst.label ?? inst.key),
        color: inst.color ? String(inst.color) : null
      }
      const { resolveStateOwners } = await import('./pipeline-engine.js')
      const resolved = await resolveStateOwners(
        String(inst.current_state),
        String(inst.id),
        rec.collection,
        rec.id
      ).catch(() => [])
      owners = resolved.slice(0, 12).map((o) => ({
        id: String(o.id),
        name: [o.first_name, o.last_name].filter(Boolean).join(' ').trim() || String(o.email ?? '')
      }))
    }
  } catch {
    /* no pipeline */
  }
  try {
    const { computeStatusBatch } = await import('../routes/sla.js')
    const batch = await computeStatusBatch(rec.collection, [rec.id])
    const e = batch[rec.id] as unknown as Record<string, unknown> | undefined
    if (e?.status && e.status !== 'none') {
      sla = {
        status: String(e.status),
        elapsed_hours: e.elapsed_hours != null ? Number(e.elapsed_hours) : null,
        due_hours: e.duration_hours != null ? Number(e.duration_hours) : null
      }
    }
  } catch {
    /* no SLA */
  }
  return { ...rec, state, sla, owners }
}

// ── Activity lines (#933) + owners follow (#948) ────────────────────────────

/**
 * Post a platform line into a record's room — only for collections whose room
 * type opted in (post_activity), and only when the room already has messages
 * or members (a line in an empty room nobody opened is noise).
 */
export async function postRecordActivity(
  app: FastifyInstance,
  collection: string,
  id: string | number,
  text: string
): Promise<void> {
  try {
    if (!(await hasColumn('nivaro_chat_room_types', 'post_activity'))) return
    const target = await roomForRecord(collection, id)
    if (!target?.type.post_activity) return
    const { postChatMessage } = await import('./chat-send.js')
    await postChatMessage(
      app,
      { user: null, senderId: null, senderName: 'Nivaro', system: true, skipVisibility: true },
      { room: target.room, message: text.slice(0, 1000) }
    )
  } catch (err) {
    app.log.warn({ err, collection, id }, 'record activity line failed')
  }
}

/** Give the record's current owners a membership on its room (#948). */
export async function followRecordRoom(
  collection: string,
  id: string | number,
  ownerIds: string[]
): Promise<number> {
  try {
    if (!(await hasColumn('nivaro_chat_room_types', 'owners_follow'))) return 0
    const target = await roomForRecord(collection, id)
    if (!target?.type.owners_follow || ownerIds.length === 0) return 0
    const { upsertMembership } = await import('./chat-send.js')
    let n = 0
    for (const uid of [...new Set(ownerIds.map((o) => String(o).toUpperCase()))].slice(0, 50)) {
      const existing = await db('nivaro_chat_memberships')
        .where({ user: uid, room: target.room })
        .first('id')
      if (existing) continue
      // Joining starts the watermark now — owners get what happens next,
      // not the whole backlog.
      await upsertMembership(uid, target.room, { last_read_at: new Date() })
      n++
    }
    return n
  } catch {
    return 0
  }
}

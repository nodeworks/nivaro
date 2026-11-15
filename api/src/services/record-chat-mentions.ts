import { db } from '../db/index.js'
import type { User } from '../types.js'
import { canSeeRoom, channelByKey, newRoomVisibilityCache, parseRoom } from './chat.js'
import { roomForRecord, roomTypes } from './chat-records.js'
import { emitRecordEvent } from './record-events.js'

/**
 * "Being discussed in #ops (3 new)" on a record (rt7 #18).
 *
 * A record is MENTIONED in chat when a message carries its token — the value its room type
 * matches on (the human id the "Send to a room" share posts, which chat renders as a live record
 * chip). Everything here is read AS THE VIEWER:
 *   - the record itself must be readable by them (readOne; null = nothing, so the chip never
 *     tells anyone that an unseen record is being talked about);
 *   - only rooms they are IN count: a membership row, or a DM they are a party to, and
 *     canSeeRoom must still agree (an archived or since-restricted room reads as nothing);
 *   - the answer is counts and room names — never message text or senders.
 * "New" = messages from other people after the viewer's own read watermark in that room; a
 * room they have never opened (no membership row) or muted shows none as new.
 *
 * Live: a message that names a record token pings that record's open pages with the existing
 * `record:chat {collection, item}` notice (ids only); each page re-reads as itself.
 */

/** Look back this far for mentions; older talk is history, not "being discussed". */
export const MENTION_WINDOW_DAYS = 14
/** Messages read per call; the newest first. */
const MESSAGE_CAP = 300
/** The generic "ab26-12345" shape chat already renders as a record chip. */
export const DEFAULT_ENTITY_PATTERN = String.raw`\b([A-Za-z]{2,4}\d{2}(?:INV)?-\d+)\b`
/** Tokens named by one message that may ping record pages. */
const MAX_TOKENS_PER_MESSAGE = 5

export interface MentionRoom {
  room: string
  kind: 'global' | 'dm' | 'channel'
  label: string
  /** Messages in the window naming this record. */
  count: number
  /** Of those, from other people after the viewer's read watermark. */
  new_count: number
  last_at: string | null
}

export interface RecordMentions {
  rooms: MentionRoom[]
  total: number
  new_total: number
}

interface MsgRow {
  id: number | string
  room: string
  sender: string | null
  message: string | null
  date_created: Date | string
}

interface Membership {
  room: string
  last_read_at: Date | string | null
  is_muted?: boolean | number | null
}

/** Does `text` name `token` as a whole token (case-insensitive)? (pure) */
export function messageNamesToken(text: string | null | undefined, token: string): boolean {
  if (!text || !token) return false
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9-])${esc}(?![A-Za-z0-9])`, 'i').test(text)
}

/** LIKE-escape a literal for `ESCAPE '\'`-free SQL Server use: bracket the wildcards. (pure) */
export function likeLiteral(s: string): string {
  return s.replace(/[[%_]/g, (c) => `[${c}]`)
}

/** Distinct candidate record tokens in a message, upper-cased (pure). */
export function tokensIn(
  text: string | null | undefined,
  pattern = DEFAULT_ENTITY_PATTERN
): string[] {
  if (!text) return []
  let re: RegExp
  try {
    re = new RegExp(pattern, 'gi')
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const m of text.matchAll(re)) {
    out.add(m[0].toUpperCase())
    if (out.size >= MAX_TOKENS_PER_MESSAGE) break
  }
  return [...out]
}

/**
 * Group the window's messages into rooms (pure). `visible` already holds the rooms the viewer
 * is in AND may see; `labels` names them. A message from the viewer counts as a mention but
 * never as new.
 */
export function groupMentions(
  messages: MsgRow[],
  token: string,
  viewerId: string,
  memberships: Map<string, Membership>,
  visible: Map<string, { kind: MentionRoom['kind']; label: string }>
): RecordMentions {
  const me = viewerId.toUpperCase()
  const byRoom = new Map<string, MentionRoom>()
  for (const m of messages) {
    if (!messageNamesToken(m.message, token)) continue
    const info = visible.get(m.room)
    if (!info) continue
    const row = byRoom.get(m.room) ?? {
      room: m.room,
      kind: info.kind,
      label: info.label,
      count: 0,
      new_count: 0,
      last_at: null
    }
    row.count++
    const at = new Date(m.date_created)
    const iso = Number.isNaN(at.getTime()) ? null : at.toISOString()
    if (iso && (!row.last_at || iso > row.last_at)) row.last_at = iso
    const ms = memberships.get(m.room)
    const mine = !!m.sender && String(m.sender).toUpperCase() === me
    if (ms && !ms.is_muted && !mine) {
      const read = ms.last_read_at ? new Date(ms.last_read_at).getTime() : 0
      if (!read || at.getTime() > read) row.new_count++
    }
    byRoom.set(m.room, row)
  }
  const rooms = [...byRoom.values()].sort(
    (a, b) => b.new_count - a.new_count || String(b.last_at).localeCompare(String(a.last_at))
  )
  return {
    rooms,
    total: rooms.reduce((n, r) => n + r.count, 0),
    new_total: rooms.reduce((n, r) => n + r.new_count, 0)
  }
}

const EMPTY: RecordMentions = { rooms: [], total: 0, new_total: 0 }

async function labelFor(
  viewer: User,
  room: string
): Promise<{ kind: MentionRoom['kind']; label: string } | null> {
  const parsed = parseRoom(room)
  if (parsed.kind === 'global') return { kind: 'global', label: 'General' }
  if (parsed.kind === 'channel') {
    const c = await channelByKey(parsed.channelKey ?? '')
    if (!c || c.is_archived) return null
    return { kind: 'channel', label: `#${(c as { name?: string }).name ?? parsed.channelKey}` }
  }
  if (parsed.kind === 'dm') {
    const me = String(viewer.id).toUpperCase()
    const peer = (parsed.participants ?? []).find((p) => p !== me) ?? me
    const u = (await db('nivaro_users')
      .where({ id: peer })
      .first('first_name', 'last_name', 'email')) as
      | { first_name: string | null; last_name: string | null; email: string | null }
      | undefined
    const name = u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email : null
    return { kind: 'dm', label: name ?? 'a direct message' }
  }
  return null
}

/**
 * Where is this record being talked about, for this viewer? Never throws: a failure reads as
 * "nothing" (the chip is a hint, never a reason to break a record page).
 */
export async function recordMentionsFor(
  viewer: User,
  collection: string,
  itemId: string
): Promise<RecordMentions> {
  try {
    const { readOne } = await import('./items.js')
    // The record must be the viewer's to see — null (hidden or missing) answers nothing.
    const rec = await readOne(viewer, collection, itemId, undefined, ['id']).catch(() => null)
    if (!rec) return EMPTY
    const target = await roomForRecord(collection, itemId)
    if (!target || target.type.match_field === 'id') return EMPTY
    const token = target.room.slice(target.type.prefix.length + 1)
    if (!token) return EMPTY

    const uid = String(viewer.id)
    const memberRows = (await db('nivaro_chat_memberships')
      .where('user', uid)
      .select('room', 'last_read_at', 'is_muted')) as Membership[]
    const memberships = new Map(memberRows.map((m) => [m.room, m]))
    const since = new Date(Date.now() - MENTION_WINDOW_DAYS * 86_400_000)
    const memberRooms = [...memberships.keys()].filter(
      (r) => !r.startsWith(`${target.type.prefix}:`)
    )
    const me = uid.toUpperCase()
    const messages = (await db('chat_messages')
      .whereNull('deleted_at')
      .where('date_created', '>', since)
      .where('message', 'like', `%${likeLiteral(token)}%`)
      .where((qb) => {
        if (memberRooms.length) qb.whereIn('room', memberRooms)
        qb.orWhere('room', 'like', `dm:${me}:%`).orWhere('room', 'like', `dm:%:${me}`)
      })
      .where((qb) => qb.whereNull('is_system').orWhere('is_system', false))
      .orderBy('id', 'desc')
      .limit(MESSAGE_CAP)
      .select('id', 'room', 'sender', 'message', 'date_created')) as MsgRow[]
    if (messages.length === 0) return EMPTY

    const cache = newRoomVisibilityCache()
    const visible = new Map<string, { kind: MentionRoom['kind']; label: string }>()
    for (const room of new Set(messages.map((m) => m.room))) {
      const parsed = parseRoom(room)
      // Only rooms the viewer is in: a membership row, or a DM they are a party to.
      const isIn =
        memberships.has(room) || (parsed.kind === 'dm' && parsed.participants?.includes(me))
      if (!isIn || parsed.kind === 'entity') continue
      if (!(await canSeeRoom(viewer, room, cache))) continue
      const info = await labelFor(viewer, room)
      if (info) visible.set(room, info)
    }
    return groupMentions(messages, token, uid, memberships, visible)
  } catch {
    return EMPTY
  }
}

// ── Live: tell the record's open pages ────────────────────────────────────────

export interface MentionAnnounceDeps {
  types: () => Promise<Array<{ collection: string; match_field: string }>>
  lookup: (collection: string, field: string, tokens: string[]) => Promise<string[]>
  emit: (collection: string, id: string) => void
}

const announceDefaults: MentionAnnounceDeps = {
  types: () => roomTypes(),
  lookup: async (collection, field, tokens) => {
    const rows = (await db(collection)
      .whereIn(field, tokens)
      .limit(MAX_TOKENS_PER_MESSAGE * 2)
      .select('id')) as Array<{ id: string | number }>
    return rows.map((r) => String(r.id))
  },
  emit: (collection, id) => emitRecordEvent(collection, id, 'record:chat')
}

/**
 * A message was sent: if it names records by token, their open pages re-read who is talking
 * about them. Fire and forget — the chip also refreshes on its own timer.
 */
export async function announceRecordMentions(
  message: string | null | undefined,
  deps: MentionAnnounceDeps = announceDefaults
): Promise<void> {
  try {
    const tokens = tokensIn(message)
    if (tokens.length === 0) return
    for (const t of await deps.types()) {
      if (t.match_field === 'id') continue
      for (const id of await deps.lookup(t.collection, t.match_field, tokens)) {
        deps.emit(t.collection, id)
      }
    }
  } catch {
    /* best-effort */
  }
}

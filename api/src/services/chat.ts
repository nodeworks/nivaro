import { db } from '../db/index.js'
import type { User } from '../types.js'
import { readItems } from './items.js'
import { can } from './permissions.js'

/**
 * Chat room visibility.
 *
 * `canSeeRoom` is the single gate — the room list, message reads, sends and the
 * socket join all call it, so a new endpoint cannot reintroduce the leak this
 * replaced (policies on chat_messages are table-level, so `read` on the
 * collection previously meant read on every room).
 */

export type RoomKind = 'global' | 'dm' | 'channel' | 'entity' | 'unknown'

export interface ParsedRoom {
  kind: RoomKind
  room: string
  /** dm: the two participant ids, uppercased. */
  participants?: string[]
  /** channel: the `ch:` key. */
  channelKey?: string
  /** entity: prefix + the token that identifies the record. */
  prefix?: string
  token?: string
}

export const GLOBAL_ROOM = 'global'

export function parseRoom(room: string): ParsedRoom {
  const key = String(room ?? '').trim()
  if (!key) return { kind: 'unknown', room: key }
  if (key === GLOBAL_ROOM) return { kind: 'global', room: key }
  if (key.startsWith('dm:')) {
    // Uppercased because MSSQL returns uuids uppercased — a casing mismatch
    // forks a second room (see chat-core).
    const participants = key
      .slice(3)
      .split(':')
      .map((p) => p.toUpperCase())
      .filter(Boolean)
    return { kind: participants.length === 2 ? 'dm' : 'unknown', room: key, participants }
  }
  if (key.startsWith('ch:')) {
    const channelKey = key.slice(3)
    return { kind: channelKey ? 'channel' : 'unknown', room: key, channelKey }
  }
  const idx = key.indexOf(':')
  if (idx > 0) {
    return { kind: 'entity', room: key, prefix: key.slice(0, idx), token: key.slice(idx + 1) }
  }
  return { kind: 'unknown', room: key }
}

// ── Registry cache (entity prefixes + channels) ─────────────────────────────
// Both are small and change rarely; a short TTL keeps the sidebar from
// re-reading them on every message.

interface RoomType {
  prefix: string
  collection: string
  match_field: string
  label: string | null
}
export interface ChatChannel {
  id: number
  key: string
  name: string
  topic: string | null
  visibility: 'open' | 'role' | 'private'
  role: string | null
  created_by: string | null
  is_archived: boolean
  /** Group DM — a private channel rendered like a conversation, not a #channel. */
  is_direct: boolean
}

const TTL_MS = 30_000
let typeCache: { at: number; byPrefix: Map<string, RoomType> } | null = null
let channelCache: { at: number; byKey: Map<string, ChatChannel> } | null = null

export function clearChatCaches(): void {
  typeCache = null
  channelCache = null
}

async function roomTypes(): Promise<Map<string, RoomType>> {
  if (typeCache && Date.now() - typeCache.at < TTL_MS) return typeCache.byPrefix
  const rows = (await db('nivaro_chat_room_types').where('is_active', true)) as RoomType[]
  const byPrefix = new Map(rows.map((r) => [r.prefix, r]))
  typeCache = { at: Date.now(), byPrefix }
  return byPrefix
}

export async function channels(): Promise<Map<string, ChatChannel>> {
  if (channelCache && Date.now() - channelCache.at < TTL_MS) return channelCache.byKey
  const rows = (await db('nivaro_chat_channels')) as Array<Record<string, unknown>>
  const byKey = new Map(
    rows.map((r) => [
      String(r.key),
      { ...r, is_archived: !!r.is_archived, is_direct: !!r.is_direct } as unknown as ChatChannel
    ])
  )
  channelCache = { at: Date.now(), byKey }
  return byKey
}

// ── Visibility ──────────────────────────────────────────────────────────────

/** Per-request memo: the room list checks many rooms, often hitting the same
 *  collection repeatedly, and an entity check costs a scoped read. */
export type RoomVisibilityCache = Map<string, boolean>

export function newRoomVisibilityCache(): RoomVisibilityCache {
  return new Map()
}

/**
 * Can this user see this room at all?
 *
 * Deliberately NOT admin-bypassed for DMs and private channels: admin_access
 * grants data access, not other people's conversations. Open/role channels and
 * entity rooms follow the normal permission model, so an admin sees those the
 * same way they see any record.
 */
export async function canSeeRoom(
  user: User,
  room: string,
  cache?: RoomVisibilityCache
): Promise<boolean> {
  const cacheKey = `${user.id}|${room}`
  const hit = cache?.get(cacheKey)
  if (hit !== undefined) return hit

  const verdict = await computeVisibility(user, room)
  cache?.set(cacheKey, verdict)
  return verdict
}

async function computeVisibility(user: User, room: string): Promise<boolean> {
  const parsed = parseRoom(room)
  switch (parsed.kind) {
    case 'global':
      return true

    case 'dm':
      return (parsed.participants ?? []).includes(String(user.id).toUpperCase())

    case 'channel': {
      const channel = (await channels()).get(parsed.channelKey ?? '')
      if (!channel || channel.is_archived) return false
      if (channel.visibility === 'open') return true
      // A membership row admits you to ANY channel kind. That matters for
      // role-scoped ones: the creator gets a membership, and without this an
      // admin who made a channel for another role could not see the channel
      // they had just created.
      const member = !!(await db('nivaro_chat_memberships').where({ user: user.id, room }).first())
      if (channel.visibility === 'role') {
        return member || (!!user.role && String(channel.role ?? '') === String(user.role))
      }
      // private — explicit membership only
      return member
    }

    case 'entity': {
      const type = (await roomTypes()).get(parsed.prefix ?? '')
      // An unregistered prefix is not a room anyone can see. Fail closed: the
      // alternative is that inventing a key grants a private side-channel.
      if (!type || !parsed.token) return false
      if (!(await can(user, 'read', type.collection))) return false
      try {
        // Read AS THE USER so row-level filters and user scopes apply — this is
        // what makes "you see the room if you can see the record" true rather
        // than merely intended.
        const res = (await readItems(user, type.collection, {
          filter: { [type.match_field]: { _eq: parsed.token } },
          fields: ['id'],
          limit: 1
        })) as { data?: unknown[] }
        return (res.data?.length ?? 0) > 0
      } catch {
        // A missing collection or a broken filter must not read as "visible".
        return false
      }
    }

    default:
      return false
  }
}

/** Filter a room list down to what the user may see, memoised across the set. */
export async function visibleRooms(user: User, rooms: string[]): Promise<Set<string>> {
  const cache = newRoomVisibilityCache()
  const out = new Set<string>()
  for (const room of rooms) {
    if (await canSeeRoom(user, room, cache)) out.add(room)
  }
  return out
}

// ── Room list ───────────────────────────────────────────────────────────────

export interface RoomSummary {
  room: string
  kind: RoomKind
  label: string | null
  unread: number
  muted: boolean
  notify_mode: 'all' | 'mentions'
  joined: boolean
  /** Channel rooms only — what the settings panel needs without a second fetch. */
  channel: {
    id: number
    visibility: 'open' | 'role' | 'private'
    role: string | null
    topic: string | null
    created_by: string | null
    is_direct: boolean
  } | null
  last_message: {
    id: number
    message: string
    sender: string | null
    sender_name: string | null
    date_created: string
  } | null
}

/**
 * The rooms that belong in this user's sidebar: everything they have joined,
 * plus the ones that are theirs by nature (global, their DMs). Open channels
 * they have NOT joined are deliberately excluded — they belong to the
 * directory, which is what keeps the sidebar usable at hundreds of channels.
 */
export async function listRooms(user: User): Promise<RoomSummary[]> {
  const uid = String(user.id)
  const [memberships, dmRooms, chans] = await Promise.all([
    db('nivaro_chat_memberships').where('user', uid) as Promise<
      Array<{ room: string; last_read_at: Date | null; is_muted: boolean; notify_mode: string | null }>
    >,
    // DMs are implicit: a message addressed to you creates the room.
    // NOTE: .distinct().pluck() is BROKEN on knex/mssql — it returns one
    // nested array instead of strings, which silently killed implicit-DM
    // discovery (a DM someone STARTS with you never appeared until you had a
    // membership row). Map the rows explicitly.
    db('chat_messages')
      .distinct('room')
      .where('room', 'like', 'dm:%')
      .andWhere((qb) => {
        qb.where('room', 'like', `dm:${uid.toUpperCase()}:%`).orWhere(
          'room',
          'like',
          `dm:%:${uid.toUpperCase()}`
        )
      })
      .then((rows) =>
        [...new Set((rows as Array<{ room: string }>).map((r) => String(r.room)))]
      ) as Promise<string[]>,
    channels()
  ])

  const byRoom = new Map(memberships.map((m) => [m.room, m]))
  const candidates = new Set<string>([GLOBAL_ROOM, ...byRoom.keys(), ...dmRooms])

  // Archived channels drop out of the sidebar even for members.
  for (const room of [...candidates]) {
    const parsed = parseRoom(room)
    if (parsed.kind === 'channel') {
      const c = chans.get(parsed.channelKey ?? '')
      if (!c || c.is_archived) candidates.delete(room)
    }
  }

  const allowed = await visibleRooms(user, [...candidates])
  if (allowed.size === 0) return []

  const rooms = [...allowed]
  const [lastMessages, unreadRows, dmNames] = await Promise.all([
    lastMessagePerRoom(rooms),
    unreadPerRoom(uid, rooms),
    dmPeerNames(uid, rooms)
  ])

  const out: RoomSummary[] = rooms.map((room) => {
    const parsed = parseRoom(room)
    const membership = byRoom.get(room)
    const channel = parsed.kind === 'channel' ? chans.get(parsed.channelKey ?? '') : undefined
    return {
      room,
      kind: parsed.kind,
      label: channel?.name ?? dmNames.get(room) ?? null,
      channel: channel
        ? {
            id: channel.id,
            visibility: channel.visibility,
            role: channel.role,
            topic: channel.topic,
            created_by: channel.created_by,
            is_direct: channel.is_direct
          }
        : null,
      unread: unreadRows.get(room) ?? 0,
      muted: !!membership?.is_muted,
      notify_mode: (membership?.notify_mode === 'mentions' ? 'mentions' : 'all') as 'all' | 'mentions',
      joined: !!membership,
      last_message: lastMessages.get(room) ?? null
    }
  })
  // Busiest first, but a room that has never been used still ranks above
  // nothing — an empty channel you just joined must not vanish.
  out.sort((a, b) => {
    const at = a.last_message ? new Date(a.last_message.date_created).getTime() : 0
    const bt = b.last_message ? new Date(b.last_message.date_created).getTime() : 0
    return bt - at
  })
  return out
}

/** One row per room — the newest message. Replaces "fetch 500 and group". */
async function lastMessagePerRoom(rooms: string[]): Promise<Map<string, RoomSummary['last_message']>> {
  const out = new Map<string, RoomSummary['last_message']>()
  if (rooms.length === 0) return out
  for (const chunk of chunked(rooms)) {
    // Tombstones (deleted_at set) are skipped — a deleted message must not be
    // the sidebar preview, so the newest SURVIVING message represents the room.
    const rows = (await db('chat_messages as m')
      .whereIn('m.room', chunk)
      .whereNull('m.deleted_at')
      .whereRaw(
        'm.id = (SELECT MAX(m2.id) FROM chat_messages m2 WHERE m2.room = m.room AND m2.deleted_at IS NULL)'
      )
      .select('m.id', 'm.room', 'm.message', 'm.sender', 'm.sender_name', 'm.date_created')) as Array<
      Record<string, unknown>
    >
    for (const r of rows) {
      out.set(String(r.room), {
        id: Number(r.id),
        message: String(r.message ?? ''),
        sender: r.sender ? String(r.sender) : null,
        sender_name: r.sender_name ? String(r.sender_name) : null,
        date_created: new Date(String(r.date_created)).toISOString()
      })
    }
  }
  return out
}

/** Unread counted in SQL against the watermark, not by scanning messages
 *  client-side — the old count was only ever right within the last 500. */
async function unreadPerRoom(userId: string, rooms: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (rooms.length === 0) return out
  for (const chunk of chunked(rooms)) {
    const rows = (await db('chat_messages as m')
      .leftJoin('nivaro_chat_memberships as w', (j) =>
        j.on('w.room', '=', 'm.room').andOn(db.raw('w.[user] = ?', [userId]))
      )
      .whereIn('m.room', chunk)
      // A deleted message is not something to catch up on — no unread credit.
      .whereNull('m.deleted_at')
      .andWhere((qb) => qb.whereNull('m.sender').orWhereRaw('UPPER(CAST(m.sender AS NVARCHAR(36))) <> ?', [userId.toUpperCase()]))
      .andWhere((qb) =>
        qb.whereNull('w.last_read_at').orWhereRaw('m.date_created > w.last_read_at')
      )
      .groupBy('m.room')
      .select('m.room')
      .count({ n: 'm.id' })) as Array<{ room: string; n: number }>
    for (const r of rows) out.set(String(r.room), Number(r.n))
  }
  return out
}

/**
 * Peer display names for DM rooms. Resolved from the user table rather than
 * from the last message's sender_name, which is empty until the other person
 * has actually said something — a DM you opened first showed as "User 075372A3".
 */
async function dmPeerNames(userId: string, rooms: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const peers = new Map<string, string>()
  for (const room of rooms) {
    const parsed = parseRoom(room)
    if (parsed.kind !== 'dm') continue
    const peer = (parsed.participants ?? []).find((p) => p !== userId.toUpperCase())
    if (peer) peers.set(room, peer)
  }
  if (peers.size === 0) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', [...new Set(peers.values())])
    .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
  const byId = new Map(
    rows.map((r) => [
      String(r.id).toUpperCase(),
      [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || String(r.email ?? '')
    ])
  )
  for (const [room, peer] of peers) {
    const name = byId.get(peer)
    if (name) out.set(room, name)
  }
  return out
}

/** MSSQL caps bound parameters at ~2100. */
function* chunked<T>(items: T[], size = 500): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

// ── Channel directory ───────────────────────────────────────────────────────

export interface DirectoryChannel extends ChatChannel {
  joined: boolean
  members: number
}

/**
 * Channels the user could join. Private ones appear only to members, so the
 * directory never advertises a room's existence to someone who cannot enter.
 */
export async function listDirectory(user: User, search?: string): Promise<DirectoryChannel[]> {
  // Group DMs are conversations, not channels — the directory never lists
  // them (members see them in the sidebar via their membership rows).
  const all = [...(await channels()).values()].filter((c) => !c.is_archived && !c.is_direct)
  const mine = new Set(
    (await db('nivaro_chat_memberships').where('user', user.id).pluck('room')) as string[]
  )
  const term = search?.trim().toLowerCase()
  const visible = all.filter((c) => {
    if (c.visibility === 'open') return true
    // Same rule as canSeeRoom: membership admits you regardless of kind.
    if (mine.has(`ch:${c.key}`)) return true
    if (c.visibility === 'role') return !!user.role && String(c.role ?? '') === String(user.role)
    return false
  })
  const filtered = term
    ? visible.filter(
        (c) =>
          c.name.toLowerCase().includes(term) ||
          c.key.toLowerCase().includes(term) ||
          (c.topic ?? '').toLowerCase().includes(term)
      )
    : visible

  const counts = new Map<string, number>()
  if (filtered.length > 0) {
    const rows = (await db('nivaro_chat_memberships')
      .whereIn(
        'room',
        filtered.map((c) => `ch:${c.key}`)
      )
      .groupBy('room')
      .select('room')
      .count({ n: 'id' })) as Array<{ room: string; n: number }>
    for (const r of rows) counts.set(String(r.room), Number(r.n))
  }

  return filtered
    .map((c) => ({
      ...c,
      joined: mine.has(`ch:${c.key}`),
      members: counts.get(`ch:${c.key}`) ?? 0
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

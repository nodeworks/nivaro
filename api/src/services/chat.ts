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
  /** One of CHANNEL_ICONS; null = the plain "#" tile. */
  icon?: string | null
  /** #rrggbb from CHANNEL_COLORS; null = neutral. */
  color?: string | null
  /** Announcement channel (#935): only the owner and admins post. */
  announce?: boolean
  /** Optional longer purpose shown at the top of the room (#936). */
  description?: string | null
  /** Pinned links at the top of the room (#936). */
  links?: Array<{ label: string; url: string }>
  /** Shown once to each new member (#961). */
  welcome_note?: string | null
  /** Roles whose members join automatically (#960). */
  default_roles?: string[]
}

function jsonList<T>(raw: unknown): T[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw as T[]
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

/** Validate a channel's pinned links: ≤ 8, http(s) only, short labels. */
export function cleanChannelLinks(raw: unknown): Array<{ label: string; url: string }> | null {
  if (raw == null) return []
  if (!Array.isArray(raw)) return null
  const out: Array<{ label: string; url: string }> = []
  for (const l of raw.slice(0, 8)) {
    const url = String((l as { url?: unknown })?.url ?? '').trim()
    if (!/^https?:\/\/\S+$/i.test(url) && !/^\/[\w\-/?=&%.#]*$/.test(url)) return null
    const label =
      String((l as { label?: unknown })?.label ?? '')
        .trim()
        .slice(0, 60) || url
    out.push({ label, url: url.slice(0, 500) })
  }
  return out
}

/** The icons a channel may carry — the client draws exactly these names. */
export const CHANNEL_ICONS = [
  'hash',
  'megaphone',
  'users',
  'briefcase',
  'wrench',
  'truck',
  'package',
  'dollar',
  'building',
  'map',
  'zap',
  'shield',
  'bug',
  'lightbulb',
  'calendar',
  'star'
] as const

/** Mid-tone colours that read on both light and dark surfaces. */
export const CHANNEL_COLORS = [
  '#0ea5e9',
  '#14b8a6',
  '#10b981',
  '#f59e0b',
  '#f97316',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#6366f1',
  '#64748b'
] as const

/**
 * Validate an icon/colour pair from a request body. Returns the columns to
 * write (only the keys that were sent), or an error sentence.
 */
export function channelLookPatch(
  b: Record<string, unknown>
): { patch: Record<string, string | null> } | { error: string } {
  const patch: Record<string, string | null> = {}
  if (b.icon !== undefined) {
    if (b.icon === null || b.icon === '') patch.icon = null
    else if ((CHANNEL_ICONS as readonly string[]).includes(String(b.icon)))
      patch.icon = String(b.icon)
    else return { error: `icon must be one of: ${CHANNEL_ICONS.join(', ')}` }
  }
  if (b.color !== undefined) {
    if (b.color === null || b.color === '') patch.color = null
    else if ((CHANNEL_COLORS as readonly string[]).includes(String(b.color).toLowerCase()))
      patch.color = String(b.color).toLowerCase()
    else return { error: `color must be one of: ${CHANNEL_COLORS.join(', ')}` }
  }
  return { patch }
}

const TTL_MS = 30_000
let typeCache: { at: number; byPrefix: Map<string, RoomType> } | null = null
let channelCache: { at: number; byKey: Map<string, ChatChannel> } | null = null

export function clearChatCaches(): void {
  typeCache = null
  channelCache = null
  generalCache = null
}

// ── General (the `global` room) ─────────────────────────────────────────────
// General has no nivaro_chat_channels row — its dressing lives on
// nivaro_settings.chat_general (migration 373). It is presented as a channel
// with id 0 so the same settings panel, intro, welcome note and announce rule
// apply. Visibility is fixed (everyone), there is no owner — admins edit it.

export const GENERAL_CHANNEL_ID = 0
const GENERAL_DEFAULT_NAME = 'General'
let generalCache: { at: number; channel: ChatChannel; customName: boolean } | null = null

/** The stored General settings, parsed. Empty object when unset or unreadable. */
async function readGeneralSettings(): Promise<Record<string, unknown>> {
  try {
    const row = (await db('nivaro_settings').where('id', 1).first('chat_general')) as
      | { chat_general?: string | null }
      | undefined
    if (!row?.chat_general) return {}
    const v = JSON.parse(String(row.chat_general))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    // A database behind migration 373 has no column — General stays plain.
    return {}
  }
}

async function loadGeneral(): Promise<{ channel: ChatChannel; customName: boolean }> {
  if (generalCache && Date.now() - generalCache.at < TTL_MS) return generalCache
  const s = await readGeneralSettings()
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  const name = str(s.name)
  const channel: ChatChannel = {
    id: GENERAL_CHANNEL_ID,
    key: 'general',
    name: name ?? GENERAL_DEFAULT_NAME,
    topic: str(s.topic),
    visibility: 'open',
    role: null,
    created_by: null,
    is_archived: false,
    is_direct: false,
    icon: str(s.icon),
    color: str(s.color),
    announce: !!s.announce,
    description: str(s.description),
    links: jsonList<{ label: string; url: string }>(s.links),
    welcome_note: str(s.welcome_note),
    default_roles: jsonList<string>(s.default_roles).map((x) => String(x).toUpperCase())
  }
  generalCache = { at: Date.now(), channel, customName: !!name }
  return generalCache
}

/** General as a channel (id 0). */
export async function generalChannel(): Promise<ChatChannel> {
  return (await loadGeneral()).channel
}

/**
 * Save General's settings. `patch` holds validated values (see the route);
 * keys set to null/empty drop back to the default.
 */
export async function saveGeneralSettings(patch: Record<string, unknown>): Promise<ChatChannel> {
  const current = await readGeneralSettings()
  const next: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(patch)) {
    const empty = v == null || v === '' || v === false || (Array.isArray(v) && v.length === 0)
    if (empty) delete next[k]
    else next[k] = v
  }
  await db('nivaro_settings')
    .where('id', 1)
    .update({ chat_general: Object.keys(next).length ? JSON.stringify(next) : null })
  generalCache = null
  return generalChannel()
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
      {
        ...r,
        is_archived: !!r.is_archived,
        is_direct: !!r.is_direct,
        announce: !!r.announce,
        links: jsonList<{ label: string; url: string }>(r.links),
        default_roles: jsonList<string>(r.default_roles).map((x) => String(x).toUpperCase())
      } as unknown as ChatChannel
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
  archived: boolean
  joined: boolean
  /** Channel rooms only — what the settings panel needs without a second fetch. */
  channel: {
    id: number
    visibility: 'open' | 'role' | 'private'
    role: string | null
    topic: string | null
    created_by: string | null
    is_direct: boolean
    icon: string | null
    color: string | null
    announce: boolean
    description: string | null
    links: Array<{ label: string; url: string }>
    welcome_note: string | null
    default_roles: string[]
  } | null
  /** Pinned to the top of this person's list (#957). */
  starred: boolean
  /** When this person dismissed the channel's welcome note (#961). */
  welcome_seen_at: string | null
  /** Unread messages that name this person (@mention, @channel, @here). */
  mentions: number
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
export async function listRooms(
  user: User,
  opts: { archived?: boolean } = {}
): Promise<RoomSummary[]> {
  const uid = String(user.id)
  const wantArchived = opts.archived === true
  await autoJoinDefaultChannels(user).catch(() => {})
  const [memberships, dmRooms, chans] = await Promise.all([
    db('nivaro_chat_memberships').where('user', uid) as Promise<
      Array<{
        room: string
        last_read_at: Date | null
        is_muted: boolean
        notify_mode: string | null
        archived_at?: Date | null
        starred?: boolean | null
        welcome_seen_at?: Date | null
      }>
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
      .then((rows) => [
        ...new Set((rows as Array<{ room: string }>).map((r) => String(r.room)))
      ]) as Promise<string[]>,
    channels()
  ])
  const general = await loadGeneral()

  const byRoom = new Map(memberships.map((m) => [m.room, m]))
  // Archive is personal: an archived room lives only in the Archived list, so
  // it never counts toward the badge, the sound or the toast. Without the
  // column (a database behind migration 368) nothing is archived.
  const archived = new Set(memberships.filter((m) => m.archived_at).map((m) => m.room))
  // General is OPT-IN like any open channel (2026-09-22): it lists only once
  // the person has joined it from the directory. Every open room would
  // otherwise page the whole company on every message.
  const candidates = new Set<string>(
    [...byRoom.keys(), ...dmRooms].filter((room) => archived.has(room) === wantArchived)
  )

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
  const [lastMessages, unreadRows, dmNames, mentionRows] = await Promise.all([
    lastMessagePerRoom(rooms),
    unreadPerRoom(uid, rooms),
    dmPeerNames(uid, rooms),
    unreadMentionsPerRoom(uid, rooms)
  ])

  // A 1:1 DM lists once it holds a message. Opening a conversation writes a
  // membership row (the read watermark), so every person someone ever clicked
  // on would otherwise sit in the sidebar forever as an empty "direct message".
  const listed = rooms.filter((room) => !room.startsWith('dm:') || lastMessages.has(room))

  const out: RoomSummary[] = listed.map((room) => {
    const parsed = parseRoom(room)
    const membership = byRoom.get(room)
    const channel =
      parsed.kind === 'channel'
        ? chans.get(parsed.channelKey ?? '')
        : parsed.kind === 'global'
          ? general.channel
          : undefined
    return {
      room,
      kind: parsed.kind,
      // General's label is the host's own unless an admin renamed it.
      label:
        parsed.kind === 'global'
          ? general.customName
            ? general.channel.name
            : null
          : (channel?.name ?? dmNames.get(room) ?? null),
      channel: channel
        ? {
            id: channel.id,
            visibility: channel.visibility,
            role: channel.role,
            topic: channel.topic,
            created_by: channel.created_by,
            is_direct: channel.is_direct,
            icon: channel.icon ?? null,
            color: channel.color ?? null,
            announce: !!channel.announce,
            description: channel.description ?? null,
            links: channel.links ?? [],
            welcome_note: channel.welcome_note ?? null,
            default_roles: channel.default_roles ?? []
          }
        : null,
      starred: !!membership?.starred,
      welcome_seen_at: membership?.welcome_seen_at
        ? new Date(membership.welcome_seen_at).toISOString()
        : null,
      mentions: mentionRows.get(room) ?? 0,
      unread: unreadRows.get(room) ?? 0,
      muted: !!membership?.is_muted,
      notify_mode: (membership?.notify_mode === 'mentions' ? 'mentions' : 'all') as
        | 'all'
        | 'mentions',
      joined: !!membership,
      archived: archived.has(room),
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
async function lastMessagePerRoom(
  rooms: string[]
): Promise<Map<string, RoomSummary['last_message']>> {
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
      .select(
        'm.id',
        'm.room',
        'm.message',
        'm.sender',
        'm.sender_name',
        'm.date_created'
      )) as Array<Record<string, unknown>>
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
      .andWhere((qb) =>
        qb
          .whereNull('m.sender')
          .orWhereRaw('UPPER(CAST(m.sender AS NVARCHAR(36))) <> ?', [userId.toUpperCase()])
      )
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

/**
 * Unread messages per room that name this person: an explicit @mention
 * (stored ids, migration 370) or a room-wide @channel / @here.
 */
async function unreadMentionsPerRoom(
  userId: string,
  rooms: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (rooms.length === 0) return out
  const hasMentions = await hasColumnCached('chat_messages', 'mentions')
  const me = userId.toUpperCase()
  for (const chunk of chunked(rooms)) {
    const rows = (await db('chat_messages as m')
      .leftJoin('nivaro_chat_memberships as w', (j) =>
        j.on('w.room', '=', 'm.room').andOn(db.raw('w.[user] = ?', [userId]))
      )
      .whereIn('m.room', chunk)
      .whereNull('m.deleted_at')
      .andWhere((qb) =>
        qb.whereNull('m.sender').orWhereRaw('UPPER(CAST(m.sender AS NVARCHAR(36))) <> ?', [me])
      )
      .andWhere((qb) =>
        qb.whereNull('w.last_read_at').orWhereRaw('m.date_created > w.last_read_at')
      )
      .andWhere((qb) => {
        if (hasMentions) qb.where('m.mentions', 'like', `%${me}%`)
        qb.orWhere('m.message', 'like', '%@channel%').orWhere('m.message', 'like', '%@here%')
      })
      .groupBy('m.room')
      .select('m.room')
      .count({ n: 'm.id' })
      .catch(() => [])) as Array<{ room: string; n: number }>
    for (const r of rows) out.set(String(r.room), Number(r.n))
  }
  return out
}

const columnMemo = new Map<string, { at: number; v: boolean }>()
async function hasColumnCached(table: string, col: string): Promise<boolean> {
  const k = `${table}.${col}`
  const hit = columnMemo.get(k)
  if (hit && (hit.v || Date.now() - hit.at < 60_000)) return hit.v
  const { hasColumn } = await import('../lib/column-probe.js')
  const v = await hasColumn(table, col).catch(() => false)
  columnMemo.set(k, { at: Date.now(), v })
  return v
}

/**
 * Default channels per role (#960): a person joins every channel whose
 * default roles include theirs — once. The auto-join is recorded, so leaving
 * a default channel sticks; being moved into a new role joins that role's.
 * Runs lazily from the room list, memoised per person for ten minutes.
 */
const autoJoinChecked = new Map<string, number>()
export async function autoJoinDefaultChannels(user: User): Promise<void> {
  if (!user.role) return
  const key = `${user.id}|${user.role}`
  const at = autoJoinChecked.get(key)
  if (at && Date.now() - at < 10 * 60_000) return
  autoJoinChecked.set(key, Date.now())
  if (!(await hasColumnCached('nivaro_chat_channels', 'default_roles'))) return
  const role = String(user.role).toUpperCase()
  const general = await generalChannel()
  const wanted = [general, ...(await channels()).values()].filter(
    (c) => !c.is_archived && !c.is_direct && (c.default_roles ?? []).includes(role)
  )
  if (wanted.length === 0) return
  const done = new Set(
    (await db('nivaro_chat_auto_joins')
      .where({ user: user.id })
      .pluck('room')
      .catch(() => [])) as string[]
  )
  for (const c of wanted) {
    const room = c === general ? GLOBAL_ROOM : `ch:${c.key}`
    if (done.has(room)) continue
    try {
      await db('nivaro_chat_auto_joins').insert({ user: user.id, room, joined_at: new Date() })
    } catch {
      continue // already recorded by a concurrent request
    }
    const existing = await db('nivaro_chat_memberships').where({ user: user.id, room }).first()
    if (!existing) {
      await db('nivaro_chat_memberships')
        .insert({ user: user.id, room, joined_at: new Date(), last_read_at: new Date() })
        .catch(() => {})
    }
  }
}

/** MSSQL caps bound parameters at ~2100. */
function* chunked<T>(items: T[], size = 500): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

// ── Channel directory ───────────────────────────────────────────────────────

export interface DirectoryChannel extends ChatChannel {
  /** The room key a client joins/opens — `ch:<key>`, or `global` for General. */
  room: string
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
  // General rides the directory as id 0 (never a nivaro_chat_channels row).
  const generalBase = await generalChannel()
  const general: ChatChannel = {
    ...generalBase,
    topic: generalBase.topic ?? 'Everyone — join to see it in your sidebar'
  }
  const all = [
    general,
    ...[...(await channels()).values()].filter((c) => !c.is_archived && !c.is_direct)
  ]
  const roomOf = (c: ChatChannel) => (c === general ? GLOBAL_ROOM : `ch:${c.key}`)
  const mine = new Set(
    (await db('nivaro_chat_memberships').where('user', user.id).pluck('room')) as string[]
  )
  const term = search?.trim().toLowerCase()
  const visible = all.filter((c) => {
    if (c.visibility === 'open') return true
    // Same rule as canSeeRoom: membership admits you regardless of kind.
    if (mine.has(roomOf(c))) return true
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
      .whereIn('room', filtered.map(roomOf))
      .groupBy('room')
      .select('room')
      .count({ n: 'id' })) as Array<{ room: string; n: number }>
    for (const r of rows) counts.set(String(r.room), Number(r.n))
  }

  return filtered
    .map((c) => ({
      ...c,
      room: roomOf(c),
      joined: mine.has(roomOf(c)),
      members: counts.get(roomOf(c)) ?? 0
    }))
    .sort((a, b) => {
      // General leads; the rest alphabetical.
      if (a.room === GLOBAL_ROOM) return -1
      if (b.room === GLOBAL_ROOM) return 1
      return a.name.localeCompare(b.name)
    })
}

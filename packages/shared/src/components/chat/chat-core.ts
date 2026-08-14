import { readItems } from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch as patch2, post } from '../../lib/commands'

/**
 * Nivaro chat — data layer.
 *
 * Messages, rooms and watermarks go through /api/chat, NOT plain /items: room
 * visibility (your DMs, the channels you belong to, entity rooms for records
 * you can read) cannot be expressed as a table-level policy, and the items API
 * now refuses these collections outright. Presence/typing stay on /items,
 * which is per-user by nature. Live delivery comes from a host-provided
 * realtime adapter, with polling fallbacks baked into every query.
 *
 * Ported from the EFP implementation with its semantics preserved:
 * - DM room keys are 'dm:<A>:<B>' with UPPERCASED sorted uuids (MSSQL returns
 *   uuids uppercased — a casing mismatch forks a second room).
 * - Read watermarks are serialized per room (markInFlight) because the reads
 *   table has UNIQUE(user, room) and the room view marks on entry AND on each
 *   new message — concurrent select-then-insert would 500 on duplicate key.
 * - Mentions store '@[Display Name]' with no id; notifications fire only for
 *   users picked from the autocomplete.
 */

export interface ChatMessage {
  id: number
  sender: string
  sender_name: string | null
  room: string
  message: string
  date_created: string
}

export interface ChatOnlineUser {
  user_id: string
  display_name: string | null
  role_name?: string | null
  current_path?: string | null
  /** Reported by the client: a tab left open is not the same as being here. */
  is_idle?: boolean
  last_active?: string | null
}

export interface ChatConfig {
  collections: { messages: string; reads: string; presence: string }
  globalRoom: string
  globalLabel: string
  /** Entity-id pattern rendered as record links (RegExp source, global flags applied). */
  entityPattern: string
  /** URL for an entity token (null = plain text). */
  entityUrl: (token: string) => string | null
  /** Label for a non-global, non-dm room key (null = uppercased key). */
  roomLabel?: (room: string) => string | null
  /** Host route for a resolved record (entity rooms' "Open record" action) —
   *  admin passes /collections/:c/:id, efp-new /records/:c/:id. Absent = the
   *  admin shape; return null = hide the action. */
  recordUrl?: (collection: string, id: string | number) => string | null
  /** Host route for a session replay (the online list's admin-only "watch
   *  session" action). Absent = admin's /session-replays shape; return null =
   *  hide the action, which is what a host without a replay page wants. */
  sessionUrl?: (recordingId: string, userId: string) => string | null
  /** Live updates: subscribe to a collection's change feed; return unsubscribe.
   *  Still used for presence/typing, which remain plain /items collections. */
  realtime?: (collection: string, cb: () => void) => () => void
  /**
   * Live chat delivery: join the given rooms' socket rooms and call back on a
   * `chat:message` event. Replaces invalidating on every chat_messages write
   * anywhere — at channel scale that fan-out is a broadcast storm, and the
   * server only emits to `chat:<room>` now. Without it the queries still poll.
   */
  subscribeRooms?: (rooms: string[], cb: (msg: ChatMessage) => void) => () => void
  me: { id: string; name: string } | null
  /** Online users (presence) — drives the Online tab + mention autocomplete. */
  onlineUsers: ChatOnlineUser[]
  /** Presence typing setter (userId, room|null). */
  setTypingRoom?: (userId: string, room: string | null) => void | Promise<void>
  navigate?: (url: string) => void
  sound: boolean
}

export const ChatConfigContext = createContext<ChatConfig | null>(null)

export function useChatConfig(): ChatConfig {
  const cfg = useContext(ChatConfigContext)
  if (!cfg) throw new Error('Chat components must be wrapped in <ChatProvider>')
  return cfg
}

export const CHAT_DEFAULTS = {
  collections: { messages: 'chat_messages', reads: 'chat_last_read', presence: 'user_presence' },
  globalRoom: 'global',
  globalLabel: 'General',
  entityPattern: String.raw`\b([A-Za-z]{2,4}\d{2}(?:INV)?-\d+)\b`,
  sound: true
}

// ── Room keys ─────────────────────────────────────────────────────────────────

export function dmRoom(a: string, b: string): string {
  return `dm:${[a.toUpperCase(), b.toUpperCase()].sort().join(':')}`
}

export function dmPeer(room: string, self: string): string | null {
  if (!room.startsWith('dm:')) return null
  const rest = room.slice(3)
  const ids = [rest.slice(0, 36), rest.slice(37)]
  return ids.find((i) => i.toLowerCase() !== self.toLowerCase()) ?? null
}

// ── Sound (inline WebAudio chirp — no asset) ─────────────────────────────────

let audioCtx: AudioContext | null = null
let lastChirp = 0
export function playChirp() {
  if (typeof window === 'undefined') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const now = Date.now()
  if (now - lastChirp < 1500) return
  lastChirp = now
  try {
    audioCtx ??= new AudioContext()
    const ctx = audioCtx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(1318.5, ctx.currentTime + 0.18)
    gain.gain.setValueAtTime(0.06, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.36)
  } catch {
    /* audio locked — fine */
  }
}

// ── Messages ─────────────────────────────────────────────────────────────────

/**
 * Invalidate on a chat message in any of `rooms`. Falls back to the generic
 * collection feed when the host has not wired per-room sockets, so an older
 * host keeps working (just noisier).
 */
function useChatRealtime(keys: string[][], rooms?: string[]) {
  const cfg = useChatConfig()
  const qc = useQueryClient()
  const roomKey = (rooms ?? []).join('|')
  useEffect(() => {
    const invalidate = () => {
      for (const k of keys) void qc.invalidateQueries({ queryKey: k })
    }
    if (cfg.subscribeRooms) return cfg.subscribeRooms(rooms ?? [], invalidate)
    if (cfg.realtime) return cfg.realtime(cfg.collections.messages, invalidate)
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.subscribeRooms, cfg.realtime, roomKey, qc])
}

function useRealtimeInvalidate(collection: string, keys: string[][]) {
  const cfg = useChatConfig()
  const qc = useQueryClient()
  useEffect(() => {
    if (!cfg.realtime) return
    return cfg.realtime(collection, () => {
      for (const k of keys) void qc.invalidateQueries({ queryKey: k })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.realtime, collection, qc])
}

export function useChatMessages(room: string | null) {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat', room],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: ChatMessage[] }>('/chat/messages', { room, limit: 80 })
      )) as { data: ChatMessage[] }
      // Already oldest-first from the server.
      return res.data ?? []
    },
    enabled: !!room,
    staleTime: 5_000,
    refetchInterval: cfg.realtime ? undefined : 10_000
  })
  useChatRealtime([['nvr-chat'], ['nvr-chat-rooms']], room ? [room] : [])
  return { messages: data ?? [], loading: isLoading }
}

export function useSendChatMessage(room: string) {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: string | { text: string; mentions?: string[] }) => {
      const { text, mentions } = typeof input === 'string' ? { text: input, mentions: [] } : input
      // The server stamps sender/sender_name from the session and fans the
      // mention notifications out itself, skipping anyone who cannot see the
      // room — a client-supplied sender was always a fiction anyway.
      await client.request(post('/chat/messages', { room, message: text, mentions }))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-chat', room] })
      void qc.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
    }
  })
}

// ── Rooms + unread ───────────────────────────────────────────────────────────

export interface RoomInfo {
  room: string
  label: string
  kind: 'global' | 'dm' | 'channel' | 'entity'
  lastMessage: ChatMessage | null
  unread: number
  muted: boolean
  joined: boolean
  channel: ChannelMeta | null
}

export interface ChannelMeta {
  id: number
  visibility: 'open' | 'role' | 'private'
  role: string | null
  topic: string | null
  created_by: string | null
}

interface ServerRoom {
  room: string
  kind: RoomInfo['kind'] | 'unknown'
  label: string | null
  unread: number
  muted: boolean
  joined: boolean
  channel: ChannelMeta | null
  last_message: ChatMessage | null
}

/**
 * The sidebar. The server decides WHICH rooms (visibility) and computes unread
 * in SQL against the watermark; the client only labels them. The old version
 * pulled the last 500 messages globally and grouped them here, which both
 * leaked other people's rooms and silently dropped quiet ones once a busy room
 * filled the window.
 */
export function useChatRooms() {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const me = cfg.me
  const query = useQuery({
    queryKey: ['nvr-chat-rooms', me?.id],
    queryFn: async () => {
      const res = (await client.request(get<{ data: ServerRoom[] }>('/chat/rooms'))) as {
        data: ServerRoom[]
      }
      return res.data ?? []
    },
    enabled: !!me,
    refetchInterval: 45_000,
    staleTime: 10_000
  })
  useChatRealtime([['nvr-chat-rooms']])

  const rooms: RoomInfo[] = useMemo(() => {
    const myId = me?.id?.toLowerCase() ?? ''
    const out = (query.data ?? []).map((r) => {
      const kind: RoomInfo['kind'] = r.kind === 'unknown' ? 'entity' : r.kind
      const label =
        kind === 'global'
          ? cfg.globalLabel
          : kind === 'dm'
            ? // The server resolves the peer's name from the user table; the
              // message sender is only a fallback for hosts that don't send one.
              (r.label ??
              (r.last_message?.sender?.toLowerCase() !== myId
                ? (r.last_message?.sender_name ?? null)
                : null) ??
              `User ${dmPeer(r.room, myId)?.slice(0, 8) ?? ''}`)
            : (r.label ?? cfg.roomLabel?.(r.room) ?? r.room.toUpperCase())
      return {
        room: r.room,
        label,
        kind,
        lastMessage: r.last_message,
        unread: r.unread,
        muted: r.muted,
        joined: r.joined,
        channel: r.channel ?? null
      }
    })
    if (!out.some((r) => r.room === cfg.globalRoom)) {
      out.push({
        room: cfg.globalRoom,
        label: cfg.globalLabel,
        kind: 'global',
        lastMessage: null,
        unread: 0,
        muted: false,
        joined: true,
        channel: null
      })
    }
    return out.sort((a, b) => {
      if (a.kind === 'global') return -1
      if (b.kind === 'global') return 1
      const ta = a.lastMessage ? new Date(a.lastMessage.date_created).getTime() : 0
      const tb = b.lastMessage ? new Date(b.lastMessage.date_created).getTime() : 0
      return tb - ta
    })
  }, [query.data, me?.id, cfg])

  // Muted rooms still show their count in the row, but they must not drive the
  // badge or the chirp.
  const totalUnread = rooms.reduce((s, r) => s + (r.muted ? 0 : r.unread), 0)
  return { rooms, totalUnread, loading: query.isLoading }
}

// ── Channel directory + membership ───────────────────────────────────────────

export interface DirectoryChannel {
  id: number
  key: string
  name: string
  topic: string | null
  visibility: 'open' | 'role' | 'private'
  role: string | null
  joined: boolean
  members: number
}

/** Browsable channels — what keeps the sidebar to joined rooms only. */
export function useChannelDirectory(search: string) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat-directory', search],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: DirectoryChannel[] }>('/chat/directory', search ? { search } : undefined)
      )) as { data: DirectoryChannel[] }
      return res.data ?? []
    },
    staleTime: 15_000
  })
  return { channels: data ?? [], loading: isLoading }
}

export function useRoomMembership() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
    void qc.invalidateQueries({ queryKey: ['nvr-chat-directory'] })
  }
  const join = useMutation({
    mutationFn: (room: string) => client.request(post(`/chat/rooms/${encodeURIComponent(room)}/join`)),
    onSuccess: refresh
  })
  const leave = useMutation({
    mutationFn: (room: string) => client.request(del(`/chat/rooms/${encodeURIComponent(room)}/join`)),
    onSuccess: refresh
  })
  const setMuted = useMutation({
    mutationFn: ({ room, muted }: { room: string; muted: boolean }) =>
      client.request(patch2(`/chat/rooms/${encodeURIComponent(room)}`, { muted })),
    onSuccess: refresh
  })
  return { join, leave, setMuted }
}

export interface ChannelMember {
  user: string
  first_name: string | null
  last_name: string | null
  email: string | null
  joined_at: string
}

/** Members of a channel — the owner-facing list for private channels. */
export function useChannelMembers(channelId: number | null) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat-members', channelId],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: ChannelMember[] }>(`/chat/channels/${channelId}/members`)
      )) as { data: ChannelMember[] }
      return res.data ?? []
    },
    enabled: channelId != null,
    staleTime: 10_000
  })
  return { members: data ?? [], loading: isLoading }
}

export function useChannelAdmin(channelId: number | null) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['nvr-chat-members', channelId] })
    void qc.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
    void qc.invalidateQueries({ queryKey: ['nvr-chat-directory'] })
  }
  const update = useMutation({
    mutationFn: (patch: {
      name?: string
      topic?: string | null
      visibility?: 'open' | 'role' | 'private'
      role?: string | null
      is_archived?: boolean
    }) => client.request(patch2(`/chat/channels/${channelId}`, patch)),
    onSuccess: refresh
  })
  const addMember = useMutation({
    mutationFn: (userId: string) =>
      client.request(post(`/chat/channels/${channelId}/members`, { user_id: userId })),
    onSuccess: refresh
  })
  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      client.request(del(`/chat/channels/${channelId}/members/${userId}`)),
    onSuccess: refresh
  })
  return { update, addMember, removeMember }
}

/** Id + name only — /api/roles is admin-gated, so the channel picker reads the
 *  chat route's own lightweight list. */
export function useChatRoles() {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-roles'],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: Array<{ id: string; name: string }> }>('/chat/roles')
      )) as { data: Array<{ id: string; name: string }> }
      return res.data ?? []
    },
    staleTime: 5 * 60_000
  })
  return data ?? []
}

/** Directory of users to add to a private channel. */
export function useUserSearch(search: string, enabled: boolean) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat-user-search', search],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }> }>(
          '/users',
          { limit: 20, ...(search.trim() ? { search: search.trim() } : {}) }
        )
      )) as { data: Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }> }
      return res.data ?? []
    },
    enabled,
    staleTime: 30_000
  })
  return { users: data ?? [], loading: isLoading }
}

export function useCreateChannel() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      name: string
      key?: string
      topic?: string
      visibility?: 'open' | 'role' | 'private'
      role?: string | null
    }) => client.request(post('/chat/channels', input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
      void qc.invalidateQueries({ queryKey: ['nvr-chat-directory'] })
    }
  })
}

/** Chirp when total unread grows (module-level watermark — mount once). */
let prevUnread = 0
export function useUnreadChirp(totalUnread: number) {
  const cfg = useChatConfig()
  useEffect(() => {
    if (cfg.sound && totalUnread > prevUnread) playChirp()
    prevUnread = totalUnread
  }, [totalUnread, cfg.sound])
}

// ── Read watermarks ──────────────────────────────────────────────────────────

/**
 * Mark read. The server upserts against UNIQUE(user, room), so the old
 * select-then-insert dance (and the per-room promise chain that stopped it
 * 500ing on duplicate key) is gone.
 */
export function useMarkRoomRead() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (room: string) =>
      client.request(post(`/chat/rooms/${encodeURIComponent(room)}/read`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
  })
}

// ── Entity-room record link ──────────────────────────────────────────────────

interface ChatRoomType {
  id: number
  prefix: string
  collection: string
  match_field: string
  is_active: boolean
}

/**
 * Resolves an entity room ('wf:CR26-76773') to the record's URL, host-routed
 * via cfg.recordUrl. The room-type registry maps the prefix to a collection +
 * match field; when the match field isn't the PK the record is looked up by
 * it (readable by construction — room visibility already required record
 * read). Null for non-entity rooms, unregistered prefixes, or when the record
 * doesn't resolve.
 */
export function useEntityRoomLink(room: string | null): string | null {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const idx = room?.indexOf(':') ?? -1
  const prefix = room && idx > 0 ? room.slice(0, idx) : null
  const token = room && idx > 0 ? room.slice(idx + 1) : null
  const isEntity =
    !!room && !!prefix && !!token && room !== cfg.globalRoom && prefix !== 'dm' && prefix !== 'ch'

  const { data: types } = useQuery({
    queryKey: ['nvr-chat-room-types'],
    queryFn: async () => {
      const res = (await client.request(get<{ data: ChatRoomType[] }>('/chat/room-types'))) as {
        data: ChatRoomType[]
      }
      return res.data ?? []
    },
    enabled: isEntity,
    staleTime: 5 * 60_000
  })
  const type = isEntity ? types?.find((t) => t.is_active && t.prefix === prefix) : undefined

  const { data: recordId } = useQuery({
    queryKey: ['nvr-chat-entity-record', type?.collection, type?.match_field, token],
    queryFn: async () => {
      if (type!.match_field === 'id') return token as string
      const res = (await client.request(
        get<{ data: Array<{ id: string | number }> }>(`/items/${type!.collection}`, {
          limit: 1,
          fields: 'id',
          filter: JSON.stringify({ [type!.match_field]: { _eq: token } })
        })
      )) as { data: Array<{ id: string | number }> }
      return res.data?.[0]?.id ?? null
    },
    enabled: !!type && !!token,
    staleTime: 5 * 60_000
  })

  if (!type || recordId == null) return null
  const build = cfg.recordUrl ?? ((c: string, id: string | number) => `/collections/${c}/${id}`)
  return build(type.collection, recordId)
}

// ── Message tokens (entities + mentions) ─────────────────────────────────────

const MENTION_RE = /@\[([^\]]+)\](?:\([^)]*\))?/g

export interface MessageToken {
  text: string
  entity?: string
  mention?: string
}

export function splitMessageTokens(text: string, entityPattern: string): MessageToken[] {
  const entityRe = new RegExp(entityPattern, 'gi')
  const marks: Array<{ start: number; end: number; token: MessageToken }> = []
  for (const m of text.matchAll(MENTION_RE)) {
    marks.push({
      start: m.index,
      end: m.index + m[0].length,
      token: { text: `@${m[1]}`, mention: m[1] }
    })
  }
  for (const m of text.matchAll(entityRe)) {
    if (marks.some((k) => m.index >= k.start && m.index < k.end)) continue
    marks.push({
      start: m.index,
      end: m.index + m[0].length,
      token: { text: m[0], entity: m[0].toUpperCase() }
    })
  }
  marks.sort((a, b) => a.start - b.start)
  const parts: MessageToken[] = []
  let last = 0
  for (const k of marks) {
    if (k.start > last) parts.push({ text: text.slice(last, k.start) })
    parts.push(k.token)
    last = k.end
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}

export function getMentionQuery(text: string, cursorPos: number): string | null {
  const before = text.slice(0, cursorPos)
  const match = before.match(/@([^@\n\r]*)$/)
  return match ? match[1] : null
}

// ── Typing indicator ─────────────────────────────────────────────────────────

const TYPING_IDLE_MS = 3_000

export function useTypingIndicator(room: string | null) {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const isTypingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const me = cfg.me

  const clearTyping = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    if (isTypingRef.current && me && cfg.setTypingRoom) {
      isTypingRef.current = false
      void cfg.setTypingRoom(me.id, null)
    }
  }, [me, cfg])

  const onType = useCallback(() => {
    if (!me || !room || !cfg.setTypingRoom) return
    if (!isTypingRef.current) {
      isTypingRef.current = true
      void cfg.setTypingRoom(me.id, room)
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(clearTyping, TYPING_IDLE_MS)
  }, [me, room, cfg, clearTyping])

  useEffect(() => clearTyping, [clearTyping])

  const { data } = useQuery({
    queryKey: ['nvr-chat-typing', room],
    queryFn: async () => {
      const since = new Date(Date.now() - 60_000).toISOString()
      const res = (await client.request(
        readItems<{
          user_id: string
          display_name: string | null
          typing_room?: string | null
          last_seen?: string
        }>(cfg.collections.presence, {
          limit: 10,
          fields: ['user_id', 'display_name', 'typing_room', 'last_seen'],
          filter: { typing_room: { _eq: room }, last_seen: { _gte: since } }
        })
      )) as { data: Array<{ user_id: string; display_name: string | null }> }
      return res.data ?? []
    },
    enabled: !!room && !!cfg.setTypingRoom,
    refetchInterval: 6_000,
    staleTime: 2_000
  })
  useRealtimeInvalidate(cfg.collections.presence, [['nvr-chat-typing']])

  const typingText = useMemo(() => {
    const myId = me?.id?.toLowerCase()
    const names = (data ?? [])
      .filter((u) => u.user_id?.toLowerCase() !== myId)
      .map((u) => u.display_name ?? 'Someone')
    if (names.length === 0) return null
    if (names.length === 1) return `${names[0]} is typing…`
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
    return `${names.length} people are typing…`
  }, [data, me?.id])

  return { onType, clearTyping, typingText }
}

// ── DM read receipt ──────────────────────────────────────────────────────────

export function usePeerReadAt(room: string | null): string | null {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const me = cfg.me
  const peerId = room && me ? dmPeer(room, me.id) : null
  const { data } = useQuery({
    queryKey: ['nvr-chat-peer-read', room],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: { last_read_at: string | null } }>(
          `/chat/rooms/${encodeURIComponent(room as string)}/peer-read`
        )
      )) as { data: { last_read_at: string | null } }
      return res.data?.last_read_at ?? null
    },
    enabled: !!peerId && !!room,
    refetchInterval: 30_000,
    staleTime: 5_000
  })
  useChatRealtime([['nvr-chat-peer-read']], room ? [room] : [])
  return data ?? null
}

// ── Avatar helpers ───────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#7dd3fc',
  '#86efac',
  '#fcd34d',
  '#f9a8d4',
  '#c4b5fd',
  '#fdba74',
  '#99f6e4',
  '#00ceff'
]

export function chatAvatarColor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

export function chatInitials(name: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

// ─── DM launcher registry ────────────────────────────────────────────────────
// Lets components OUTSIDE the chat provider tree (UserChip's contact card,
// rosters…) open a direct-message conversation. The host's chat dock
// registers an opener on mount; UserChip shows its "Send message" action only
// while one is registered, so hosts without chat simply don't offer it.
type DmOpener = (userId: string, displayName?: string) => void
let dmOpener: DmOpener | null = null

/** Register the host's DM opener. Returns an unregister function. */
export function registerDmOpener(fn: DmOpener): () => void {
  dmOpener = fn
  return () => {
    if (dmOpener === fn) dmOpener = null
  }
}

export function canOpenDm(): boolean {
  return dmOpener !== null
}

export function openDmWith(userId: string, displayName?: string): void {
  dmOpener?.(userId, displayName)
}

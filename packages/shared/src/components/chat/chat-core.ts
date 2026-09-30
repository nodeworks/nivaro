import { readItems } from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, patch as patch2, post } from '../../lib/commands'
import { playNotificationSound } from '../../lib/notification-sound'

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
 * Ported from the original host implementation with its semantics preserved:
 * - DM room keys are 'dm:<A>:<B>' with UPPERCASED sorted uuids (MSSQL returns
 *   uuids uppercased — a casing mismatch forks a second room).
 * - Read watermarks are serialized per room (markInFlight) because the reads
 *   table has UNIQUE(user, room) and the room view marks on entry AND on each
 *   new message — concurrent select-then-insert would 500 on duplicate key.
 * - Mentions store '@[Display Name]' with no id; notifications fire only for
 *   users picked from the autocomplete.
 */

export interface ChatReaction {
  emoji: string
  user: string
  user_name: string | null
}

export interface ChatMessage {
  id: number
  sender: string
  sender_name: string | null
  room: string
  message: string
  date_created: string
  edited_at?: string | null
  deleted_at?: string | null
  attachments?: string[]
  reactions?: ChatReaction[]
  /** The admin who was masquerading as the sender when it was sent. */
  masquerade_admin_name?: string | null
  /** Thread reply (#927): the root it answers. Null on the timeline. */
  parent_id?: number | null
  /** Quoted message (#928). */
  quote_id?: number | null
  quote?: {
    id: number
    sender_name: string | null
    message: string
    deleted: boolean
    has_attachments: boolean
  } | null
  /** Replies under this message (roots only). */
  thread?: {
    count: number
    last_reply_at: string | null
    people: Array<{ id: string; name: string | null }>
  } | null
  urgent?: boolean
  /** A platform line (record activity, flows) rather than a person. */
  is_system?: boolean
  /** The sender removed the link preview. */
  no_preview?: boolean
  client_id?: string | null
  mentions?: string[]
  /** Times written in the message, as stored instants (#962). */
  time_refs?: Array<{ text: string; at: string }>
}

/** Where a room view opens: the newest messages, or around a message / day. */
export type ChatAnchor = { around: number } | { date: string } | null

/** The reaction palette — mirrored server-side; anything else is rejected. */
export const REACTION_EMOJI = ['👍', '✅', '👀', '🎉', '❤️', '😂'] as const

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
   *  admin passes /collections/:c/:id, a portal its own record route. Absent = the
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

interface MessagesPage {
  data: ChatMessage[]
  meta?: { has_older: boolean; has_newer: boolean; anchor: number | null }
}

/**
 * A room's timeline (thread replies excluded). Opens on the newest messages,
 * or around a message / a day when `anchor` is given (#976, #977); older and
 * newer history loads on demand.
 */
export function useChatMessages(room: string | null, anchor: ChatAnchor = null) {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const anchorKey = anchor
    ? 'around' in anchor
      ? `around:${anchor.around}`
      : `date:${anchor.date}`
    : 'latest'
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat', room, anchorKey],
    queryFn: async () => {
      const params: Record<string, unknown> = { room, limit: anchor ? 80 : 80 }
      if (anchor && 'around' in anchor) params.around = anchor.around
      if (anchor && 'date' in anchor) params.date = anchor.date
      const res = (await client.request(
        get<MessagesPage>('/chat/messages', params)
      )) as MessagesPage
      return res
    },
    enabled: !!room,
    staleTime: 5_000,
    refetchInterval: cfg.realtime || cfg.subscribeRooms ? undefined : 10_000
  })
  useChatRealtime([['nvr-chat'], ['nvr-chat-rooms'], ['nvr-chat-thread']], room ? [room] : [])

  // Older pages loaded by scrolling up, kept per room + anchor.
  const [older, setOlder] = useState<ChatMessage[]>([])
  const [hasOlder, setHasOlder] = useState<boolean | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  useEffect(() => {
    setOlder([])
    setHasOlder(null)
  }, [room, anchorKey])
  const base = data?.data ?? []
  const messages = useMemo(() => {
    if (older.length === 0) return base
    const seen = new Set(base.map((m) => m.id))
    return [...older.filter((m) => !seen.has(m.id)), ...base]
  }, [older, base])
  const loadOlder = useCallback(async () => {
    if (!room || loadingOlder) return
    const first = messages[0]
    if (!first) return
    setLoadingOlder(true)
    try {
      const res = (await client.request(
        get<MessagesPage>('/chat/messages', { room, limit: 60, before: first.id })
      )) as MessagesPage
      setOlder((prev) => [...(res.data ?? []), ...prev])
      setHasOlder(!!res.meta?.has_older)
    } finally {
      setLoadingOlder(false)
    }
  }, [room, messages, client, loadingOlder])
  return {
    messages,
    loading: isLoading,
    hasOlder: hasOlder ?? !!data?.meta?.has_older,
    hasNewer: !!data?.meta?.has_newer,
    anchorId: data?.meta?.anchor ?? null,
    loadOlder,
    loadingOlder
  }
}

/** One thread: the root and its replies, oldest first (#927). */
export function useChatThread(room: string | null, rootId: number | null) {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat-thread', room, rootId],
    queryFn: async () => {
      const res = (await client.request(
        get<MessagesPage>('/chat/messages', { room, thread: rootId, limit: 300 })
      )) as MessagesPage
      return res.data ?? []
    },
    enabled: !!room && !!rootId,
    staleTime: 5_000,
    refetchInterval: cfg.realtime || cfg.subscribeRooms ? undefined : 10_000
  })
  useChatRealtime([['nvr-chat-thread']], room ? [room] : [])
  const all = data ?? []
  return {
    root: all.find((m) => m.id === rootId) ?? null,
    replies: all.filter((m) => m.id !== rootId),
    loading: isLoading
  }
}

export interface SendInput {
  text: string
  mentions?: string[]
  attachments?: string[]
  parentId?: number | null
  quoteId?: number | null
  urgent?: boolean
}

/**
 * Send through the outbox (#983, #984): the message shows at once as
 * "Sending…", a network failure keeps it queued and retries in order when the
 * connection is back, a refusal marks it failed with Retry. The client id rides
 * the request, so a retry of a send that actually landed is not posted twice.
 */
export function useSendChatMessage(room: string) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const cfg = useChatConfig()
  bindOutbox(client, qc, cfg.me?.id ?? null)
  const send = useCallback(
    (input: string | SendInput) => {
      const i: SendInput = typeof input === 'string' ? { text: input } : input
      enqueueOutbox({
        client_id: newClientId(),
        room,
        text: i.text,
        mentions: i.mentions ?? [],
        attachments: i.attachments ?? [],
        parent_id: i.parentId ?? null,
        quote_id: i.quoteId ?? null,
        urgent: !!i.urgent,
        status: 'sending',
        error: null,
        created_at: new Date().toISOString(),
        sender: cfg.me?.id ?? '',
        sender_name: cfg.me?.name ?? null
      })
    },
    [room, cfg.me?.id, cfg.me?.name]
  )
  return { mutate: send, isPending: false }
}

// ── Outbox ───────────────────────────────────────────────────────────────────

export interface OutboxItem {
  client_id: string
  room: string
  text: string
  mentions: string[]
  attachments: string[]
  parent_id: number | null
  quote_id: number | null
  urgent: boolean
  status: 'sending' | 'queued' | 'failed'
  error: string | null
  created_at: string
  sender: string
  sender_name: string | null
}

const OUTBOX_KEY = 'nvr-chat-outbox'
let outbox: OutboxItem[] = []
const outboxListeners = new Set<() => void>()
let outboxClient: ReturnType<typeof useNivaroClient> | null = null
let outboxQc: ReturnType<typeof useQueryClient> | null = null
let outboxUser: string | null = null
let flushing = false
let retryTimer: ReturnType<typeof setTimeout> | null = null

function newClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function saveOutbox() {
  try {
    if (typeof localStorage === 'undefined' || !outboxUser) return
    const keep = outbox.filter((o) => o.sender === outboxUser)
    localStorage.setItem(`${OUTBOX_KEY}:${outboxUser}`, JSON.stringify(keep))
  } catch {
    /* storage is a convenience */
  }
}

function emitOutbox() {
  saveOutbox()
  for (const l of outboxListeners) l()
}

function bindOutbox(
  client: ReturnType<typeof useNivaroClient>,
  qc: ReturnType<typeof useQueryClient>,
  userId: string | null
) {
  outboxClient = client
  outboxQc = qc
  if (userId && userId !== outboxUser) {
    outboxUser = userId
    try {
      const raw = localStorage.getItem(`${OUTBOX_KEY}:${userId}`)
      const saved = raw ? (JSON.parse(raw) as OutboxItem[]) : []
      // Anything left from an earlier visit waits for a connection again.
      const known = new Set(outbox.map((o) => o.client_id))
      for (const o of saved)
        if (!known.has(o.client_id))
          outbox.push({ ...o, status: o.status === 'failed' ? 'failed' : 'queued' })
      if (saved.length) {
        emitOutbox()
        scheduleRetry(1000)
      }
    } catch {
      /* storage is a convenience */
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => scheduleRetry(0))
    }
  }
}

function enqueueOutbox(item: OutboxItem) {
  outbox.push(item)
  emitOutbox()
  void flushOutbox()
}

function scheduleRetry(ms: number) {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    for (const o of outbox) if (o.status === 'queued') o.status = 'sending'
    emitOutbox()
    void flushOutbox()
  }, ms)
}

function isNetworkError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (status == null) return true // fetch threw: no response at all
  return status === 0 || status === 502 || status === 503 || status === 504
}

/** Sends in order: one message at a time, and a queued earlier message holds
 *  the later ones in the same room back so they never arrive out of order. */
async function flushOutbox() {
  if (flushing || !outboxClient) return
  flushing = true
  try {
    const blocked = new Set<string>()
    for (const o of [...outbox]) {
      if (o.status === 'failed') continue
      if (blocked.has(o.room)) continue
      if (o.status === 'queued') {
        blocked.add(o.room)
        continue
      }
      try {
        const res = (await outboxClient.request(
          post('/chat/messages', {
            room: o.room,
            message: o.text,
            mentions: o.mentions,
            attachments: o.attachments,
            parent_id: o.parent_id,
            quote_id: o.quote_id,
            urgent: o.urgent,
            client_id: o.client_id
          })
        )) as { data?: ChatMessage }
        outbox = outbox.filter((x) => x.client_id !== o.client_id)
        const row = res?.data
        if (row && !o.parent_id) {
          outboxQc?.setQueryData<MessagesPage>(['nvr-chat', o.room, 'latest'], (prev) =>
            prev && !prev.data.some((m) => m.id === row.id)
              ? { ...prev, data: [...prev.data, row] }
              : prev
          )
        }
        void outboxQc?.invalidateQueries({ queryKey: ['nvr-chat', o.room] })
        void outboxQc?.invalidateQueries({ queryKey: ['nvr-chat-thread', o.room] })
        void outboxQc?.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
        emitOutbox()
      } catch (err) {
        if (isNetworkError(err)) {
          o.status = 'queued'
          o.error = 'Waiting for a connection'
          blocked.add(o.room)
          scheduleRetry(8000)
        } else {
          o.status = 'failed'
          const body = (err as { response?: { error?: string } })?.response
          o.error = body?.error ?? (err instanceof Error ? err.message : 'Could not send')
        }
        emitOutbox()
      }
    }
  } finally {
    flushing = false
  }
}

export function retryOutbox(clientId: string) {
  const o = outbox.find((x) => x.client_id === clientId)
  if (!o) return
  o.status = 'sending'
  o.error = null
  emitOutbox()
  void flushOutbox()
}

export function discardOutbox(clientId: string) {
  outbox = outbox.filter((x) => x.client_id !== clientId)
  emitOutbox()
}

/** Messages still on their way out for one room (or thread). */
export function useOutbox(room: string, parentId: number | null = null): OutboxItem[] {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    outboxListeners.add(l)
    return () => {
      outboxListeners.delete(l)
    }
  }, [])
  return outbox.filter((o) => o.room === room && (o.parent_id ?? null) === parentId)
}

// ── Rooms + unread ───────────────────────────────────────────────────────────

export interface RoomInfo {
  room: string
  label: string
  kind: 'global' | 'dm' | 'channel' | 'entity'
  lastMessage: ChatMessage | null
  unread: number
  muted: boolean
  notify_mode: 'all' | 'mentions'
  joined: boolean
  channel: ChannelMeta | null
  /** Put away by this person — lives in the Archived tab, never alerts. */
  archived?: boolean
  /** Pinned to the top of this person's list (#957). */
  starred?: boolean
  /** Unread messages that name this person. */
  mentions?: number
  welcome_seen_at?: string | null
}

export interface ChannelMeta {
  id: number
  visibility: 'open' | 'role' | 'private'
  role: string | null
  topic: string | null
  created_by: string | null
  is_direct?: boolean
  /** One of the fixed channel icons (ChannelLook.tsx); null = plain "#". */
  icon?: string | null
  /** #rrggbb from the fixed palette; null = neutral tile. */
  color?: string | null
  announce?: boolean
  description?: string | null
  links?: Array<{ label: string; url: string }>
  welcome_note?: string | null
  default_roles?: string[]
}

interface ServerRoom {
  room: string
  kind: RoomInfo['kind'] | 'unknown'
  label: string | null
  unread: number
  muted: boolean
  notify_mode?: 'all' | 'mentions'
  joined: boolean
  archived?: boolean
  starred?: boolean
  mentions?: number
  welcome_seen_at?: string | null
  channel: ChannelMeta | null
  last_message: ChatMessage | null
}

function toRoomInfos(data: ServerRoom[], meId: string | undefined, cfg: ChatConfig): RoomInfo[] {
  const myId = meId?.toLowerCase() ?? ''
  const out = data.map((r) => {
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
      notify_mode: r.notify_mode ?? 'all',
      joined: r.joined,
      channel: r.channel ?? null,
      archived: !!r.archived,
      starred: !!r.starred,
      mentions: r.mentions ?? 0,
      welcome_seen_at: r.welcome_seen_at ?? null
    }
  })
  // General is opt-in (joined from the directory) — no synthetic row when
  // the server left it out.
  return out.sort((a, b) => {
    if (a.kind === 'global') return -1
    if (b.kind === 'global') return 1
    const ta = a.lastMessage ? new Date(a.lastMessage.date_created).getTime() : 0
    const tb = b.lastMessage ? new Date(b.lastMessage.date_created).getTime() : 0
    return tb - ta
  })
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

  const rooms: RoomInfo[] = useMemo(
    () => toRoomInfos(query.data ?? [], me?.id, cfg),
    [query.data, me?.id, cfg]
  )

  // Muted rooms still show their count in the row, but they must not drive the
  // badge or the chirp. With "Conversations and mentions" (#966) channel
  // chatter drops out of the badge: only DMs, group DMs and mentions count.
  const badgeMode = useMyPreferences().chat_badge_mode
  const totalUnread = rooms.reduce((s, r) => {
    if (r.muted) return s
    if (badgeMode === 'conversations') {
      const convo = r.kind === 'dm' || (r.kind === 'channel' && !!r.channel?.is_direct)
      return s + (convo ? r.unread : (r.mentions ?? 0))
    }
    return s + r.unread
  }, 0)
  return { rooms, totalUnread, loading: query.isLoading }
}

/** Rooms this person archived — the Archived tab. Fetched only while shown. */
export function useArchivedRooms(enabled: boolean) {
  const cfg = useChatConfig()
  const client = useNivaroClient()
  const me = cfg.me
  const query = useQuery({
    queryKey: ['nvr-chat-rooms', me?.id, 'archived'],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: ServerRoom[] }>('/chat/rooms', { archived: '1' })
      )) as { data: ServerRoom[] }
      return res.data ?? []
    },
    enabled: !!me && enabled,
    staleTime: 10_000
  })
  const rooms = useMemo(() => toRoomInfos(query.data ?? [], me?.id, cfg), [query.data, me?.id, cfg])
  return { rooms, loading: query.isLoading }
}

// ── Channel directory + membership ───────────────────────────────────────────

export interface DirectoryChannel {
  id: number
  key: string
  /** Room key to join/open — `ch:<key>`, or `global` for General. */
  room: string
  name: string
  topic: string | null
  visibility: 'open' | 'role' | 'private'
  role: string | null
  joined: boolean
  members: number
  icon?: string | null
  color?: string | null
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
    mutationFn: (room: string) =>
      client.request(post(`/chat/rooms/${encodeURIComponent(room)}/join`)),
    onSuccess: refresh
  })
  const leave = useMutation({
    mutationFn: (room: string) =>
      client.request(del(`/chat/rooms/${encodeURIComponent(room)}/join`)),
    onSuccess: refresh
  })
  const setMuted = useMutation({
    mutationFn: ({ room, muted }: { room: string; muted: boolean }) =>
      client.request(patch2(`/chat/rooms/${encodeURIComponent(room)}`, { muted })),
    onSuccess: refresh
  })
  const setNotifyMode = useMutation({
    mutationFn: ({ room, mode }: { room: string; mode: 'all' | 'mentions' }) =>
      client.request(
        patch2(`/chat/rooms/${encodeURIComponent(room)}`, {
          notify_mode: mode === 'mentions' ? 'mentions' : null
        })
      ),
    onSuccess: refresh
  })
  const setArchived = useMutation({
    mutationFn: ({ room, archived }: { room: string; archived: boolean }) =>
      client.request(patch2(`/chat/rooms/${encodeURIComponent(room)}`, { archived })),
    onSuccess: refresh
  })
  const setStarred = useMutation({
    mutationFn: ({ room, starred }: { room: string; starred: boolean }) =>
      client.request(patch2(`/chat/rooms/${encodeURIComponent(room)}`, { starred })),
    onSuccess: refresh
  })
  const dismissWelcome = useMutation({
    mutationFn: (room: string) =>
      client.request(patch2(`/chat/rooms/${encodeURIComponent(room)}`, { welcome_seen: true })),
    onSuccess: refresh
  })
  return { join, leave, setMuted, setNotifyMode, setArchived, setStarred, dismissWelcome }
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
      icon?: string | null
      color?: string | null
      announce?: boolean
      description?: string | null
      links?: Array<{ label: string; url: string }>
      welcome_note?: string | null
      default_roles?: string[]
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
        get<{
          data: Array<{
            id: string
            first_name: string | null
            last_name: string | null
            email: string | null
          }>
        }>('/users', { limit: 20, ...(search.trim() ? { search: search.trim() } : {}) })
      )) as {
        data: Array<{
          id: string
          first_name: string | null
          last_name: string | null
          email: string | null
        }>
      }
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
      icon?: string | null
      color?: string | null
    }) => client.request(post('/chat/channels', input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
      void qc.invalidateQueries({ queryKey: ['nvr-chat-directory'] })
    }
  })
}

/**
 * Chirp and toast when unread grows (module-level watermarks — mount once).
 *
 * A sound alone says only "something happened": the person still has to open
 * the panel to learn what, which is the same work as not being told. Passing
 * the rooms lets the toast name the sender or channel, so it can be ignored on
 * sight when it does not matter.
 *
 * Per-room watermarks rather than a total, because two rooms each gaining one
 * message is indistinguishable from one gaining two if you only track the sum —
 * and the toast has to name a room. Muted rooms are excluded here exactly as
 * they are from the badge.
 */
let prevUnread = 0
const prevByRoom = new Map<string, number>()
/**
 * A room whose messages are addressed to ME: a DM, or a group DM (a private
 * channel rendered as a conversation). Channels and General never chirp or
 * toast per message — the bell counter is their only signal; @mentions there
 * arrive as notifications through notifyUser like everything else.
 */
function isConversation(r: RoomInfo): boolean {
  return r.kind === 'dm' || (r.kind === 'channel' && !!r.channel?.is_direct)
}

/**
 * Rooms a ChatRoomView is showing right now (refcounted — the dock and the
 * /chat page can both mount one). A message landing in a room the person is
 * already reading needs neither a toast nor a sound: they are looking at it,
 * and a toast there sits right on top of the composer.
 */
const openRooms = new Map<string, number>()

export function useOpenRoomRegistration(room: string | null | undefined) {
  useEffect(() => {
    if (!room) return
    openRooms.set(room, (openRooms.get(room) ?? 0) + 1)
    return () => {
      const n = (openRooms.get(room) ?? 1) - 1
      if (n <= 0) openRooms.delete(room)
      else openRooms.set(room, n)
    }
  }, [room])
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function isReading(room: string): boolean {
  return openRooms.has(room) && pageVisible()
}

/**
 * The person's own sound preference — `preferences.notification_sound`
 * ('off' | 'subtle' | 'chime'), the same setting the notification bell plays.
 * Shares the profile card's query key and shape, so changing it there applies
 * to chat at once. Unset reads as off, which is what the profile shows.
 */
export function useNotificationSoundPreference(): string {
  const raw = useMyPreferences().notification_sound
  return typeof raw === 'string' ? raw : 'off'
}

/**
 * The signed-in person's own preferences (`/users/me`), on the same query key
 * and shape the profile page uses, so a change in either place shows in both.
 */
export function useMyPreferences(): Record<string, unknown> {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-profile-prefs'],
    queryFn: () =>
      client
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>),
    staleTime: 60_000
  })
  return data ?? {}
}

/** Write one or more preference keys; the cached copy updates at once. */
export function useSetMyPreferences() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      client.request(patch2('/users/me/preferences', patch)),
    onMutate: (patch) => {
      const prev = qc.getQueryData<Record<string, unknown>>(['nvr-profile-prefs'])
      qc.setQueryData(['nvr-profile-prefs'], { ...(prev ?? {}), ...patch })
      return { prev }
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(['nvr-profile-prefs'], ctx.prev)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-profile-prefs'] })
      void qc.invalidateQueries({ queryKey: ['presence-online'] })
    }
  })
}

export function useUnreadChirp(totalUnread: number, rooms?: RoomInfo[]) {
  const cfg = useChatConfig()
  const soundPref = useNotificationSoundPreference()
  useEffect(() => {
    // Without rooms the hook only knows the total — keep the old behaviour.
    // Rooms the person is reading are left out of both the sound and the toast.
    const conversationUnread = rooms
      ? rooms
          .filter((r) => isConversation(r) && !isReading(r.room))
          .reduce((n, r) => n + r.unread, 0)
      : totalUnread
    const grew = conversationUnread > prevUnread
    if (cfg.sound && grew) playNotificationSound(soundPref)

    if (rooms) {
      // First pass seeds the watermarks; toasting then would announce every
      // unread that already existed when the app loaded.
      const seeded = prevByRoom.size > 0
      // With a conversation open the composer sits bottom-right, exactly where
      // toasts stack — show them at the top instead.
      const anyRoomOpen = openRooms.size > 0
      for (const r of rooms) {
        const before = prevByRoom.get(r.room) ?? 0
        if (seeded && !r.muted && isConversation(r) && r.unread > before && !isReading(r.room)) {
          const last = r.lastMessage
          const who = last?.sender_name ? String(last.sender_name).trim() : null
          toast(
            r.kind === 'dm'
              ? `New message from ${who || r.label}`
              : `New message in ${r.label}${who ? ` — ${who}` : ''}`,
            {
              description: last?.message
                ? String(last.message)
                    .replace(/<[^>]*>/g, '')
                    .slice(0, 90)
                : undefined,
              duration: 4000,
              ...(anyRoomOpen ? { position: 'top-center' as const } : {}),
              // Reading the message is the whole reason the toast exists, so
              // it opens the conversation — only when a host has somewhere to
              // open it, otherwise the click would do nothing.
              ...(canOpenChatRoom()
                ? {
                    className: 'cursor-pointer',
                    onDismiss: undefined,
                    action: {
                      label: 'Open',
                      onClick: () => openChatRoom(r.room, r.label)
                    }
                  }
                : {})
            }
          )
        }
        prevByRoom.set(r.room, r.unread)
      }
    }

    prevUnread = conversationUnread
  }, [totalUnread, cfg.sound, rooms, soundPref])
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
 * Resolves an entity room ('<prefix>:<token>') to the record's URL, host-routed
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

// ── Message actions ──────────────────────────────────────────────────────────

export function useToggleReaction(room: string) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: number; emoji: string }) =>
      client.request(post(`/chat/messages/${messageId}/reactions`, { emoji })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-chat', room] })
  })
}

export function useEditMessage(room: string) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ messageId, text }: { messageId: number; text: string }) =>
      client.request(patch2(`/chat/messages/${messageId}`, { message: text })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-chat', room] })
  })
}

export function useDeleteMessage(room: string) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (messageId: number) => client.request(del(`/chat/messages/${messageId}`)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-chat', room] })
      void qc.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
    }
  })
}

// ── Cross-room message search ────────────────────────────────────────────────

export interface ChatSearchHit {
  id: number
  parent_id?: number | null
  room: string
  sender: string | null
  sender_name: string | null
  message: string
  date_created: string
}

/** Search every room in MY sidebar (server enforces visibility by
 *  construction — the room set is the user's own). */
export interface ChatSearchFilters {
  sender?: string | null
  room?: string | null
  from?: string | null
  to?: string | null
  has_attachment?: boolean
  mentions_me?: boolean
}

export function useChatSearch(q: string, filters: ChatSearchFilters = {}) {
  const client = useNivaroClient()
  const params: Record<string, string> = { q }
  if (filters.sender) params.sender = filters.sender
  if (filters.room) params.room = filters.room
  if (filters.from) params.from = filters.from
  if (filters.to) params.to = filters.to
  if (filters.has_attachment) params.has_attachment = '1'
  if (filters.mentions_me) params.mentions_me = '1'
  const filtered = Object.keys(params).length > 1
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat-search', params],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: ChatSearchHit[] }>('/chat/search', params)
      )) as {
        data: ChatSearchHit[]
      }
      return res.data ?? []
    },
    enabled: q.trim().length >= 2 || filtered,
    staleTime: 15_000
  })
  return { hits: data ?? [], loading: isLoading }
}

// ── Group DMs ────────────────────────────────────────────────────────────────

export function useCreateGroupDm() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { user_ids: string[]; name?: string }) => {
      const res = (await client.request(post('/chat/group-dm', input))) as {
        data: { room: string; name: string }
      }
      return res.data
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-chat-rooms'] })
  })
}

// ── Instance chat config (AI bot name) ───────────────────────────────────────

export interface ChatBotInfo {
  bot_name: string | null
  bot_user_id: string | null
}

export function useChatBotInfo(): ChatBotInfo {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-config'],
    queryFn: async () => {
      const res = (await client.request(get<{ data: ChatBotInfo }>('/chat/config'))) as {
        data: ChatBotInfo
      }
      return res.data ?? { bot_name: null, bot_user_id: null }
    },
    staleTime: 5 * 60_000
  })
  return data ?? { bot_name: null, bot_user_id: null }
}

export function useChatBotName(): string | null {
  return useChatBotInfo().bot_name
}

// ── Pinned messages ──────────────────────────────────────────────────────────

export interface PinnedMessage {
  pin_id: number
  id: number
  sender_name: string | null
  message: string
  date_created: string
}

export function useRoomPins(room: string | null) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-pins', room],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: PinnedMessage[] }>(`/chat/rooms/${encodeURIComponent(room as string)}/pins`)
      )) as { data: PinnedMessage[] }
      return res.data ?? []
    },
    enabled: !!room,
    staleTime: 15_000
  })
  useChatRealtime([['nvr-chat-pins']], room ? [room] : [])
  return data ?? []
}

export function useTogglePin(room: string) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (messageId: number) => client.request(post(`/chat/messages/${messageId}/pin`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-chat-pins', room] })
  })
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

/**
 * Same idea for a ROOM rather than a person: a new-message toast has to be able
 * to open the conversation it is about, and that may be a channel or an entity
 * room, not only a DM. The host's dock registers this; without one the toast
 * stays a notification instead of pretending to be clickable.
 */
type RoomOpener = (room: string, label?: string) => void
let roomOpener: RoomOpener | null = null

export function registerRoomOpener(fn: RoomOpener): () => void {
  roomOpener = fn
  return () => {
    if (roomOpener === fn) roomOpener = null
  }
}

export function canOpenChatRoom(): boolean {
  return roomOpener !== null
}

export function openChatRoom(room: string, label?: string): void {
  roomOpener?.(room, label)
}

// ── Record rooms outside the chat tree ───────────────────────────────────────

export interface RecordRoomType {
  prefix: string
  collection: string
  match_field: string
  is_active: boolean
}

/** Active entity-room registrations. Shared cache key + shape with the record
 *  header's chat button, so a list and a record form ask once between them. */
export function useRecordRoomTypes(enabled = true): RecordRoomType[] | undefined {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-room-types'],
    queryFn: async () => {
      const res = (await client.request(get<{ data: RecordRoomType[] }>('/chat/room-types'))) as {
        data: RecordRoomType[]
      }
      return (res.data ?? []).filter((t) => t.is_active)
    },
    enabled,
    staleTime: 5 * 60_000
  })
  return data
}

/** Open a record's chat room from anywhere a record id is known (#968): the
 *  server resolves the room (and says no when the viewer may not see it). */
export async function discussRecord(
  client: ReturnType<typeof useNivaroClient>,
  collection: string,
  item: string
): Promise<boolean> {
  const res = (await client.request(
    get<{ data: { room: string } | null }>('/chat/record-room', { collection, item })
  )) as { data: { room: string } | null }
  if (!res.data?.room) return false
  const token = res.data.room.slice(res.data.room.indexOf(':') + 1)
  openChatRoom(res.data.room, token)
  return true
}

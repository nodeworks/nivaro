import { Bookmark,
  Bell,
  BellOff,
  HelpCircle,
  Check,
  CheckCheck,
  ChevronLeft,
  ExternalLink,
  Hash,
  Lock,
  LogOut,
  MessageCircle,
  ClipboardPlus,
  Paperclip,
  Pencil,
  Pin,
  Video,
  Plus,
  PlayCircle,
  Search,
  Send,
  Settings,
  SmilePlus,
  Trash2,
  Users,
  X
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useItemEditAuth, useNavigation, useNivaroClient } from '../../context'
import { toast } from 'sonner'
import { get, patch as patchCmd, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { FilePreviewLightbox, type PreviewFile } from '../FilePreviewLightbox'
import {
  CHAT_DEFAULTS,
  type ChatConfig,
  ChatConfigContext,
  type ChatMessage,
  type ChatOnlineUser,
  type RoomInfo,
  chatAvatarColor,
  chatInitials,
  dmPeer,
  dmRoom,
  getMentionQuery,
  splitMessageTokens,
  type ChannelMeta,
  type DirectoryChannel,
  REACTION_EMOJI,
  useChannelAdmin,
  useChannelDirectory,
  useChannelMembers,
  useChatBotInfo,
  useChatBotName,
  useChatConfig,
  useChatRoles,
  useChatMessages,
  useChatRooms,
  useChatSearch,
  useCreateChannel,
  useCreateGroupDm,
  useDeleteMessage,
  useEditMessage,
  useEntityRoomLink,
  useMarkRoomRead,
  useRoomMembership,
  useRoomPins,
  useToggleReaction,
  useTogglePin,
  useUserSearch,
  usePeerReadAt,
  useSendChatMessage,
  useTypingIndicator
} from './chat-core'

/**
 * Nivaro chat UI — a complete team panel (Online tab, grouped rooms, live
 * conversations with mentions, typing, receipts, search).
 *
 * Theming: every visual slot reads from `ChatTheme` (className strings) with
 * nvr-cyan defaults — pass `theme` overrides on ChatProvider to restyle
 * without forking. Structural hooks: `data-chat-*` attributes on every major
 * element, `renderMessageBody` to override message rendering entirely.
 */

export interface ChatTheme {
  /** My message bubble. */
  bubbleMine: string
  /** Others' message bubble. */
  bubbleOther: string
  /** Accent text (links, read receipt, active states). */
  accentText: string
  /** Soft accent fill (active tab, selected candidate, mention highlight). */
  accentSoft: string
  /** Unread pill. */
  pill: string
  /** Primary action (send button). */
  action: string
  /** Panel/popover surface. */
  surface: string
  /** Input fields. */
  input: string
  /** Divider borders. */
  divider: string
}

const DEFAULT_THEME: ChatTheme = {
  bubbleMine: 'bg-nvr-cyan text-white',
  bubbleOther: 'bg-slate-100 text-slate-800 dark:bg-muted dark:text-slate-100',
  accentText: 'text-nvr-navy dark:text-nvr-cyan',
  accentSoft: 'bg-[#00ceff1a] text-nvr-navy dark:text-nvr-cyan',
  pill: 'bg-nvr-cyan text-white',
  action: 'bg-nvr-cyan text-white',
  surface: 'bg-white dark:bg-card',
  input:
    'border-slate-200 bg-slate-50 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100',
  divider: 'border-slate-100 dark:border-border/60'
}

const ChatThemeContext = ({} as { current: ChatTheme })
ChatThemeContext.current = DEFAULT_THEME

export interface ChatProviderProps {
  children: React.ReactNode
  me: ChatConfig['me']
  onlineUsers?: ChatOnlineUser[]
  collections?: Partial<ChatConfig['collections']>
  globalRoom?: string
  globalLabel?: string
  entityPattern?: string
  entityUrl?: ChatConfig['entityUrl']
  roomLabel?: ChatConfig['roomLabel']
  recordUrl?: ChatConfig['recordUrl']
  sessionUrl?: ChatConfig['sessionUrl']
  realtime?: ChatConfig['realtime']
  subscribeRooms?: ChatConfig['subscribeRooms']
  setTypingRoom?: ChatConfig['setTypingRoom']
  navigate?: ChatConfig['navigate']
  sound?: boolean
  theme?: Partial<ChatTheme>
}

export function ChatProvider({
  children,
  me,
  onlineUsers = [],
  collections,
  globalRoom = CHAT_DEFAULTS.globalRoom,
  globalLabel = CHAT_DEFAULTS.globalLabel,
  entityPattern = CHAT_DEFAULTS.entityPattern,
  entityUrl = () => null,
  roomLabel,
  recordUrl,
  sessionUrl,
  realtime,
  subscribeRooms,
  setTypingRoom,
  navigate,
  sound = true,
  theme
}: ChatProviderProps) {
  const cfg: ChatConfig = useMemo(
    () => ({
      collections: { ...CHAT_DEFAULTS.collections, ...collections },
      globalRoom,
      globalLabel,
      entityPattern,
      entityUrl,
      roomLabel,
      recordUrl,
      sessionUrl,
      realtime,
      subscribeRooms,
      me,
      onlineUsers,
      setTypingRoom,
      navigate,
      sound
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      me?.id,
      onlineUsers,
      collections,
      globalRoom,
      globalLabel,
      entityPattern,
      realtime,
      setTypingRoom,
      sound
    ]
  )
  ChatThemeContext.current = { ...DEFAULT_THEME, ...theme }
  return <ChatConfigContext.Provider value={cfg}>{children}</ChatConfigContext.Provider>
}

function useTheme(): ChatTheme {
  return ChatThemeContext.current
}

function Avatar({ id, name, size = 32 }: { id: string; name: string | null; size?: number }) {
  return (
    <span
      className='flex shrink-0 items-center justify-center rounded-full font-semibold text-[#04263b]'
      style={{ width: size, height: size, backgroundColor: chatAvatarColor(id), fontSize: size * 0.36 }}
      aria-hidden
    >
      {chatInitials(name)}
    </span>
  )
}

/**
 * Live record chip for an entity token inside a message — the token plus the
 * record's CURRENT pipeline state as a colored pill, resolved lazily and
 * cached per token. Falls back to the plain link when the token doesn't
 * resolve (unregistered prefix, no record, no pipeline).
 */
function EntityChip({ token, url, mine }: { token: string; url: string | null; mine?: boolean }) {
  const cfg = useChatConfig()
  const th = useTheme()
  const client = useNivaroClient()

  const { data: types } = useQuery({
    queryKey: ['nvr-chat-room-types'],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: Array<{ prefix: string; collection: string; match_field: string; is_active: boolean }> }>(
          '/chat/room-types'
        )
      )) as { data: Array<{ prefix: string; collection: string; match_field: string; is_active: boolean }> }
      return (res.data ?? []).filter((t) => t.is_active)
    },
    staleTime: 5 * 60_000
  })

  const { data: card } = useQuery({
    queryKey: ['nvr-chat-entity-card', token],
    queryFn: async () => {
      for (const t of types ?? []) {
        try {
          const res = (await client.request(
            get<{ data: Array<{ id: string | number }> }>(`/items/${t.collection}`, {
              limit: 1,
              fields: 'id',
              filter: JSON.stringify({ [t.match_field]: { _eq: token } })
            })
          )) as { data: Array<{ id: string | number }> }
          const id = res.data?.[0]?.id
          if (id == null) continue
          const inst = (await client.request(
            get<{ data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null }>(
              `/pipelines/instance/${t.collection}/${id}`
            )
          )) as { data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null }
          const state = inst.data?.instance?.current_state_obj
          return {
            collection: t.collection,
            id,
            state: state?.label ?? null,
            color: state?.color ?? null
          }
        } catch {
          /* try the next registered type */
        }
      }
      return null
    },
    enabled: (types?.length ?? 0) > 0,
    staleTime: 10 * 60_000
  })

  const open = () => {
    if (card) {
      const build = cfg.recordUrl ?? ((c: string, id: string | number) => `/collections/${c}/${id}`)
      const href = build(card.collection, card.id)
      if (href) {
        cfg.navigate?.(href)
        return
      }
    }
    if (url) cfg.navigate?.(url)
  }

  return (
    <button
      type='button'
      onClick={open}
      className={cn(
        'inline-flex max-w-full items-center gap-1 align-baseline font-medium underline-offset-2 hover:underline',
        mine ? 'underline' : th.accentText
      )}
      data-chat-entity={token}
    >
      {token}
      {card?.state && (
        <span
          className='inline-flex items-center rounded-full px-1.5 py-px text-[9px] font-semibold leading-tight'
          style={{
            backgroundColor: card.color ? `${card.color}26` : 'rgba(100,116,139,.15)',
            color: mine ? undefined : (card.color ?? undefined)
          }}
        >
          {card.state}
        </span>
      )}
    </button>
  )
}

function MessageBody({ text, mine }: { text: string; mine?: boolean }) {
  const cfg = useChatConfig()
  const th = useTheme()
  const parts = useMemo(() => splitMessageTokens(text, cfg.entityPattern), [text, cfg.entityPattern])
  return (
    <>
      {parts.map((p, i) => {
        if (p.entity) {
          const url = cfg.entityUrl(p.entity)
          return <EntityChip key={i} token={p.text} url={url} mine={mine} />
        }
        if (p.mention) {
          return (
            <span
              key={i}
              className={cn('rounded px-0.5 font-semibold', mine ? 'bg-black/15' : th.accentSoft)}
            >
              {p.text}
            </span>
          )
        }
        return <span key={i}>{p.text}</span>
      })}
    </>
  )
}

function dateDivider(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * "How do I use this?" — the chat's power features (mentions, the AI bot,
 * live record chips, attachments, reactions, cross-room search) are invisible
 * until someone tells you. One popover tells you.
 */
function ChatTipsButton({ botName }: { botName: string | null }) {
  const th = useTheme()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  // Two label treatments: things you TYPE render as code chips, PLACES in the
  // UI render as plain labels — cramming prose like "Hover a message" into a
  // fake-code chip read as buttons that did nothing.
  const tips: Array<{ k: string; v: string; kind: 'code' | 'place' }> = [
    { k: '@name', kind: 'code', v: 'Mention someone — they get notified even with the panel closed.' },
    ...(botName
      ? [
          {
            k: `@${botName} …`,
            kind: 'code' as const,
            v: 'Ask the AI assistant anything about your data, right in the room.'
          }
        ]
      : []),
    {
      k: 'CR26-12345',
      kind: 'code',
      v: 'Type a workflow or request ID and it becomes a live card showing its current state — click it to open the record.'
    },
    {
      k: '📎 / paste',
      kind: 'code',
      v: 'Attach files, or paste a screenshot straight into the message box.'
    },
    {
      k: 'Hover a message',
      kind: 'place',
      v: 'React with an emoji; edit your own within 15 minutes; delete your own anytime.'
    },
    {
      k: 'Search box',
      kind: 'place',
      v: 'The box above your conversations searches rooms AND every message in them.'
    },
    {
      k: 'Record pages',
      kind: 'place',
      v: 'Workflows and requests have a "Chat" button in their header — discuss the record in its own room or send it to any conversation.'
    }
  ]
  return (
    <div ref={rootRef} className='relative flex items-center'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'rounded-md p-1 transition-colors',
          open ? th.accentSoft : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
        )}
        aria-label='Chat tips'
        title='Tips'
        data-chat-tips
      >
        <HelpCircle className='h-3.5 w-3.5' strokeWidth={2} />
      </button>
      {open && (
        <div
          className={cn(
            'absolute right-0 top-full z-30 mt-1 w-[420px] max-w-[92vw] rounded-xl border shadow-lg',
            th.surface,
            'border-slate-200 dark:border-border'
          )}
        >
          <p className='border-b border-slate-100 px-4 py-2.5 text-[12.5px] font-semibold text-slate-800 dark:border-border/60 dark:text-slate-100'>
            Things this chat can do
          </p>
          {/* Fixed label gutter — chips and place-labels align into one
              column, descriptions read as a second clean column. */}
          <div className='grid grid-cols-[122px_1fr] gap-x-3 gap-y-0 px-4 py-1.5'>
            {tips.map((t) => (
              <div key={t.k} className='col-span-2 grid grid-cols-subgrid border-b border-slate-100/70 py-2 last:border-b-0 dark:border-border/40'>
                {t.kind === 'code' ? (
                  <code
                    className={cn(
                      'h-fit w-fit self-start whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] font-semibold',
                      th.accentSoft
                    )}
                  >
                    {t.k}
                  </code>
                ) : (
                  <span className='self-start pt-0.5 text-[11px] font-semibold leading-snug text-slate-700 dark:text-slate-200'>
                    {t.k}
                  </span>
                )}
                <span className='text-[11.5px] leading-relaxed text-slate-600 dark:text-slate-300'>
                  {t.v}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Live subject card at the top of an entity room — the record's label and
 *  current state stay in view above the conversation about it. */
function EntityRoomCard({ room }: { room: string }) {
  const cfg = useChatConfig()
  const th = useTheme()
  const client = useNivaroClient()
  const idx = room.indexOf(':')
  const prefix = idx > 0 ? room.slice(0, idx) : null
  const token = idx > 0 ? room.slice(idx + 1) : null
  const isEntity =
    !!prefix && !!token && room !== cfg.globalRoom && prefix !== 'dm' && prefix !== 'ch'

  const { data: card } = useQuery({
    queryKey: ['nvr-chat-room-card', room],
    queryFn: async () => {
      const types = (await client.request(
        get<{ data: Array<{ prefix: string; collection: string; match_field: string; is_active: boolean; label: string | null }> }>(
          '/chat/room-types'
        )
      )) as { data: Array<{ prefix: string; collection: string; match_field: string; is_active: boolean; label: string | null }> }
      const t = (types.data ?? []).find((x) => x.is_active && x.prefix === prefix)
      if (!t) return null
      const rec = (await client.request(
        get<{ data: Array<{ id: string | number }> }>(`/items/${t.collection}`, {
          limit: 1,
          fields: 'id',
          filter: JSON.stringify({ [t.match_field]: { _eq: token } })
        })
      )) as { data: Array<{ id: string | number }> }
      const id = rec.data?.[0]?.id
      if (id == null) return null
      const inst = (await client.request(
        get<{ data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null }>(
          `/pipelines/instance/${t.collection}/${id}`
        )
      )) as { data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null }
      const state = inst.data?.instance?.current_state_obj
      return {
        collection: t.collection,
        type_label: t.label ?? t.collection.replace(/_/g, ' '),
        id,
        state: state?.label ?? null,
        color: state?.color ?? null
      }
    },
    enabled: isEntity,
    staleTime: 60_000
  })

  if (!isEntity || !card) return null
  const build = cfg.recordUrl ?? ((c: string, id: string | number) => `/collections/${c}/${id}`)
  const href = build(card.collection, card.id)
  return (
    <div
      className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-1.5', th.divider)}
      data-chat-room-card
    >
      <span className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
        {card.type_label}
      </span>
      <span className='truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
        {token}
      </span>
      {card.state && (
        <span
          className='rounded-full px-2 py-0.5 text-[10px] font-semibold'
          style={{
            backgroundColor: card.color ? `${card.color}26` : 'rgba(100,116,139,.15)',
            color: card.color ?? undefined
          }}
        >
          {card.state}
        </span>
      )}
      {href && (
        <button
          type='button'
          onClick={() => cfg.navigate?.(href)}
          className={cn('ml-auto text-[11px] font-medium hover:underline', th.accentText)}
        >
          Open
        </button>
      )}
    </div>
  )
}

export function ChatRoomView({
  room,
  label,
  onBack,
  onOpenSettings,
  renderMessageBody,
  initialUnread
}: {
  room: string
  label: string
  onBack: () => void
  /** Channel rooms only — opens members/visibility settings. */
  onOpenSettings?: () => void
  renderMessageBody?: (m: ChatMessage, ctx: { mine: boolean }) => React.ReactNode
  /** Unread count at open — anchors the "New messages" divider. */
  initialUnread?: number
}) {
  const cfg = useChatConfig()
  const th = useTheme()
  const client = useNivaroClient()
  const me = cfg.me
  const { messages, loading } = useChatMessages(room)
  const send = useSendChatMessage(room)
  const markRead = useMarkRoomRead()
  const typing = useTypingIndicator(room)
  const peerReadAt = usePeerReadAt(room.startsWith('dm:') ? room : null)
  // Entity rooms link back to their record, routed by the host (recordUrl).
  const recordLink = useEntityRoomLink(room)
  const toggleReaction = useToggleReaction(room)
  const pins = useRoomPins(room)
  const togglePin = useTogglePin(room)
  // Seen-by (#147): members' read watermarks — "Seen by N" under your own
  // messages in group rooms (channels/group DMs; 1:1 DMs keep the check).
  const isGroupRoom = room.startsWith('ch:')
  const { data: readMarks = [] } = useQuery<Array<{ user: string; last_read_at: string; name: string }>>({
    queryKey: ['chat-read-marks', room],
    queryFn: () =>
      client
        .request<{ data: Array<{ user: string; last_read_at: string; name: string }> }>(
          get(`/chat/rooms/${encodeURIComponent(room)}/read-marks`)
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    enabled: isGroupRoom,
    refetchInterval: isGroupRoom ? 30_000 : false,
    staleTime: 15_000
  })
  const seenBy = (msg: { date_created: string; sender?: string | null }) =>
    readMarks.filter(
      (mk) =>
        mk.user !== String(msg.sender ?? '') &&
        new Date(mk.last_read_at).getTime() >= new Date(msg.date_created).getTime()
    )
  // Saved messages (#148): personal cross-room bookmarks.
  const { data: savedRows = [] } = useQuery<Array<{ id: number }>>({
    queryKey: ['chat-saved'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number }> }>(get('/chat/saved'))
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 60_000
  })
  const savedIds = useMemo(() => new Set(savedRows.map((r) => r.id)), [savedRows])
  const toggleSave = useMutation({
    mutationFn: (mid: number) => client.request(post(`/chat/messages/${mid}/save`, {})),
    onSuccess: () => void qcRoom.invalidateQueries({ queryKey: ["chat-saved"] })
  })

  // Room catch-up (#346): AI "what you missed" for a busy unread backlog.
  const [catchup, setCatchup] = useState<string | null>(null)
  const catchupMut = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { summary: string | null; count: number } }>(
          post('/chat/rooms/summary', { room })
        )
        .then((r) => r.data),
    onSuccess: (d) => setCatchup(d?.summary ?? 'Not enough new messages to summarize.'),
    onError: () => setCatchup('Summary unavailable.')
  })
  // Entity-room record — powers "make task from message". Reads the room
  // card's cached resolution (same query key), so no extra fetch.
  const qcRoom = useQueryClient()
  const roomRecord = qcRoom.getQueryData<{ collection: string; id: string | number } | null>([
    'nvr-chat-room-card',
    room
  ])
  const makeTask = useMutation({
    mutationFn: async (m: ChatMessage) => {
      if (!roomRecord || !me) throw new Error('no record')
      await client.request(
        post('/tasks', {
          collection: roomRecord.collection,
          item: String(roomRecord.id),
          title: m.message.replace(/<[^>]*>/g, '').slice(0, 200),
          assignee: me.id
        })
      )
    },
    onSuccess: () => toast.success('Task created from message — assigned to you'),
    onError: () => toast.error('Could not create a task')
  })
  const [pinsOpen, setPinsOpen] = useState(false)
  const editMessage = useEditMessage(room)
  const deleteMessage = useDeleteMessage(room)
  // Admins may delete anyone's message (server enforces the same rule).
  const { isAdmin } = useItemEditAuth()
  const { setMuted, setNotifyMode } = useRoomMembership()
  const { rooms: allRooms } = useChatRooms()
  const roomInfo = allRooms.find((r) => r.room === room) ?? null
  const botName = useChatBotName()
  const [draft, setDraft] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [msgSearch, setMsgSearch] = useState('')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [pendingFiles, setPendingFiles] = useState<
    Array<{ id: string; name: string; type: string | null }>
  >([])
  const [uploadingFiles, setUploadingFiles] = useState(0)
  const [preview, setPreview] = useState<PreviewFile | null>(null)
  const [notifyMenuOpen, setNotifyMenuOpen] = useState(false)
  /** Set when MY message mentioned the bot — "…is thinking" until its reply
   *  arrives (or a timeout says it won't). The asker is the one staring at a
   *  silent room; everyone else just sees the reply land. */
  const [botAskedAt, setBotAskedAt] = useState<number | null>(null)
  const mentionMapRef = useRef(new Map<string, ChatOnlineUser>())
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const dividerRef = useRef<HTMLDivElement>(null)
  // Frozen at mount — markRead fires immediately, so the live rooms query
  // can't be the divider's source of truth.
  const initialUnreadRef = useRef(Math.max(0, initialUnread ?? 0))
  const firstScrollRef = useRef(false)

  useEffect(() => {
    if (!firstScrollRef.current && messages.length > 0) {
      firstScrollRef.current = true
      // Land the reader AT the "New messages" line, not past it.
      if (dividerRef.current) dividerRef.current.scrollIntoView({ block: 'center' })
      else endRef.current?.scrollIntoView({ block: 'end' })
      return
    }
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  // Bot "thinking" clears when a message FROM the bot lands after the ask,
  // or after 90s (model down, no key — the failure reply also clears it).
  useEffect(() => {
    if (!botAskedAt || !botName) return
    const replied = messages.some(
      (m) =>
        (m.sender_name ?? '').toLowerCase() === botName.toLowerCase() &&
        new Date(m.date_created).getTime() >= botAskedAt - 5_000
    )
    if (replied) {
      setBotAskedAt(null)
      return
    }
    const t = setTimeout(() => setBotAskedAt(null), 90_000)
    return () => clearTimeout(t)
  }, [botAskedAt, botName, messages])

  // Metadata for every attachment in the window, one query.
  const attachmentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const m of messages) for (const a of m.attachments ?? []) ids.add(a)
    return [...ids]
  }, [messages])
  const { data: attachmentMeta } = useQuery({
    queryKey: ['nvr-chat-attachments', attachmentIds.slice().sort().join('|')],
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: Array<{ id: string; filename_download: string | null; title: string | null; type: string | null; filesize: number | null }> }>(
          '/files',
          {
            filter: JSON.stringify({ id: { _in: attachmentIds } }),
            limit: String(attachmentIds.length),
            fields: 'id,filename_download,title,type,filesize'
          }
        )
      )) as { data: Array<{ id: string; filename_download: string | null; title: string | null; type: string | null; filesize: number | null }> }
      return new Map((res.data ?? []).map((f) => [f.id, f]))
    },
    enabled: attachmentIds.length > 0,
    staleTime: 5 * 60_000
  })

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return
    setUploadingFiles((n) => n + files.length)
    for (const f of files) {
      try {
        const result = await client.upload(f)
        setPendingFiles((prev) => [
          ...prev,
          { id: result.id, name: f.name, type: f.type || null }
        ])
      } catch {
        /* one failed upload shouldn't kill the rest */
      } finally {
        setUploadingFiles((n) => n - 1)
      }
    }
  }
  useEffect(() => {
    markRead.mutate(room)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, messages.length])

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    const people = cfg.onlineUsers
      .filter((u) => (u.display_name ?? '').toLowerCase().startsWith(q))
      .slice(0, 6)
    // The AI assistant answers in-room — offered alongside people when its
    // configured name matches what's being typed.
    if (botName && botName.toLowerCase().startsWith(q)) {
      return [{ user_id: '__bot__', display_name: botName } as ChatOnlineUser, ...people].slice(0, 6)
    }
    return people
  }, [mentionQuery, cfg.onlineUsers, botName])

  const selectMention = (u: ChatOnlineUser) => {
    const name = u.display_name ?? 'Unknown'
    const suffix = `@[${name}] `
    const at = draft.lastIndexOf(`@${mentionQuery ?? ''}`)
    setDraft(at !== -1 ? draft.slice(0, at) + suffix : draft + suffix)
    mentionMapRef.current.set(name, u)
    setMentionQuery(null)
    inputRef.current?.focus()
  }

  const submit = () => {
    const text = draft.trim()
    if (!text && pendingFiles.length === 0) return
    const attachments = pendingFiles.map((f) => f.id)
    setDraft('')
    setPendingFiles([])
    setMentionQuery(null)
    typing.clearTyping()
    // Mentions ride the send call: the server notifies only people who can
    // actually see the room and aren't muted, which the old client-side
    // /notifications blast could not check. The bot pseudo-entry is excluded —
    // the server detects the bot by name in the text.
    const mentioned = me
      ? [...mentionMapRef.current.entries()]
          .filter(([name]) => text.includes(`@[${name}]`))
          .map(([, u]) => u.user_id)
          .filter((id) => id !== '__bot__')
      : []
    send.mutate({ text, mentions: mentioned, attachments })
    mentionMapRef.current.clear()
    if (botName) {
      const esc = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`@\\[?${esc}\\]?\\b`, 'i').test(text)) setBotAskedAt(Date.now())
    }
  }

  const onDraftChange = (value: string, cursor: number) => {
    setDraft(value)
    typing.onType()
    const q = getMentionQuery(value, cursor)
    setMentionQuery(q)
    if (q !== null) setMentionIndex(0)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionCandidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectMention(mentionCandidates[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
      }
    }
  }

  const myId = me?.id?.toLowerCase()
  const searching = searchOpen && msgSearch.trim().length > 0
  const visibleMessages = useMemo(
    () =>
      searching
        ? messages.filter((m) => m.message.toLowerCase().includes(msgSearch.trim().toLowerCase()))
        : messages,
    [messages, searching, msgSearch]
  )
  const lastMineIndex = useMemo(() => {
    if (searching) return -1
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      if (visibleMessages[i].sender?.toLowerCase() === myId) return i
    }
    return -1
  }, [visibleMessages, myId, searching])
  const readTime = peerReadAt ? new Date(peerReadAt).getTime() : 0

  return (
    <div className='flex h-full min-h-0 flex-col' data-chat-room={room}>
      <div className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-2', th.divider)}>
        <button
          type='button'
          onClick={onBack}
          className='rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
          aria-label='Back to conversations'
        >
          <ChevronLeft className='h-4 w-4' strokeWidth={2} />
        </button>
        <p className='min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          {label}
        </p>
        {recordLink && (
          <button
            type='button'
            onClick={() => cfg.navigate?.(recordLink)}
            className={cn(
              'flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors',
              th.accentText,
              'hover:bg-slate-100 dark:hover:bg-muted'
            )}
            title='Open the record this room belongs to'
            data-chat-open-record
          >
            <ExternalLink className='h-3.5 w-3.5' strokeWidth={2} />
            Open record
          </button>
        )}
        <ChatTipsButton botName={botName} />
        <button
          type='button'
          onClick={() => {
            setSearchOpen((o) => !o)
            setMsgSearch('')
          }}
          className={cn(
            'rounded-md p-1 transition-colors',
            searchOpen
              ? th.accentSoft
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
          )}
          aria-label='Search in this conversation'
        >
          <Search className='h-3.5 w-3.5' strokeWidth={2} />
        </button>
        {(room.startsWith('dm:') || roomInfo?.channel?.is_direct) && (
          <button
            type='button'
            title='Start a Teams call with everyone here'
            onClick={async () => {
              try {
                let emails: string[] = []
                if (room.startsWith('dm:') && me) {
                  const peer = dmPeer(room, me.id)
                  if (peer) {
                    const r = (await client.request(
                      get<{ data: { email?: string | null } }>(`/users/${peer}`)
                    )) as { data: { email?: string | null } }
                    if (r.data?.email) emails = [r.data.email]
                  }
                } else if (roomInfo?.channel?.id) {
                  const r = (await client.request(
                    get<{ data: Array<{ email: string | null; user: string }> }>(
                      `/chat/channels/${roomInfo.channel.id}/members`
                    )
                  )) as { data: Array<{ email: string | null; user: string }> }
                  emails = r.data
                    .filter((u) => u.email && u.user.toUpperCase() !== me?.id.toUpperCase())
                    .map((u) => u.email as string)
                }
                if (emails.length === 0) {
                  toast.error('No callable participants found')
                  return
                }
                window.open(
                  `https://teams.microsoft.com/l/call/0/0?users=${encodeURIComponent(emails.join(','))}`,
                  '_blank',
                  'noopener'
                )
              } catch {
                toast.error('Could not resolve participants')
              }
            }}
            className='rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
            aria-label='Start a Teams call'
            data-chat-teams-call
          >
            <Video className='h-3.5 w-3.5' strokeWidth={2} />
          </button>
        )}
        {roomInfo && (
          <div className='relative flex items-center'>
            <button
              type='button'
              onClick={() => setNotifyMenuOpen((o) => !o)}
              className={cn(
                'rounded-md p-1 transition-colors',
                roomInfo.muted || roomInfo.notify_mode === 'mentions'
                  ? th.accentSoft
                  : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
              )}
              aria-label='Notification settings for this room'
              title={
                roomInfo.muted
                  ? 'Muted'
                  : roomInfo.notify_mode === 'mentions'
                    ? 'Mentions only'
                    : 'All messages'
              }
              data-chat-notify
            >
              {roomInfo.muted ? (
                <BellOff className='h-3.5 w-3.5' strokeWidth={2} />
              ) : (
                <Bell className='h-3.5 w-3.5' strokeWidth={2} />
              )}
            </button>
            {notifyMenuOpen && (
              <div
                className={cn(
                  'absolute right-0 top-full z-30 mt-1 w-[160px] overflow-hidden rounded-lg border py-1 shadow-lg',
                  th.surface,
                  'border-slate-200 dark:border-border'
                )}
              >
                {(
                  [
                    ['all', 'All messages', !roomInfo.muted && roomInfo.notify_mode !== 'mentions'],
                    ['mentions', 'Mentions only', !roomInfo.muted && roomInfo.notify_mode === 'mentions'],
                    ['muted', 'Muted', roomInfo.muted]
                  ] as const
                ).map(([mode, text, active]) => (
                  <button
                    key={mode}
                    type='button'
                    onClick={() => {
                      setNotifyMenuOpen(false)
                      if (mode === 'muted') {
                        setMuted.mutate({ room, muted: true })
                      } else {
                        if (roomInfo.muted) setMuted.mutate({ room, muted: false })
                        setNotifyMode.mutate({ room, mode })
                      }
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]',
                      active ? th.accentSoft : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-muted'
                    )}
                  >
                    {text}
                    {active && <Check className='ml-auto h-3 w-3' />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {onOpenSettings && (
          <button
            type='button'
            onClick={onOpenSettings}
            className='rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
            aria-label='Channel settings'
          >
            <Settings className='h-3.5 w-3.5' strokeWidth={2} />
          </button>
        )}
      </div>
      {searchOpen && (
        <div className={cn('shrink-0 border-b px-3 py-1.5', th.divider)}>
          <input
            autoFocus
            value={msgSearch}
            onChange={(e) => setMsgSearch(e.target.value)}
            placeholder='Search messages…'
            className={cn('h-7 w-full rounded-md border px-2 text-[12px] outline-none', th.input)}
            aria-label='Search messages'
          />
        </div>
      )}
      <EntityRoomCard room={room} />
      {pins.length > 0 && (
        <div className={cn('shrink-0 border-b px-3 py-1', th.divider)} data-chat-pins-strip>
          <button
            type='button'
            onClick={() => setPinsOpen((o) => !o)}
            className='flex w-full items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400'
          >
            <Pin className='h-3 w-3' strokeWidth={2} />
            {pins.length} pinned
            {pinsOpen ? (
              <ChevronLeft className='ml-auto h-3 w-3 rotate-90' />
            ) : (
              <ChevronLeft className='ml-auto h-3 w-3 -rotate-90' />
            )}
          </button>
          {pinsOpen && (
            <div className='max-h-36 space-y-1 overflow-y-auto py-1'>
              {pins.map((p) => (
                <div key={p.pin_id} className='flex items-start gap-1.5 text-[11.5px]'>
                  <span className='min-w-0 flex-1 text-slate-600 dark:text-slate-300'>
                    <span className='font-medium'>{p.sender_name ?? 'Unknown'}: </span>
                    {p.message.length > 140 ? `${p.message.slice(0, 140)}…` : p.message}
                  </span>
                  <button
                    type='button'
                    title='Unpin'
                    onClick={() => togglePin.mutate(p.id)}
                    className='shrink-0 text-slate-400 hover:text-red-500'
                  >
                    <X className='h-3 w-3' />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className='min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3' data-chat-messages>
        {loading ? (
          <p className='py-6 text-center text-[12px] text-slate-400'>Loading…</p>
        ) : visibleMessages.length === 0 ? (
          <div className='py-6 text-center text-[12px] text-slate-400'>
            {searching ? (
              'No messages match.'
            ) : (
              <>
                <p>No messages yet — say hello.</p>
                <p className='mt-1 text-[11px]'>
                  Tip: @ mentions someone{botName ? `, @${botName} asks the AI` : ''}, and a record
                  ID like CR26-12345 becomes a live link.
                </p>
              </>
            )}
          </div>
        ) : (
          visibleMessages.map((m, idx) => {
            const mine = m.sender?.toLowerCase() === myId
            const prev = visibleMessages[idx - 1]
            const newDay =
              idx === 0 ||
              (prev &&
                new Date(prev.date_created).toDateString() !==
                  new Date(m.date_created).toDateString())
            const isLastMine = mine && idx === lastMineIndex
            const wasRead =
              isLastMine && readTime > 0 && new Date(m.date_created).getTime() <= readTime
            const deleted = !!m.deleted_at
            const editable =
              mine && !deleted && Date.now() - new Date(m.date_created).getTime() < 15 * 60_000
            // Delete has no time window: own messages always, any message for
            // admins (matches the server's own-or-admin rule).
            const deletable = !deleted && (mine || isAdmin)
            const isEditing = editingId === m.id
            // "New messages" — anchored to the unread count frozen at open.
            const showUnreadDivider =
              !searching &&
              initialUnreadRef.current > 0 &&
              idx === Math.max(0, visibleMessages.length - initialUnreadRef.current)
            const reactionGroups = new Map<string, { count: number; mine: boolean; names: string[] }>()
            for (const r of m.reactions ?? []) {
              const g = reactionGroups.get(r.emoji) ?? { count: 0, mine: false, names: [] }
              g.count++
              if (r.user?.toLowerCase() === myId) g.mine = true
              if (r.user_name) g.names.push(r.user_name)
              reactionGroups.set(r.emoji, g)
            }
            return (
              <div key={m.id}>
                {newDay && (
                  <div className='my-2 flex items-center gap-2'>
                    <span className='h-px flex-1 bg-slate-100 dark:bg-border' />
                    <span className='text-[10px] font-medium text-slate-400'>
                      {dateDivider(m.date_created)}
                    </span>
                    <span className='h-px flex-1 bg-slate-100 dark:bg-border' />
                  </div>
                )}
                {showUnreadDivider && (
                  <div ref={dividerRef} className='my-2 flex items-center gap-2' data-chat-unread-divider>
                    <span className='h-px flex-1 bg-red-300 dark:bg-red-500/50' />
                    <span className='text-[10px] font-semibold uppercase tracking-wide text-red-400'>
                      New messages
                    </span>
                    {initialUnreadRef.current > 20 && (
                      <button
                        type='button'
                        disabled={catchupMut.isPending}
                        onClick={() => catchupMut.mutate()}
                        className='rounded-full border border-red-200 px-1.5 py-px text-[9.5px] font-medium text-red-400 hover:text-red-600 disabled:opacity-50 dark:border-red-500/40'
                      >
                        {catchupMut.isPending ? 'Summarizing…' : '✨ What did I miss?'}
                      </button>
                    )}
                    <span className='h-px flex-1 bg-red-300 dark:bg-red-500/50' />
                  </div>
                )}
                {showUnreadDivider && catchup && (
                  <div className='my-1 rounded-md border border-[#00ceff40] bg-[#00ceff0d] px-2.5 py-1.5 text-[11.5px] leading-snug text-slate-600 dark:text-slate-300'>
                    {catchup}
                  </div>
                )}
                <div className={cn('group/msg flex gap-2', mine && 'flex-row-reverse')}>
                  {!mine && <Avatar id={m.sender} name={m.sender_name} size={26} />}
                  <div className={cn('relative max-w-[78%]', mine && 'text-right')}>
                    {!mine && (
                      <p className='mb-0.5 text-[10.5px] font-medium text-slate-400'>
                        {m.sender_name ?? 'Unknown'}
                      </p>
                    )}
                    {/* Hover toolbar: react, and (own, in-window) edit/delete */}
                    {!deleted && !isEditing && (
                      <div
                        className={cn(
                          'absolute -top-3 z-10 hidden items-center gap-0.5 rounded-full border px-1 py-0.5 shadow-sm group-hover/msg:flex',
                          th.surface,
                          'border-slate-200 dark:border-border',
                          // Anchor at the screen-edge side so the toolbar grows
                          // INWARD: own bubbles hug the right edge (pin right,
                          // extend left), others hug the left (pin left, extend
                          // right). The old inverse pinning pushed the toolbar
                          // off-screen whenever it was wider than the bubble.
                          mine ? 'right-0' : 'left-0'
                        )}
                        data-chat-msg-actions
                      >
                        {REACTION_EMOJI.map((e) => (
                          <button
                            key={e}
                            type='button'
                            onClick={() => toggleReaction.mutate({ messageId: m.id, emoji: e })}
                            className='rounded-full px-0.5 text-[13px] leading-none transition-transform hover:scale-125'
                            title={`React ${e}`}
                          >
                            {e}
                          </button>
                        ))}
                        {roomRecord && (
                          <button
                            type='button'
                            title='Make a task from this message'
                            onClick={() => makeTask.mutate(m)}
                            className='rounded-full p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                          >
                            <ClipboardPlus className='h-3 w-3' />
                          </button>
                        )}
                        <button
                          type='button'
                          title={pins.some((p) => p.id === m.id) ? 'Unpin' : 'Pin'}
                          onClick={() => togglePin.mutate(m.id)}
                          className={cn(
                            'rounded-full p-0.5',
                            pins.some((p) => p.id === m.id)
                              ? th.accentText
                              : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                          )}
                        >
                          <Pin className='h-3 w-3' />
                        </button>
                        <button
                          type='button'
                          title={savedIds.has(m.id) ? 'Remove from saved' : 'Save for later (personal bookmark)'}
                          onClick={() => toggleSave.mutate(m.id)}
                          className={cn(
                            'rounded-full p-0.5',
                            savedIds.has(m.id)
                              ? th.accentText
                              : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                          )}
                        >
                          <Bookmark className='h-3 w-3' />
                        </button>
                        {editable && (
                          <button
                            type='button'
                            title='Edit'
                            onClick={() => {
                              setEditingId(m.id)
                              setEditDraft(m.message)
                              setConfirmDeleteId(null)
                            }}
                            className='rounded-full p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                          >
                            <Pencil className='h-3 w-3' />
                          </button>
                        )}
                        {deletable && (
                          <>
                            {confirmDeleteId === m.id ? (
                              <button
                                type='button'
                                title='Confirm delete'
                                onClick={() => {
                                  deleteMessage.mutate(m.id)
                                  setConfirmDeleteId(null)
                                }}
                                className='rounded-full px-1 text-[10px] font-semibold text-red-500'
                              >
                                Sure?
                              </button>
                            ) : (
                              <button
                                type='button'
                                title={mine ? 'Delete' : 'Delete (admin)'}
                                onClick={() => setConfirmDeleteId(m.id)}
                                className='rounded-full p-0.5 text-slate-400 hover:text-red-500'
                              >
                                <Trash2 className='h-3 w-3' />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {deleted ? (
                      <div className='inline-block rounded-2xl border border-dashed border-slate-200 px-3 py-1.5 text-left text-[11.5px] italic text-slate-400 dark:border-border'>
                        Message removed
                      </div>
                    ) : isEditing ? (
                      <form
                        className='flex items-center gap-1'
                        onSubmit={(e) => {
                          e.preventDefault()
                          const text = editDraft.trim()
                          if (text && text !== m.message) {
                            editMessage.mutate({ messageId: m.id, text })
                          }
                          setEditingId(null)
                        }}
                      >
                        <input
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          className={cn('h-8 w-[240px] rounded-lg border px-2 text-[12px] outline-none', th.input)}
                          aria-label='Edit message'
                        />
                        <button type='submit' className={cn('rounded-md px-1.5 py-1 text-[11px] font-medium', th.accentText)}>
                          Save
                        </button>
                      </form>
                    ) : (
                      <div
                        className={cn(
                          'inline-block rounded-2xl px-3 py-1.5 text-left text-[12.5px] leading-snug',
                          mine ? cn('rounded-br-md', th.bubbleMine) : cn('rounded-bl-md', th.bubbleOther)
                        )}
                      >
                        {m.message &&
                          (renderMessageBody ? (
                            renderMessageBody(m, { mine })
                          ) : (
                            <MessageBody text={m.message} mine={mine} />
                          ))}
                        {(m.attachments ?? []).length > 0 && (
                          <div className={cn('flex flex-wrap gap-1.5', m.message && 'mt-1.5')}>
                            {(m.attachments ?? []).map((aid) => {
                              const meta = attachmentMeta?.get(aid)
                              const name = meta?.title || meta?.filename_download || 'Attachment'
                              const url = client.fileUrl(aid)
                              const isImg = (meta?.type ?? '').startsWith('image/')
                              const openPreview = () =>
                                setPreview({
                                  id: aid,
                                  url,
                                  name,
                                  type: meta?.type ?? null,
                                  size: meta?.filesize ?? null
                                })
                              return isImg ? (
                                <button key={aid} type='button' onClick={openPreview} className='block cursor-zoom-in'>
                                  <img
                                    src={url}
                                    alt={name}
                                    className='max-h-40 max-w-[220px] rounded-lg object-cover'
                                    loading='lazy'
                                  />
                                </button>
                              ) : (
                                <button
                                  key={aid}
                                  type='button'
                                  onClick={openPreview}
                                  className={cn(
                                    'inline-flex max-w-[220px] items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px]',
                                    mine
                                      ? 'border-white/30 bg-white/10'
                                      : 'border-slate-200 bg-white dark:border-border dark:bg-card'
                                  )}
                                >
                                  <Paperclip className='h-3 w-3 shrink-0 opacity-60' />
                                  <span className='truncate'>{name}</span>
                                </button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    {reactionGroups.size > 0 && (
                      <div className={cn('mt-0.5 flex flex-wrap gap-1', mine && 'justify-end')} data-chat-reactions>
                        {[...reactionGroups.entries()].map(([emoji, g]) => (
                          <button
                            key={emoji}
                            type='button'
                            title={g.names.join(', ')}
                            onClick={() => toggleReaction.mutate({ messageId: m.id, emoji })}
                            className={cn(
                              'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[10.5px] leading-tight transition-colors',
                              g.mine
                                ? cn('font-semibold', th.accentSoft, 'border-transparent')
                                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted'
                            )}
                          >
                            <span>{emoji}</span>
                            <span className='tabular-nums'>{g.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <p className='mt-0.5 flex items-center justify-end gap-1 text-[10px] text-slate-400'>
                      {!mine && <span className='mr-auto' />}
                      {m.edited_at && !deleted && <span className='italic'>(edited)</span>}
                      {new Date(m.date_created).toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
                      {mine && isGroupRoom && !deleted && (() => {
                        const seen = seenBy(m)
                        if (seen.length === 0) return null
                        return (
                          <span
                            className={cn('font-medium', th.accentText)}
                            data-tip={`Seen by ${seen.map((sb) => sb.name || 'someone').join(', ')}`}
                          >
                            Seen by {seen.length}
                          </span>
                        )
                      })()}
                      {isLastMine &&
                        room.startsWith('dm:') &&
                        (wasRead ? (
                          <span
                            className={cn('inline-flex items-center gap-0.5 font-medium', th.accentText)}
                          >
                            <CheckCheck className='h-3 w-3' strokeWidth={2.4} /> Read
                          </span>
                        ) : (
                          <span className='inline-flex items-center gap-0.5'>
                            <Check className='h-3 w-3' strokeWidth={2.2} /> Sent
                          </span>
                        ))}
                    </p>
                  </div>
                </div>
              </div>
            )
          })
        )}
        <div ref={endRef} />
      </div>
      <div className='min-h-[18px] shrink-0 px-3.5'>
        {botAskedAt && botName ? (
          <p className='flex items-center gap-1.5 text-[11px] italic text-slate-400' data-chat-bot-thinking>
            <span className='inline-flex gap-0.5'>
              <span className='h-1 w-1 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]' />
              <span className='h-1 w-1 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]' />
              <span className='h-1 w-1 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]' />
            </span>
            {botName} is thinking…
          </p>
        ) : (
          typing.typingText && (
            <p className='text-[11px] italic text-slate-400'>{typing.typingText}</p>
          )
        )}
      </div>
      {preview && <FilePreviewLightbox file={preview} onClose={() => setPreview(null)} />}
      {(pendingFiles.length > 0 || uploadingFiles > 0) && (
        <div className={cn('flex shrink-0 flex-wrap items-center gap-1.5 border-t px-3 py-1.5', th.divider)}>
          {pendingFiles.map((f) => (
            <span
              key={f.id}
              className='inline-flex max-w-[180px] items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'
            >
              <Paperclip className='h-3 w-3 shrink-0 opacity-60' />
              <span className='truncate'>{f.name}</span>
              <button
                type='button'
                onClick={() => setPendingFiles((prev) => prev.filter((p) => p.id !== f.id))}
                className='text-slate-400 hover:text-red-500'
                aria-label={`Remove ${f.name}`}
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          ))}
          {uploadingFiles > 0 && (
            <span className='text-[11px] italic text-slate-400'>Uploading…</span>
          )}
        </div>
      )}
      <form
        className={cn('relative flex shrink-0 items-center gap-2 border-t p-2.5', th.divider)}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        data-chat-composer
      >
        {mentionQuery !== null && mentionCandidates.length > 0 && (
          <div
            className={cn(
              'absolute bottom-full left-2.5 z-20 mb-1 w-[260px] overflow-hidden rounded-xl border shadow-lg',
              th.surface,
              'border-slate-200 dark:border-border'
            )}
          >
            {mentionCandidates.map((u, i) => (
              <button
                key={u.user_id}
                type='button'
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectMention(u)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]',
                  i === mentionIndex ? th.accentSoft : 'text-slate-700 dark:text-slate-200'
                )}
              >
                <Avatar id={u.user_id} name={u.display_name} size={22} />
                <span className='min-w-0 flex-1 truncate'>
                  {u.display_name ?? 'Unknown'}
                  {u.user_id !== '__bot__' && humanLabel(u.role_name) && (
                    <span className='ml-1.5 text-[11px] text-slate-400 dark:text-slate-500'>
                      {humanLabel(u.role_name)}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) =>
            onDraftChange(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length > 0) {
              e.preventDefault()
              void uploadFiles(files)
            }
          }}
          placeholder={`Message ${label}… (@ to mention${botName ? `, @${botName} for AI` : ''})`}
          className={cn('h-9 min-w-0 flex-1 rounded-lg border px-3 text-[12.5px] outline-none', th.input)}
          aria-label={`Message ${label}`}
        />
        <input
          ref={fileInputRef}
          type='file'
          multiple
          className='hidden'
          onChange={(e) => {
            void uploadFiles([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <button
          type='button'
          onClick={() => fileInputRef.current?.click()}
          className='flex h-9 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
          aria-label='Attach a file'
          title='Attach a file (or paste an image)'
        >
          <Paperclip className='h-4 w-4' strokeWidth={2} />
        </button>
        <button
          type='submit'
          disabled={(!draft.trim() && pendingFiles.length === 0) || send.isPending || uploadingFiles > 0}
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-[filter] hover:brightness-110 disabled:opacity-40',
            th.action
          )}
          aria-label='Send'
        >
          <Send className='h-4 w-4' strokeWidth={2} />
        </button>
      </form>
    </div>
  )
}

function channelMeta(c: DirectoryChannel): ChannelMeta {
  return {
    id: c.id,
    visibility: c.visibility,
    role: c.role,
    topic: c.topic,
    created_by: (c as { created_by?: string | null }).created_by ?? null
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Never show a raw id to a person. Presence rows can carry a role UUID in
 * `role_name` (legacy writers stored the id), and it rendered as the user's
 * subtitle in the Online list — meaningless to anyone reading it.
 */
/** "Idle · 12m" from the last real input the client reported. */
function idleLabel(u: { last_active?: string | null; idle_minutes?: number | null }): string {
  const mins =
    typeof u.idle_minutes === 'number'
      ? u.idle_minutes
      : u.last_active
        ? Math.floor((Date.now() - new Date(u.last_active).getTime()) / 60_000)
        : null
  if (mins == null || mins < 1) return 'Idle'
  if (mins < 60) return `Idle · ${mins}m`
  return `Idle · ${Math.floor(mins / 60)}h ${mins % 60}m`
}

function humanLabel(value: string | null | undefined): string | null {
  const v = value?.trim()
  if (!v || UUID_RE.test(v)) return null
  return v
}

/**
 * Channel settings. Owner or admin edits name/topic/visibility, manages members
 * and archives; everyone else gets the read-only summary, so a member can still
 * see what kind of room they are in and who else is here.
 */
export function ChatChannelSettings({
  channel,
  label,
  onBack
}: {
  channel: ChannelMeta
  label: string
  onBack: () => void
}) {
  const th = useTheme()
  const cfg = useChatConfig()
  const { isAdmin } = useItemEditAuth()
  const roles = useChatRoles()
  const { members, loading } = useChannelMembers(channel.id)
  const { update, addMember, removeMember } = useChannelAdmin(channel.id)
  const [name, setName] = useState(label)
  const [topic, setTopic] = useState(channel.topic ?? '')
  const [visibility, setVisibility] = useState(channel.visibility)
  const [role, setRole] = useState(channel.role ?? '')
  const [memberSearch, setMemberSearch] = useState('')
  const debounced = useDebouncedValue(memberSearch, 250)
  const { users } = useUserSearch(debounced, visibility === 'private')

  const canEdit =
    isAdmin || (!!cfg.me && String(channel.created_by ?? '') === String(cfg.me.id))
  const memberIds = new Set(members.map((m) => String(m.user).toUpperCase()))
  const dirty =
    name !== label ||
    topic !== (channel.topic ?? '') ||
    visibility !== channel.visibility ||
    (visibility === 'role' && role !== (channel.role ?? ''))

  return (
    <div className='flex min-h-0 flex-1 flex-col' data-chat-settings>
      <div className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-2.5', th.divider)}>
        <button
          type='button'
          onClick={onBack}
          className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
          aria-label='Back to conversation'
        >
          <ChevronLeft className='h-4 w-4' />
        </button>
        <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          {label} · settings
        </p>
      </div>

      <div className='min-h-0 flex-1 space-y-4 overflow-y-auto p-3'>
        {canEdit ? (
          <>
            <label className='block'>
              <span className='mb-1 block text-[11px] font-medium text-slate-400'>Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={cn('h-8 w-full rounded-md px-2 text-[12.5px] outline-none', th.input)}
              />
            </label>
            <label className='block'>
              <span className='mb-1 block text-[11px] font-medium text-slate-400'>Topic</span>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder='What this channel is for'
                className={cn('h-8 w-full rounded-md px-2 text-[12.5px] outline-none', th.input)}
              />
            </label>

            <div>
              <span className='mb-1 block text-[11px] font-medium text-slate-400'>Who can see it</span>
              <div className='flex flex-wrap gap-1.5'>
                {(
                  [
                    ['open', 'Anyone'],
                    ['role', 'One role'],
                    ['private', 'Invite only']
                  ] as const
                ).map(([v, l]) => (
                  <button
                    key={v}
                    type='button'
                    onClick={() => setVisibility(v)}
                    className={cn(
                      'rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors',
                      visibility === v
                        ? th.accentSoft
                        : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
              {visibility === 'role' && (
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className={cn('mt-2 h-8 w-full rounded-md px-2 text-[12.5px] outline-none', th.input)}
                >
                  <option value=''>Choose a role…</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className='flex items-center gap-2'>
              <button
                type='button'
                disabled={!dirty || update.isPending || (visibility === 'role' && !role)}
                onClick={() =>
                  update.mutate({
                    name: name.trim() || label,
                    topic: topic.trim() || null,
                    visibility,
                    role: visibility === 'role' ? role : null
                  })
                }
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-medium disabled:opacity-40',
                  th.action
                )}
              >
                {update.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                type='button'
                onClick={() => update.mutate({ is_archived: true })}
                className='ml-auto rounded-md px-2 py-1 text-[11.5px] font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40'
              >
                Archive channel
              </button>
            </div>
            {update.isError && (
              <p className='text-[11.5px] text-red-500'>{(update.error as Error).message}</p>
            )}
          </>
        ) : (
          <p className='text-[12px] leading-relaxed text-slate-500 dark:text-slate-400'>
            {channel.topic || 'No topic set.'}
            <br />
            {channel.visibility === 'private'
              ? 'Invite only — you were added by the channel owner.'
              : channel.visibility === 'role'
                ? 'Everyone with a particular role can see this channel.'
                : 'Anyone in the portal can find and join this channel.'}
          </p>
        )}

        <div>
          <p className='mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400'>
            Members {members.length > 0 && `· ${members.length}`}
          </p>
          {loading && <p className='text-[12px] text-slate-400'>Loading…</p>}
          {members.map((m) => {
            const nm = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.user
            return (
              <div key={m.user} className='flex items-center gap-2 rounded-lg px-1 py-1'>
                <Avatar id={m.user} name={nm} />
                <span className='min-w-0 flex-1 truncate text-[12.5px] text-slate-700 dark:text-slate-200'>
                  {nm}
                </span>
                {canEdit && (
                  <button
                    type='button'
                    title='Remove from channel'
                    onClick={() => removeMember.mutate(m.user)}
                    className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-500 dark:hover:bg-muted'
                  >
                    <X className='h-3 w-3' />
                  </button>
                )}
              </div>
            )
          })}

          {canEdit && visibility === 'private' && (
            <div className='mt-2'>
              <input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder='Add someone…'
                className={cn('h-8 w-full rounded-md px-2 text-[12.5px] outline-none', th.input)}
              />
              {memberSearch.trim() && (
                <div className='mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200 dark:border-border'>
                  {users
                    .filter((u) => !memberIds.has(String(u.id).toUpperCase()))
                    .map((u) => {
                      const nm =
                        [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.id
                      return (
                        <button
                          key={u.id}
                          type='button'
                          onClick={() => {
                            addMember.mutate(u.id)
                            setMemberSearch('')
                          }}
                          className='flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-muted/50'
                        >
                          <Avatar id={u.id} name={nm} />
                          <span className='min-w-0 flex-1 truncate text-[12.5px] text-slate-700 dark:text-slate-200'>
                            {nm}
                          </span>
                        </button>
                      )
                    })}
                </div>
              )}
              <p className='mt-1 text-[11px] leading-snug text-slate-400'>
                Only members can see an invite-only channel — it is not listed to anyone else.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Tiny local debounce so the member search does not fire per keystroke. */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function ChatRoomList({
  rooms,
  onOpen,
  onNewGroup
}: {
  rooms: RoomInfo[]
  onOpen: (room: RoomInfo) => void
  /** Opens the group-conversation composer (host renders the dialog). */
  onNewGroup?: () => void
}) {
  const th = useTheme()
  const cfg = useChatConfig()
  const { setMuted, leave } = useRoomMembership()
  const bot = useChatBotInfo()
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 250)
  // Cross-room message search rides the same box: type ≥2 chars and matching
  // MESSAGES appear under the filtered room list.
  const { hits, loading: searching } = useChatSearch(q)
  const roomByKey = useMemo(() => new Map(rooms.map((r) => [r.room, r])), [rooms])
  const filteredRooms = q
    ? rooms.filter((r) => r.label.toLowerCase().includes(q.toLowerCase()))
    : rooms
  // Group DMs are private channels flagged is_direct — they belong with
  // conversations, not #channels.
  const isGroupDm = (r: RoomInfo) => r.kind === 'channel' && r.channel?.is_direct
  return (
    <div className='min-h-0 flex-1 overflow-y-auto p-2' data-chat-room-list>
      <div className='mb-1.5 flex items-center gap-1.5 px-1'>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Search rooms & messages…'
          className={cn('h-7 min-w-0 flex-1 rounded-md border px-2 text-[12px] outline-none', th.input)}
          aria-label='Search rooms and messages'
          data-chat-global-search
        />
        {onNewGroup && (
          <button
            type='button'
            onClick={onNewGroup}
            title='New group conversation'
            className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:text-slate-400 dark:hover:bg-muted'
            data-chat-new-group
          >
            <Users className='h-3.5 w-3.5' strokeWidth={2} />
          </button>
        )}
      </div>
      {q.length >= 2 && (
        <div className='mb-1.5'>
          <p className='px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400'>
            Messages
          </p>
          {searching ? (
            <p className='px-2.5 py-1 text-[11px] text-slate-400'>Searching…</p>
          ) : hits.length === 0 ? (
            <p className='px-2.5 py-1 text-[11px] text-slate-400'>No messages match.</p>
          ) : (
            hits.slice(0, 15).map((h) => {
              const r = roomByKey.get(h.room)
              return (
                <button
                  key={h.id}
                  type='button'
                  onClick={() => {
                    if (r) onOpen(r)
                  }}
                  className='flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/50'
                >
                  <span className='flex items-center gap-1.5 text-[10.5px] text-slate-400'>
                    <span className='truncate font-medium'>{r?.label ?? h.room}</span>
                    <span className='ml-auto shrink-0'>
                      {new Date(h.date_created).toLocaleDateString()}
                    </span>
                  </span>
                  <span className='truncate text-[12px] text-slate-700 dark:text-slate-200'>
                    {h.sender_name ? `${h.sender_name}: ` : ''}
                    {h.message}
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
      {bot.bot_name && bot.bot_user_id && cfg.me && (
        <button
          type='button'
          onClick={() =>
            onOpen({
              room: dmRoom(cfg.me!.id, bot.bot_user_id!),
              label: `@${bot.bot_name}`,
              kind: 'dm',
              lastMessage: null,
              unread: 0,
              muted: false,
              notify_mode: 'all',
              joined: true,
              channel: null
            })
          }
          className='mb-1 flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/50'
          data-chat-bot-dm
        >
          <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold', th.accentSoft)}>
            @
          </span>
          <span className='min-w-0 flex-1'>
            <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
              Ask @{bot.bot_name}
            </span>
            <span className='block truncate text-[11px] text-slate-400'>
              Your AI assistant — questions, summaries, reminders
            </span>
          </span>
        </button>
      )}
      {(
        [
          ['Channels', filteredRooms.filter((r) => (r.kind === 'global' || r.kind === 'channel') && !isGroupDm(r))],
          ['Direct messages', filteredRooms.filter((r) => r.kind === 'dm' || isGroupDm(r))],
          ['Records', filteredRooms.filter((r) => r.kind === 'entity')]
        ] as const
      ).map(([groupLabel, groupRooms]) =>
        groupRooms.length === 0 ? null : (
          <div key={groupLabel} className='mb-1.5'>
            <p className='px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400'>
              {groupLabel}
            </p>
            {groupRooms.map((r) => (
              <div key={r.room} className='group/room relative'>
                <button
                  type='button'
                  onClick={() => onOpen(r)}
                  className='flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/50'
                >
                  <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400'>
                    {r.kind === 'dm' ? (
                      <MessageCircle className='h-4 w-4' strokeWidth={1.8} />
                    ) : r.channel?.is_direct ? (
                      <Users className='h-4 w-4' strokeWidth={1.8} />
                    ) : (
                      <Hash className='h-4 w-4' strokeWidth={1.8} />
                    )}
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='flex items-center gap-1.5'>
                      <span className='truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                        {r.label}
                      </span>
                      {r.muted && (
                        <BellOff className='h-3 w-3 shrink-0 text-slate-300' strokeWidth={2} />
                      )}
                    </span>
                    {r.lastMessage && (
                      <span className='block truncate text-[11px] text-slate-400'>
                        {r.lastMessage.sender_name ? `${r.lastMessage.sender_name}: ` : ''}
                        {r.lastMessage.message}
                      </span>
                    )}
                  </span>
                  {r.unread > 0 && (
                    <span
                      className={cn(
                        'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-bold',
                        // A muted room still counts, but quietly — it must not
                        // read like something demanding attention.
                        r.muted
                          ? 'bg-slate-100 text-slate-400 dark:bg-muted dark:text-slate-500'
                          : th.pill
                      )}
                    >
                      {r.unread > 99 ? '99+' : r.unread}
                    </span>
                  )}
                </button>
                {/* Row actions sit on hover so the list stays scannable. */}
                <span className='absolute right-1.5 top-1.5 hidden items-center gap-0.5 group-hover/room:flex'>
                  <button
                    type='button'
                    title={r.muted ? 'Unmute' : 'Mute'}
                    onClick={() => setMuted.mutate({ room: r.room, muted: !r.muted })}
                    className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-muted'
                  >
                    {r.muted ? <Bell className='h-3 w-3' /> : <BellOff className='h-3 w-3' />}
                  </button>
                  {r.kind === 'channel' && r.joined && (
                    <button
                      type='button'
                      title='Leave channel'
                      onClick={() => leave.mutate(r.room)}
                      className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-muted'
                    >
                      <LogOut className='h-3 w-3' />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

/**
 * Browse and join channels. The sidebar only lists rooms you belong to, so at
 * hundreds of channels this is how you find the rest — the old list rendered
 * every room anyone had ever posted in.
 */
export function ChatChannelBrowser({
  onOpen
}: {
  onOpen: (room: string, label: string, channel: ChannelMeta) => void
}) {
  const th = useTheme()
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<'open' | 'role' | 'private'>('open')
  const [role, setRole] = useState('')
  const roles = useChatRoles()
  const { channels, loading } = useChannelDirectory(search)
  const { join } = useRoomMembership()
  const create = useCreateChannel()

  return (
    <div className='flex min-h-0 flex-1 flex-col' data-chat-directory>
      <div className='flex items-center gap-2 p-2'>
        <div className='relative flex-1'>
          <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search channels…'
            className={cn('h-8 w-full rounded-md pl-8 pr-2 text-[12.5px] outline-none', th.input)}
          />
        </div>
        <button
          type='button'
          onClick={() => setCreating((v) => !v)}
          className={cn('flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium', th.action)}
        >
          <Plus className='h-3.5 w-3.5' /> New
        </button>
      </div>

      {creating && (
        <form
          className='flex flex-col gap-2 border-b border-slate-100 p-2 dark:border-border/60'
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            if (visibility === 'role' && !role) return
            create.mutate(
              { name: name.trim(), visibility, role: visibility === 'role' ? role : null },
              {
                onSuccess: () => {
                  setName('')
                  setCreating(false)
                }
              }
            )
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Channel name'
            className={cn('h-8 rounded-md px-2 text-[12.5px] outline-none', th.input)}
          />
          <div className='flex items-center gap-2'>
            {(
              [
                ['open', 'Anyone'],
                ['role', 'One role'],
                ['private', 'Invite only']
              ] as const
            ).map(([v, l]) => (
              <button
                key={v}
                type='button'
                onClick={() => setVisibility(v)}
                className={cn(
                  'rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors',
                  visibility === v ? th.accentSoft : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
                )}
              >
                {l}
              </button>
            ))}
            <button
              type='submit'
              disabled={!name.trim() || create.isPending || (visibility === 'role' && !role)}
              className={cn('ml-auto rounded-md px-2.5 py-1 text-[12px] font-medium', th.action)}
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
          {visibility === 'role' && (
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className={cn('h-8 rounded-md px-2 text-[12.5px] outline-none', th.input)}
            >
              <option value=''>Choose a role…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          {create.isError && (
            <p className='text-[11.5px] text-red-500'>{(create.error as Error).message}</p>
          )}
        </form>
      )}

      <div className='min-h-0 flex-1 overflow-y-auto p-2'>
        {loading && <p className='px-2 py-6 text-center text-[12px] text-slate-400'>Loading…</p>}
        {!loading && channels.length === 0 && (
          <div className='px-3 py-8 text-center'>
            <Hash className='mx-auto h-5 w-5 text-slate-300' />
            <p className='mt-2 text-[12.5px] font-medium text-slate-600 dark:text-slate-300'>
              {search ? `No channel matches “${search}”` : 'No channels yet'}
            </p>
            <p className='mt-1 text-[11.5px] leading-relaxed text-slate-400'>
              Channels are shared rooms anyone can join. Record conversations appear on their own
              once someone posts on a record.
            </p>
          </div>
        )}
        {channels.map((c) => (
          <div
            key={c.key}
            className='flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-slate-50 dark:hover:bg-muted/50'
          >
            <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400'>
              {c.visibility === 'private' ? (
                <Lock className='h-3.5 w-3.5' strokeWidth={1.8} />
              ) : (
                <Hash className='h-4 w-4' strokeWidth={1.8} />
              )}
            </span>
            <span className='min-w-0 flex-1'>
              <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                {c.name}
              </span>
              <span className='block truncate text-[11px] text-slate-400'>
                {c.topic || `${c.members} member${c.members === 1 ? '' : 's'}`}
              </span>
            </span>
            {c.joined ? (
              <button
                type='button'
                onClick={() => onOpen(`ch:${c.key}`, c.name, channelMeta(c))}
                className='shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
              >
                Open
              </button>
            ) : (
              <button
                type='button'
                onClick={() =>
                  join.mutate(`ch:${c.key}`, {
                    onSuccess: () => onOpen(`ch:${c.key}`, c.name, channelMeta(c))
                  })
                }
                className={cn('shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium', th.action)}
              >
                Join
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Extras the online list shows under a name — resolved SERVER-side so every
 * host agrees (role, restricted scope labels, live page, live session id) and
 * so which of them appear is instance config, not per-app code.
 *
 * Merged onto the host's online list by user id rather than replacing it: the
 * host still owns who counts as online.
 */
interface PresenceExtra {
  user_id: string
  role_name?: string | null
  current_path?: string | null
  page?: string | null
  app?: string | null
  scopes?: string[]
  /** dimension -> labels, e.g. {division: ['Zone 1'], region: ['BLT']} */
  scopes_by_dimension?: Record<string, string[]>
  recording_id?: string | null
  is_idle?: boolean
  idle_minutes?: number | null
  last_active?: string | null
  custom_status?: { text: string; emoji: string | null } | null
}

/** Set-your-status control (#33): free text + emoji, self-clearing. Saved in
 *  user preferences; /presence/online serves it to every host. */
function MyStatusRow({ myStatus }: { myStatus: { text: string; emoji: string | null } | null }) {
  const th = useTheme()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [emoji, setEmoji] = useState('')
  const [duration, setDuration] = useState<'30' | '60' | 'today' | 'never'>('60')
  const QUICK = ['📅', '🍽️', '🏠', '✈️', '🤒', '🎯', '☕']

  const save = useMutation({
    mutationFn: (status: { text: string; emoji: string | null; expires_at: string | null } | null) =>
      client.request(patchCmd('/users/me/preferences', { custom_status: status })),
    onSuccess: () => {
      setEditing(false)
      void qc.invalidateQueries({ queryKey: ['presence-online'] })
    },
    onError: () => toast.error('Could not update your status')
  })
  const expiresAt = (): string | null => {
    if (duration === 'never') return null
    if (duration === 'today') {
      const d = new Date()
      d.setHours(23, 59, 59, 0)
      return d.toISOString()
    }
    return new Date(Date.now() + Number(duration) * 60_000).toISOString()
  }

  if (!editing) {
    return (
      <div className='mb-1.5 flex items-center gap-1.5 px-1'>
        <button
          type='button'
          onClick={() => {
            setText(myStatus?.text ?? '')
            setEmoji(myStatus?.emoji ?? '')
            setEditing(true)
          }}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-left text-[11.5px]',
            myStatus
              ? 'border-slate-200 text-slate-600 dark:border-border dark:text-slate-300'
              : 'border-slate-200 text-slate-400 dark:border-border'
          )}
          data-chat-my-status
        >
          {myStatus ? (
            <span className='truncate'>
              {myStatus.emoji ? `${myStatus.emoji} ` : ''}
              {myStatus.text}
            </span>
          ) : (
            <span>Set a status…</span>
          )}
        </button>
        {myStatus && (
          <button
            type='button'
            onClick={() => save.mutate(null)}
            className='rounded p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
            aria-label='Clear status'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        )}
      </div>
    )
  }
  return (
    <div className='mb-2 space-y-1.5 rounded-lg border border-slate-200 p-2 dark:border-border'>
      <div className='flex gap-1'>
        {QUICK.map((e) => (
          <button
            key={e}
            type='button'
            onClick={() => setEmoji(emoji === e ? '' : e)}
            className={cn(
              'rounded-md px-1 py-0.5 text-[15px]',
              emoji === e ? th.accentSoft : 'hover:bg-slate-100 dark:hover:bg-muted'
            )}
          >
            {e}
          </button>
        ))}
      </div>
      <input
        // biome-ignore lint/a11y/noAutofocus: single-purpose inline form
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) {
            save.mutate({ text: text.trim(), emoji: emoji || null, expires_at: expiresAt() })
          }
          if (e.key === 'Escape') setEditing(false)
        }}
        maxLength={100}
        placeholder="What's up? (e.g. In a meeting until 3)"
        className={cn('h-7 w-full rounded-md border px-2 text-[12px]', th.input)}
      />
      <div className='flex items-center gap-1.5'>
        <select
          value={duration}
          onChange={(e) => setDuration(e.target.value as typeof duration)}
          className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
        >
          <option value='30'>Clear in 30 min</option>
          <option value='60'>Clear in 1 hour</option>
          <option value='today'>Clear today</option>
          <option value='never'>Don't clear</option>
        </select>
        <span className='flex-1' />
        <button
          type='button'
          onClick={() => setEditing(false)}
          className='rounded-md px-2 py-1 text-[11.5px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
        >
          Cancel
        </button>
        <button
          type='button'
          disabled={!text.trim() || save.isPending}
          onClick={() => save.mutate({ text: text.trim(), emoji: emoji || null, expires_at: expiresAt() })}
          className={cn('rounded-md px-2.5 py-1 text-[11.5px] font-semibold disabled:opacity-50', th.action)}
        >
          Save
        </button>
      </div>
    </div>
  )
}

function usePresenceExtras(): {
  byUser: Map<string, PresenceExtra>
  fields: string[]
  adminUrl: string | null
  dimensions: Array<{ name: string; label: string }>
  loaded: boolean
} {
  const client = useNivaroClient()
  const { data, isFetched } = useQuery({
    queryKey: ['presence-online'],
    queryFn: () =>
      client.request<{
        data: PresenceExtra[]
        config?: {
          fields?: string[]
          admin_url?: string | null
          dimensions?: Array<{ name: string; label: string }>
        }
      }>(get('/presence/online')),
    // Matches the presence heartbeat cadence — the page someone is on should
    // track them around the app, not lag a minute behind.
    refetchInterval: 15_000,
    staleTime: 5_000
  })
  const byUser = useMemo(() => {
    const m = new Map<string, PresenceExtra>()
    for (const r of data?.data ?? []) m.set(String(r.user_id).toUpperCase(), r)
    return m
  }, [data])
  return {
    byUser,
    fields: data?.config?.fields ?? ['role', 'page'],
    adminUrl: data?.config?.admin_url ?? null,
    dimensions: data?.config?.dimensions ?? [],
    loaded: isFetched
  }
}

/** "/records/workflows/312100" → "Workflows › 312100" — the raw route is an
 *  implementation detail nobody reading a chat sidebar cares about. */
function prettyPath(path: string | null | undefined): string | null {
  if (!path) return null
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return 'Home'
  const skip = new Set(['records', 'collections', 'p'])
  const kept = parts.filter((p) => !skip.has(p))
  if (kept.length === 0) return 'Home'
  return kept
    .map((p, i) =>
      i === 0 ? p.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : p
    )
    .join(' › ')
}

/** Group conversation composer — pick people, optional name, create. */
function GroupDmDialog({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (room: string, name: string) => void
}) {
  const th = useTheme()
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Map<string, string>>(new Map())
  const { users } = useUserSearch(search, true)
  const createGroup = useCreateGroupDm()
  const displayName = (u: { first_name: string | null; last_name: string | null; email: string | null }) =>
    [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.email ?? 'Unknown')

  return (
    <div className='flex min-h-0 flex-1 flex-col p-3' data-chat-group-dialog>
      <div className='mb-2 flex items-center gap-2'>
        <button
          type='button'
          onClick={onClose}
          className='rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
          aria-label='Back'
        >
          <ChevronLeft className='h-4 w-4' strokeWidth={2} />
        </button>
        <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          New group conversation
        </p>
      </div>
      {selected.size > 0 && (
        <div className='mb-2 flex flex-wrap gap-1'>
          {[...selected.entries()].map(([id, n]) => (
            <span
              key={id}
              className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', th.accentSoft)}
            >
              {n}
              <button
                type='button'
                onClick={() =>
                  setSelected((prev) => {
                    const next = new Map(prev)
                    next.delete(id)
                    return next
                  })
                }
                aria-label={`Remove ${n}`}
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder='Find people…'
        className={cn('mb-1.5 h-8 rounded-md border px-2.5 text-[12.5px] outline-none', th.input)}
        aria-label='Find people'
        autoFocus
      />
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {users.map((u) => {
          const on = selected.has(u.id)
          return (
            <button
              key={u.id}
              type='button'
              onClick={() =>
                setSelected((prev) => {
                  const next = new Map(prev)
                  if (on) next.delete(u.id)
                  else next.set(u.id, displayName(u))
                  return next
                })
              }
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                on ? th.accentSoft : 'hover:bg-slate-50 dark:hover:bg-muted/50'
              )}
            >
              <Avatar id={u.id} name={displayName(u)} size={22} />
              <span className='truncate'>{displayName(u)}</span>
              {on && <Check className='ml-auto h-3.5 w-3.5 shrink-0' />}
            </button>
          )
        })}
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder='Group name (optional)'
        className={cn('mb-2 mt-1.5 h-8 rounded-md border px-2.5 text-[12.5px] outline-none', th.input)}
        aria-label='Group name'
      />
      <button
        type='button'
        disabled={selected.size === 0 || createGroup.isPending}
        onClick={() =>
          createGroup.mutate(
            { user_ids: [...selected.keys()], name: name.trim() || undefined },
            { onSuccess: (data) => onCreated(data.room, data.name) }
          )
        }
        className={cn(
          'flex h-9 items-center justify-center rounded-lg text-[12.5px] font-semibold transition-[filter] hover:brightness-110 disabled:opacity-40',
          th.action
        )}
      >
        {createGroup.isPending ? 'Creating…' : `Start conversation${selected.size ? ` (${selected.size + 1})` : ''}`}
      </button>
    </div>
  )
}

export function ChatPanel({
  open,
  onClose,
  renderMessageBody,
  requestedDm,
  requestedRoom
}: {
  open: boolean
  onClose: () => void
  renderMessageBody?: (m: ChatMessage, ctx: { mine: boolean }) => React.ReactNode
  /** External DM request (UserChip "Send message" via registerDmOpener) —
   *  nonce bumps re-trigger even for the same user. */
  requestedDm?: { userId: string; name?: string; nonce: number } | null
  /** Open this room directly (a toast click). Nonce-keyed like requestedDm so
   *  the same room can be re-opened after the reader navigates away. */
  requestedRoom?: { room: string; label?: string; nonce: number } | null
}) {
  const cfg = useChatConfig()
  const th = useTheme()
  const me = cfg.me
  const [tab, setTab] = useState<'online' | 'chat' | 'browse'>('online')
  const [activeRoom, setActiveRoom] = useState<{
    room: string
    label: string
    channel?: ChannelMeta | null
    unread?: number
  } | null>(null)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { rooms, totalUnread } = useChatRooms()
  /** Online people split into sections by the chosen attribute.
   *
   *  Each person appears EXACTLY ONCE. Someone covering three zones is grouped
   *  under their whole set ("Zone 1, Zone 2, Zone 3") rather than repeated in
   *  each zone: repeating them made one person render as three rows under an
   *  "Online · 1" header, which reads as three different people. Their full
   *  list is on the row itself either way, so nothing is hidden.
   *  '' = one unlabeled section, i.e. no grouping. */
  const buildOnlineSections = (
    list: typeof cfg.onlineUsers,
    by: string,
    extras: Map<string, PresenceExtra>
  ): Array<{ key: string; label: string | null; users: typeof cfg.onlineUsers }> => {
    if (!by) return [{ key: 'all', label: null, users: list }]
    const buckets = new Map<string, typeof cfg.onlineUsers>()
    for (const u of list) {
      const x = extras.get(String(u.user_id).toUpperCase())
      const values =
        by === '__role__'
          ? [humanLabel(x?.role_name ?? u.role_name) || 'No role']
          : (x?.scopes_by_dimension?.[by]?.length ? x.scopes_by_dimension[by] : ['Unassigned'])
      // Sorted so people with the same set land in the same bucket regardless
      // of the order their scope rows happened to come back in.
      const key = [...new Set(values)].sort((a, b) => a.localeCompare(b)).join(', ')
      buckets.set(key, [...(buckets.get(key) ?? []), u])
    }
    return [...buckets.entries()]
      .sort((a, b) => {
        // Unassigned last; everything else alphabetical.
        if (a[0] === 'Unassigned') return 1
        if (b[0] === 'Unassigned') return -1
        return a[0].localeCompare(b[0])
      })
      .map(([label, users]) => ({ key: label, label, users }))
  }

  const [groupBy, setGroupBy] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem('nvr_chat_group_by') ?? ''
  })
  const presenceExtras = usePresenceExtras()
  // The host's online list is an unscoped read of the presence collection; the
  // server decides who this viewer may SEE (restricted users see only people
  // restricted the same way, plus admins). Defer to it once it has answered —
  // before that, show nothing rather than briefly leaking the full list.
  const users = presenceExtras.loaded
    ? cfg.onlineUsers.filter((u) => presenceExtras.byUser.has(String(u.user_id).toUpperCase()))
    : []
  const onlineSections = useMemo(
    () => buildOnlineSections(users, groupBy, presenceExtras.byUser),
    // biome-ignore lint/correctness/useExhaustiveDependencies: builder is pure
    [users, groupBy, presenceExtras.byUser]
  )

  const { isAdmin } = useItemEditAuth()
  // NavigationContext always supplies navigate (its default is a plain hop),
  // so hosts that mount a router keep the SPA intact for free.
  const { navigate } = useNavigation()
  /** Replay may live on another origin (the admin SPA the API serves), which
   *  the host router cannot handle — send those to a new tab. */
  const openSession = (href: string) => {
    if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener')
    else navigate(href)
  }

  const openDm = (u: ChatOnlineUser) => {
    if (!me) return
    setTab('chat')
    setActiveRoom({ room: dmRoom(me.id, u.user_id), label: u.display_name ?? 'Direct message' })
  }

  // Adopt an externally-requested DM (nonce-keyed so repeat requests for the
  // same user re-open it after the reader navigated away).
  const lastDmNonce = useRef(0)
  useEffect(() => {
    if (!requestedDm || !me || requestedDm.nonce === lastDmNonce.current) return
    lastDmNonce.current = requestedDm.nonce
    setTab('chat')
    setSettingsOpen(false)
    setActiveRoom({
      room: dmRoom(me.id, requestedDm.userId),
      label: requestedDm.name ?? 'Direct message'
    })
  }, [requestedDm, me])

  const lastRoomNonce = useRef(0)
  useEffect(() => {
    if (!requestedRoom || requestedRoom.nonce === lastRoomNonce.current) return
    lastRoomNonce.current = requestedRoom.nonce
    setTab('chat')
    setSettingsOpen(false)
    setActiveRoom({ room: requestedRoom.room, label: requestedRoom.label ?? requestedRoom.room })
  }, [requestedRoom])

  if (!open) return null
  return (
    <div
      className='fixed inset-0 z-40 bg-black/40 animate-in fade-in duration-150'
      onClick={onClose}
      data-chat-panel
    >
      <aside
        className={cn(
          'absolute right-0 top-0 flex h-full w-full max-w-[400px] flex-col border-l shadow-2xl',
          'animate-in slide-in-from-right duration-200',
          th.surface,
          'border-slate-200 dark:border-border'
        )}
        onClick={(e) => e.stopPropagation()}
        aria-label='Team'
      >
        <div className={cn('flex shrink-0 items-center gap-2 border-b px-3.5 py-2.5', th.divider)}>
          <div className='flex gap-0.5 rounded-lg border border-slate-200 p-0.5 dark:border-border'>
            {(['online', 'chat', 'browse'] as const).map((t) => (
              <button
                key={t}
                type='button'
                onClick={() => {
                  setTab(t)
                  if (t === 'online') setActiveRoom(null)
                }}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition-colors',
                  tab === t
                    ? th.accentSoft
                    : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                )}
              >
                {t === 'online' ? `Online · ${users.length}` : t === 'chat' ? 'Chat' : 'Browse'}
                {t === 'chat' && totalUnread > 0 && (
                  <span
                    className={cn(
                      'flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9.5px] font-bold leading-none',
                      th.pill
                    )}
                    title={`${totalUnread} unread`}
                  >
                    {totalUnread > 99 ? '99+' : totalUnread}
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            type='button'
            onClick={onClose}
            className='ml-auto rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted'
            aria-label='Close panel'
          >
            <X className='h-4 w-4' strokeWidth={2} />
          </button>
        </div>

        {tab === 'online' ? (
          <div className='min-h-0 flex-1 overflow-y-auto p-2' data-chat-online>
            {/* Group by an attribute of the people listed — role, or any scope
                dimension the instance tracks (Zone, Region…). Purely a view
                preference, remembered per browser. */}
            <MyStatusRow myStatus={me ? (presenceExtras.byUser.get(String(me.id).toUpperCase())?.custom_status ?? null) : null} />
            {users.length > 0 && (
              <div className='mb-1.5 flex items-center gap-1.5 px-1'>
                <span className='text-[11px] text-slate-400'>Group by</span>
                <select
                  value={groupBy}
                  onChange={(e) => {
                    setGroupBy(e.target.value)
                    try {
                      localStorage.setItem('nvr_chat_group_by', e.target.value)
                    } catch {
                      /* private mode — the preference just won't persist */
                    }
                  }}
                  className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
                  data-chat-group-by
                >
                  <option value=''>No grouping</option>
                  <option value='__role__'>Role</option>
                  {presenceExtras.dimensions.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {users.length === 0 ? (
              <p className='px-3 py-8 text-center text-[12px] text-slate-400'>
                No one else is online right now.
              </p>
            ) : (
              onlineSections.map((section) => (
                <div key={section.key} data-chat-online-group={section.key}>
                  {section.label !== null && (
                    <div className='sticky top-0 z-[1] flex items-center gap-1.5 bg-white/95 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400 backdrop-blur dark:bg-card/95'>
                      {section.label}
                      <span className='font-normal normal-case text-slate-300'>{section.users.length}</span>
                    </div>
                  )}
                  {section.users.map((u) => {
                // /presence/online is the ONE classifier of idle: it weighs
                // last_active freshness against the row's is_idle bit, so a
                // host feeding raw table rows here (admin) must not disagree
                // with a host feeding the endpoint's own rows (efp-new).
                const px = presenceExtras.byUser.get(String(u.user_id).toUpperCase())
                const isIdle = px?.is_idle ?? u.is_idle
                const idleSrc = px ?? u
                return (
                <button
                  key={u.user_id}
                  type='button'
                  onClick={() => openDm(u)}
                  title='Send a direct message'
                  className='flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/50'
                >
                  <span className='relative'>
                    <Avatar id={u.user_id} name={u.display_name} />
                    <span
                      className={cn(
                        'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-card',
                        // Hollow amber rather than a second solid colour: idle
                        // is a weaker state than online, and should read that
                        // way at a glance rather than competing with it.
                        isIdle ? 'border-amber-400 bg-white dark:bg-card' : 'bg-emerald-400'
                      )}
                      title={isIdle ? idleLabel(idleSrc) : 'Online'}
                    />
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                      {u.display_name ?? 'Unknown user'}
                      {isIdle && (
                        <span className='ml-1.5 rounded-full bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400'>
                          {idleLabel(idleSrc)}
                        </span>
                      )}
                    </span>
                    {(() => {
                      const cs = presenceExtras.byUser.get(String(u.user_id).toUpperCase())?.custom_status
                      if (!cs) return null
                      return (
                        <span className='block truncate text-[11px] italic text-slate-500 dark:text-slate-400' data-chat-status>
                          {cs.emoji ? `${cs.emoji} ` : ''}
                          {cs.text}
                        </span>
                      )
                    })()}
                    <span className='block truncate text-[11px] text-slate-400'>
                      {(() => {
                        const x = presenceExtras.byUser.get(String(u.user_id).toUpperCase())
                        // Instance config decides which parts appear and in
                        // what order; the live page comes from the presence
                        // heartbeat, so it tracks people as they navigate.
                        const parts = presenceExtras.fields
                          .map((f) => {
                            if (f === 'role') return humanLabel(x?.role_name ?? u.role_name)
                            if (f === 'scopes') return (x?.scopes ?? []).join(', ') || null
                            if (f === 'page') {
                              // The server renders a record's display template
                              // ("Workflows › CR26-79811"); prettyPath can only
                              // reach the raw id, so it is the fallback.
                              const page =
                                (x as { page?: string | null })?.page ??
                                (u as { page?: string | null }).page ??
                                prettyPath(x?.current_path ?? u.current_path)
                              const app =
                                (x as { app?: string | null })?.app ??
                                (u as { app?: string | null }).app
                              // Only unusual places are worth naming; the
                              // ordinary frontend sends no app at all.
                              return app ? `${page ?? ''}${page ? ' · ' : ''}${app}`.trim() : page
                            }
                            return null
                          })
                          .filter(Boolean)
                        return parts.join(' · ') || 'Online'
                      })()}
                    </span>
                  </span>
                  {(() => {
                    // Admin-only: jump straight into this person's live session
                    // replay. Hidden unless a recording exists AND the host has
                    // a replay route.
                    const x = presenceExtras.byUser.get(String(u.user_id).toUpperCase())
                    if (!isAdmin || !x?.recording_id) return null
                    const base = presenceExtras.adminUrl?.replace(/\/$/, '') ?? ''
                    // The app that OWNS /session-replays supplies its own
                    // sessionUrl, so the default below is only ever used by a
                    // headless host. There, a base that is empty or resolves to
                    // this very origin cannot reach the replay page — it lands
                    // the viewer back in their own router (a dashboard, not an
                    // error), which reads as the feature being broken. Hide the
                    // action instead of opening a tab that goes nowhere.
                    const reachable =
                      !!base &&
                      (typeof window === 'undefined' ||
                        new URL(base, window.location.origin).origin !== window.location.origin)
                    const href = cfg.sessionUrl
                      ? cfg.sessionUrl(x.recording_id, String(u.user_id))
                      : reachable
                        ? `${base}/session-replays?recording=${x.recording_id}`
                        : null
                    if (!href) return null
                    return (
                      <span
                        role='link'
                        tabIndex={0}
                        title='Watch this session'
                        onClick={(e) => {
                          e.stopPropagation()
                          openSession(href)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation()
                            openSession(href)
                          }
                        }}
                        className='shrink-0 rounded p-1 text-slate-300 transition-colors hover:bg-slate-100 hover:text-nvr-cyan dark:hover:bg-muted'
                      >
                        <PlayCircle className='h-4 w-4' strokeWidth={1.8} />
                      </span>
                    )
                  })()}
                  <MessageCircle className='h-4 w-4 shrink-0 text-slate-300' strokeWidth={1.8} />
                </button>
                )
              })}
                </div>
              ))
            )}
          </div>
        ) : tab === 'browse' ? (
          // The tab is checked BEFORE the open room: leaving it last meant
          // switching to Browse with a conversation open kept showing that
          // conversation (or its settings) under the Browse tab.
          <ChatChannelBrowser
            onOpen={(room, label, channel) => {
              setSettingsOpen(false)
              setActiveRoom({ room, label, channel })
              setTab('chat')
            }}
          />
        ) : groupDialogOpen ? (
          <GroupDmDialog
            onClose={() => setGroupDialogOpen(false)}
            onCreated={(room, name) => {
              setGroupDialogOpen(false)
              setActiveRoom({ room, label: name })
            }}
          />
        ) : activeRoom && settingsOpen && activeRoom.channel ? (
          <ChatChannelSettings
            channel={activeRoom.channel}
            label={activeRoom.label}
            onBack={() => setSettingsOpen(false)}
          />
        ) : activeRoom ? (
          <ChatRoomView
            room={activeRoom.room}
            label={activeRoom.label}
            onOpenSettings={
              activeRoom.channel && !activeRoom.channel.is_direct
                ? () => setSettingsOpen(true)
                : undefined
            }
            onBack={() => setActiveRoom(null)}
            renderMessageBody={renderMessageBody}
            initialUnread={activeRoom.unread}
          />
        ) : (
          <ChatRoomList
            rooms={rooms}
            onOpen={(r) => {
              setSettingsOpen(false)
              setActiveRoom({ room: r.room, label: r.label, channel: r.channel, unread: r.unread })
            }}
            onNewGroup={() => setGroupDialogOpen(true)}
          />
        )}
      </aside>
    </div>
  )
}

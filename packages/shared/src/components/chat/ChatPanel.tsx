import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlarmClock,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  AtSign,
  Bell,
  BellOff,
  Bookmark,
  Check,
  CheckCheck,
  ChevronLeft,
  ClipboardPlus,
  ExternalLink,
  FilePlus2,
  Hash,
  HelpCircle,
  Info,
  Lock,
  LogOut,
  MessageCircle,
  MessageSquareReply,
  NotebookPen,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plane,
  PlayCircle,
  Plus,
  Quote,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  Users,
  Video,
  X
} from 'lucide-react'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNavigation, useNivaroClient } from '../../context'
import { get, patch as patchCmd, post } from '../../lib/commands'
import { invalidateRecordTasks } from '../../lib/record-tasks'
import { cn, formatRelative, getDisplayTimezone } from '../../lib/utils'
import { CustomStatusEditor } from '../CustomStatusEditor'
import { FilePreviewLightbox, type PreviewFile } from '../FilePreviewLightbox'
import { UserChip } from '../item-edit/GroupSection'
import { UserAvatar } from '../UserAvatar'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { BulkInvitePanel, ChannelAuditLog, ChannelExtrasEditor } from './ChannelExtras'
import { ChannelLookPicker, ChannelTile } from './ChannelLook'
import {
  CatchUpView,
  ChatSettingsButton,
  FilterToggle,
  MentionsView,
  ScheduledView,
  SearchFilterBar,
  useSearchFilterState
} from './ChatViews'
import { ChatComposer, type ComposerHandle } from './Composer'
import {
  CHAT_DEFAULTS,
  type ChannelMeta,
  type ChatAnchor,
  type ChatConfig,
  ChatConfigContext,
  type ChatMessage,
  type ChatOnlineUser,
  canOpenDm,
  chatAvatarColor,
  chatInitials,
  type DirectoryChannel,
  dmPeer,
  dmRoom,
  openDmWith,
  REACTION_EMOJI,
  type RoomInfo,
  useArchivedRooms,
  useChannelAdmin,
  useChannelDirectory,
  useChannelMembers,
  useChatBotInfo,
  useChatBotName,
  useChatConfig,
  useChatMessages,
  useChatRoles,
  useChatRooms,
  useChatSearch,
  useCreateChannel,
  useCreateGroupDm,
  useDeleteMessage,
  useEditMessage,
  useEntityRoomLink,
  useMarkRoomRead,
  useMyPreferences,
  useOpenRoomRegistration,
  useOutbox,
  usePeerReadAt,
  useRoomMembership,
  useRoomPins,
  useSendChatMessage,
  useSetMyPreferences,
  useTogglePin,
  useToggleReaction,
  useTypingIndicator,
  useUserSearch
} from './chat-core'
import { useRecordFileTargets, useRoomRecord } from './chat-hooks'
import { FormattedMessage, LinkPreviews, type TokenRenderer } from './MessageFormat'
import {
  ChannelIntro,
  JumpToDate,
  MemberCountLine,
  OutboxBubbles,
  RoomInfoDrawer,
  ThreadPane,
  WelcomeNote
} from './RoomParts'

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

const ChatThemeContext = {} as { current: ChatTheme }
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

type PresenceState = 'online' | 'idle' | 'away' | 'offline'

/** Last seen + own time zone for one person (GET /presence/people). */
interface PersonInfo {
  user_id: string
  last_seen: string | null
  timezone: string | null
  away: boolean
  out_of_office?: boolean
  ooo_end?: string | null
  delegate?: { id: string; name: string } | null
}

// Every badge and header that needs last seen in one render asks together:
// ids collected over one tick go out as a single request (100 per call).
const personBatch = new WeakMap<
  object,
  {
    ids: Map<string, Array<(v: PersonInfo | null) => void>>
    timer: ReturnType<typeof setTimeout> | null
  }
>()

function loadPersonInfo(
  client: ReturnType<typeof useNivaroClient>,
  id: string
): Promise<PersonInfo | null> {
  const key = String(id).toUpperCase()
  let batch = personBatch.get(client)
  if (!batch) {
    batch = { ids: new Map(), timer: null }
    personBatch.set(client, batch)
  }
  const b = batch
  return new Promise((resolve) => {
    const waiters = b.ids.get(key) ?? []
    waiters.push(resolve)
    b.ids.set(key, waiters)
    if (b.timer) return
    b.timer = setTimeout(async () => {
      const pending = new Map(b.ids)
      b.ids.clear()
      b.timer = null
      const ids = [...pending.keys()]
      const found = new Map<string, PersonInfo>()
      for (let i = 0; i < ids.length; i += 100) {
        try {
          const res = await client.request<{ data: PersonInfo[] }>(
            get('/presence/people', { ids: ids.slice(i, i + 100).join(',') })
          )
          for (const p of res.data ?? []) found.set(String(p.user_id).toUpperCase(), p)
        } catch {
          /* last seen is decoration — a failed read just leaves it out */
        }
      }
      for (const [k, list] of pending) for (const r of list) r(found.get(k) ?? null)
    }, 0)
  })
}

function usePersonInfo(id: string | null, enabled = true): PersonInfo | null {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-person-info', id ? String(id).toUpperCase() : null],
    queryFn: () => loadPersonInfo(client, id as string),
    enabled: !!id && enabled,
    staleTime: 60_000
  })
  return data ?? null
}

/** "last seen 3h ago" — or null when nothing is known. */
function lastSeenText(info: PersonInfo | null): string | null {
  return info?.last_seen ? `last seen ${formatRelative(info.last_seen)}` : null
}

/**
 * One person's presence as the Online tab reads it: /presence/online is the
 * classifier (it weighs last_active against the row's is_idle bit, honours
 * "appear away", and decides who this viewer may see); the host's online list
 * only stands in until that query has answered.
 */
function usePresenceOf(id: string): { state: PresenceState; title: string; page: string | null } {
  const cfg = useContext(ChatConfigContext)
  const extras = usePresenceExtras()
  const uid = String(id).toUpperCase()
  if (extras.loaded) {
    const px = extras.byUser.get(uid)
    if (!px) return { state: 'offline', title: 'Offline', page: null }
    // Where they are right now (#974) — only for people you may see online.
    const page = px.page ?? prettyPath(px.current_path)
    if (px.away) return { state: 'away', title: 'Away', page: null }
    return px.is_idle
      ? { state: 'idle', title: idleLabel(px), page }
      : { state: 'online', title: 'Online', page }
  }
  const u = cfg?.onlineUsers.find((o) => String(o.user_id).toUpperCase() === uid)
  if (!u) return { state: 'offline', title: 'Offline', page: null }
  return u.is_idle
    ? { state: 'idle', title: idleLabel(u), page: null }
    : { state: 'online', title: 'Online', page: null }
}

/** "Out of office until Fri, Oct 3" (#973). */
function oooText(info: PersonInfo | null): string | null {
  if (!info?.out_of_office) return null
  if (!info.ooo_end) return 'Out of office'
  const d = new Date(info.ooo_end)
  return `Out of office until ${d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: getDisplayTimezone() ?? undefined
  })}`
}

/** Online = solid green; idle and away = hollow amber (a weaker state, so it
 *  reads weaker than online rather than competing with it); offline = grey,
 *  with when they were last seen on hover. */
function PresenceBadge({ id, size }: { id: string; size: number }) {
  const { state, title, page } = usePresenceOf(id)
  const info = usePersonInfo(id)
  const seen = state === 'offline' ? lastSeenText(info) : null
  const ooo = oooText(info)
  const dot = size >= 30 ? 10 : 8
  const tip = [
    seen ? `Offline · ${seen}` : title,
    page && state !== 'offline' ? `On ${page}` : null,
    ooo,
    ooo && info?.delegate ? `${info.delegate.name} is covering` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <span
        className={cn(
          'absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-white dark:border-card',
          state === 'online'
            ? 'bg-emerald-400'
            : state === 'idle' || state === 'away'
              ? 'border-amber-400 bg-white dark:border-amber-400 dark:bg-card'
              : 'bg-slate-300 dark:bg-slate-600'
        )}
        style={{ width: dot, height: dot }}
        data-tip={tip}
        title={tip}
        data-chat-presence={state}
      />
      {ooo && (
        // Out of office is its own mark, top-right, so it reads beside any of
        // the four presence states rather than replacing one.
        <span
          className='absolute -right-1 -top-1 flex items-center justify-center rounded-full border-2 border-white bg-violet-600 text-white dark:border-card'
          style={{ width: dot + 2, height: dot + 2 }}
          data-chat-ooo
          title={tip}
          aria-label={ooo}
        >
          <Plane style={{ width: dot - 3, height: dot - 3 }} strokeWidth={2.5} />
        </span>
      )}
    </>
  )
}

function Avatar({
  id,
  name,
  size = 32,
  presence = true
}: {
  id: string
  name: string | null
  size?: number
  /** Show the online / idle / offline badge (off for the bot and non-people). */
  presence?: boolean
}) {
  const bot = useChatBotInfo()
  const disc = (
    <span
      className='flex shrink-0 items-center justify-center rounded-full font-semibold text-[#04263b]'
      style={{
        width: size,
        height: size,
        backgroundColor: chatAvatarColor(id),
        fontSize: size * 0.36
      }}
      aria-hidden
    >
      {chatInitials(name)}
    </span>
  )
  const avatar = (
    <UserAvatar
      userId={id}
      fallback={disc}
      style={{ width: size, height: size }}
      alt={name ?? ''}
    />
  )
  const isBot =
    id === '__bot__' ||
    (!!bot.bot_user_id && String(bot.bot_user_id).toUpperCase() === String(id).toUpperCase())
  if (!presence || isBot) return avatar
  return (
    <span className='relative inline-flex shrink-0' style={{ width: size, height: size }}>
      {avatar}
      <PresenceBadge id={id} size={size} />
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
        get<{
          data: Array<{
            prefix: string
            collection: string
            match_field: string
            is_active: boolean
          }>
        }>('/chat/room-types')
      )) as {
        data: Array<{ prefix: string; collection: string; match_field: string; is_active: boolean }>
      }
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
            get<{
              data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null
            }>(`/pipelines/instance/${t.collection}/${id}`)
          )) as {
            data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null
          }
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
    {
      k: '@name',
      kind: 'code',
      v: 'Mention someone — they get notified even with the panel closed.'
    },
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
      k: 'AB26-12345',
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
          open
            ? th.accentSoft
            : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
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
              <div
                key={t.k}
                className='col-span-2 grid grid-cols-subgrid border-b border-slate-100/70 py-2 last:border-b-0 dark:border-border/40'
              >
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
        get<{
          data: Array<{
            prefix: string
            collection: string
            match_field: string
            is_active: boolean
            label: string | null
          }>
        }>('/chat/room-types')
      )) as {
        data: Array<{
          prefix: string
          collection: string
          match_field: string
          is_active: boolean
          label: string | null
        }>
      }
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
        get<{
          data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null
        }>(`/pipelines/instance/${t.collection}/${id}`)
      )) as {
        data: { instance?: { current_state_obj?: { label?: string; color?: string } } } | null
      }
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

  const facts = useRoomRecord(room, isEntity && !!card)
  if (!isEntity || !card) return null
  const build = cfg.recordUrl ?? ((c: string, id: string | number) => `/collections/${c}/${id}`)
  const href = build(card.collection, card.id)
  const sla = facts?.sla ?? null
  const slaTone =
    sla?.status === 'breached'
      ? 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
      : sla?.status === 'warning'
        ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
        : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
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
      {sla && (
        <span
          className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold', slaTone)}
          title={
            sla.due_hours != null
              ? `${Math.round(sla.elapsed_hours ?? 0)}h in this state of ${sla.due_hours}h allowed`
              : undefined
          }
          data-chat-room-sla={sla.status}
        >
          {sla.status === 'breached'
            ? 'Past SLA'
            : sla.status === 'warning'
              ? 'SLA soon'
              : 'On time'}
        </span>
      )}
      {facts && facts.owners.length > 0 && (
        <span
          className='ml-auto flex -space-x-1.5'
          title={`Owners: ${facts.owners.map((o) => o.name).join(', ')}`}
          data-chat-room-owners={facts.owners.length}
        >
          {facts.owners.slice(0, 4).map((o) => (
            <Avatar key={o.id} id={o.id} name={o.name} size={18} presence={false} />
          ))}
          {facts.owners.length > 4 && (
            <span className='flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-slate-200 px-1 text-[9px] font-semibold text-slate-600 dark:bg-muted dark:text-slate-300'>
              +{facts.owners.length - 4}
            </span>
          )}
        </span>
      )}
      {href && (
        <button
          type='button'
          onClick={() => cfg.navigate?.(href)}
          className={cn(
            'text-[11px] font-medium hover:underline',
            facts?.owners.length ? 'ml-1.5' : 'ml-auto',
            th.accentText
          )}
        >
          Open
        </button>
      )}
    </div>
  )
}

/** "It's 7:40 PM for Beth" — only when their own zone differs from the viewer's. */
function localTimeFor(zone: string | null, name: string): string | null {
  if (!zone) return null
  const mine = getDisplayTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = new Date()
  let theirs: string
  let ours: string
  try {
    const fmt = (tz: string) =>
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(
        now
      )
    theirs = fmt(zone)
    ours = fmt(mine)
  } catch {
    return null
  }
  if (theirs === ours) return null
  const first = name.split(/\s+/)[0] || name
  return `${theirs} for ${first}`
}

/** Minute ticker, so a header clock and "last seen 3m ago" keep moving. */
function useMinuteTick(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  return n
}

/** The second header line of a 1:1 DM: what the other person is doing (or
 *  when they were last here) and, when it differs from yours, their time. */
function DmPeerLine({ peerId, name }: { peerId: string; name: string }) {
  useMinuteTick()
  const { state, title } = usePresenceOf(peerId)
  const info = usePersonInfo(peerId)
  const status =
    state === 'online'
      ? 'Active now'
      : state === 'offline'
        ? (() => {
            const seen = lastSeenText(info)
            return seen ? seen.charAt(0).toUpperCase() + seen.slice(1) : 'Offline'
          })()
        : title
  const local = localTimeFor(info?.timezone ?? null, name)
  const ooo = oooText(info)
  const delegate = ooo ? (info?.delegate ?? null) : null
  return (
    <p
      className='flex min-w-0 items-center gap-1.5 truncate text-[11px] text-slate-500 dark:text-slate-400'
      data-chat-dm-peer-line={state}
    >
      {ooo && (
        <>
          <span
            className='shrink-0 font-medium text-violet-700 dark:text-violet-300'
            data-chat-dm-ooo
          >
            {ooo}
          </span>
          {delegate && canOpenDm() && (
            <button
              type='button'
              onClick={() => openDmWith(delegate.id, delegate.name)}
              className='shrink-0 font-medium text-slate-700 underline decoration-dotted underline-offset-2 hover:text-slate-900 dark:text-slate-200 dark:hover:text-white'
              data-chat-dm-delegate={delegate.id}
            >
              Message {delegate.name} instead
            </button>
          )}
          <span aria-hidden>·</span>
        </>
      )}
      <span className='truncate'>{status}</span>
      {local && (
        <>
          <span aria-hidden>·</span>
          <span className='shrink-0' data-chat-dm-local-time title={info?.timezone ?? undefined}>
            {local}
          </span>
        </>
      )}
    </p>
  )
}

export function ChatRoomView({
  room,
  label,
  onBack,
  onOpenSettings,
  renderMessageBody,
  initialUnread,
  anchor: anchorProp = null
}: {
  room: string
  label: string
  onBack: () => void
  /** Channel rooms only — opens members/visibility settings. */
  onOpenSettings?: () => void
  renderMessageBody?: (m: ChatMessage, ctx: { mine: boolean }) => React.ReactNode
  /** Unread count at open — anchors the "New messages" divider. */
  initialUnread?: number
  /** Open around a message (a search hit, #977) or a day (#976). */
  anchor?: ChatAnchor
}) {
  const cfg = useChatConfig()
  const th = useTheme()
  const client = useNivaroClient()
  const me = cfg.me
  const [anchor, setAnchor] = useState<ChatAnchor>(anchorProp)
  useEffect(() => setAnchor(anchorProp), [anchorProp])
  const { messages, loading, hasOlder, hasNewer, loadOlder, loadingOlder } = useChatMessages(
    room,
    anchor
  )
  // While this room is on screen its messages need no toast or sound.
  useOpenRoomRegistration(room)
  const outbox = useOutbox(room)
  const markRead = useMarkRoomRead()
  const typing = useTypingIndicator(room)
  const peerReadAt = usePeerReadAt(room.startsWith('dm:') ? room : null)
  // Entity rooms link back to their record, routed by the host (recordUrl).
  const recordLink = useEntityRoomLink(room)
  const toggleReaction = useToggleReaction(room)
  const pins = useRoomPins(room)
  const togglePin = useTogglePin(room)
  const isEntityRoom =
    !room.startsWith('dm:') &&
    !room.startsWith('ch:') &&
    room !== cfg.globalRoom &&
    room.includes(':')
  const roomRecord = useRoomRecord(room, isEntityRoom)
  const fileTargets = useRecordFileTargets(room, !!roomRecord)
  // Seen-by (#147): members' read watermarks — "Seen by N" under your own
  // messages in group rooms (channels/group DMs; 1:1 DMs keep the check).
  const isGroupRoom = room.startsWith('ch:')
  const { data: readMarks = [] } = useQuery<
    Array<{ user: string; last_read_at: string; name: string }>
  >({
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
  const qcRoom = useQueryClient()
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
    onSuccess: () => void qcRoom.invalidateQueries({ queryKey: ['chat-saved'] })
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
    onSuccess: () => {
      if (roomRecord) invalidateRecordTasks(qcRoom, roomRecord.collection, roomRecord.id)
      toast.success('Task created from message — assigned to you')
    },
    onError: () => toast.error('Could not create a task')
  })
  // Send a message to the record's Notes (#946), attach a file to it (#949).
  const toNotes = useMutation({
    mutationFn: (m: ChatMessage) => client.request(post(`/chat/messages/${m.id}/to-notes`, {})),
    onSuccess: () => toast.success(`Copied to the Notes of ${roomRecord?.label ?? 'the record'}`),
    onError: (e) =>
      toast.error((e as { response?: { error?: string } })?.response?.error ?? 'Could not copy it')
  })
  const attachToRecord = useMutation({
    mutationFn: (v: { messageId: number; fileId: string; field: string }) =>
      client.request(
        post(`/chat/messages/${v.messageId}/attach-to-record`, {
          file_id: v.fileId,
          field: v.field
        })
      ),
    onSuccess: (_d, v) =>
      toast.success(
        `Attached to ${roomRecord?.label ?? 'the record'} — ${fileTargets.find((t) => t.field === v.field)?.label ?? v.field}`
      ),
    onError: (e) =>
      toast.error(
        (e as { response?: { error?: string } })?.response?.error ?? 'Could not attach it'
      )
  })
  const dismissPreview = useMutation({
    mutationFn: (id: number) =>
      client.request(patchCmd(`/chat/messages/${id}`, { no_preview: true })),
    onSuccess: () => void qcRoom.invalidateQueries({ queryKey: ['nvr-chat', room] })
  })
  const editMessage = useEditMessage(room)
  const deleteMessage = useDeleteMessage(room)
  // Admins may delete anyone's message (server enforces the same rule).
  const { isAdmin } = useItemEditAuth()
  const { setMuted, setNotifyMode, setArchived, setStarred, dismissWelcome, leave } =
    useRoomMembership()
  const { rooms: allRooms, loading: roomsLoading } = useChatRooms()
  const activeInfo = allRooms.find((r) => r.room === room) ?? null
  // An archived room is not in the main list — look it up in the archive so
  // its header (members, bell, unarchive) still works.
  const { rooms: archivedRooms } = useArchivedRooms(!roomsLoading && !activeInfo)
  const roomInfo = activeInfo ?? archivedRooms.find((r) => r.room === room) ?? null
  const archivable = canArchive(roomInfo)
  const botName = useChatBotName()
  const [searchOpen, setSearchOpen] = useState(false)
  const [msgSearch, setMsgSearch] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [preview, setPreview] = useState<PreviewFile | null>(null)
  const [notifyMenuOpen, setNotifyMenuOpen] = useState(false)
  const [threadRoot, setThreadRoot] = useState<number | null>(null)
  const [quote, setQuote] = useState<ChatMessage | null>(null)
  const [threadQuote, setThreadQuote] = useState<ChatMessage | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [unseen, setUnseen] = useState<{ count: number; firstId: number } | null>(null)
  const [flashId, setFlashId] = useState<number | null>(
    anchorProp && 'around' in anchorProp ? anchorProp.around : null
  )
  /** Set when MY message mentioned the bot — "…is thinking" until its reply
   *  arrives (or a timeout says it won't). */
  const [botAskedAt, setBotAskedAt] = useState<number | null>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const dividerRef = useRef<HTMLDivElement>(null)
  // Frozen at mount — markRead fires immediately, so the live rooms query
  // can't be the divider's source of truth.
  const initialUnreadRef = useRef(Math.max(0, initialUnread ?? 0))
  const firstScrollRef = useRef(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // True while the reader sits at the bottom. Content that grows AFTER the
  // room opens (record chips resolving their state, "Seen by", images) keeps
  // the view on the newest message only while this holds — someone reading
  // history is never pulled down.
  const pinnedRef = useRef(!anchorProp)
  const prevCountRef = useRef(0)
  const prevFirstRef = useRef<number | null>(null)
  const prevHeightRef = useRef(0)
  // Scroll the CONTAINER to its end: scrollIntoView on a marker aligns the
  // marker and leaves the container's bottom padding below the fold.
  const toBottom = () => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }
  const scrollToMessage = (id: number): boolean => {
    const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-chat-msg="${id}"]`)
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    pinnedRef.current = false
    setFlashId(id)
    return true
  }
  /** Show a message: in view if loaded, else reload the history around it. */
  const openMessage = (id: number) => {
    setInfoOpen(false)
    if (!scrollToMessage(id)) {
      firstScrollRef.current = false
      pinnedRef.current = false
      setFlashId(id)
      setAnchor({ around: id })
    }
  }
  useEffect(() => {
    if (flashId == null) return
    const t = setTimeout(() => setFlashId(null), 2400)
    return () => clearTimeout(t)
  }, [flashId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per room/anchor
  useEffect(() => {
    firstScrollRef.current = false
    prevCountRef.current = 0
    setUnseen(null)
  }, [room, anchor])

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per message change
  useEffect(() => {
    const el = scrollerRef.current
    const first = messages[0]?.id ?? null
    if (!firstScrollRef.current && messages.length > 0) {
      firstScrollRef.current = true
      prevCountRef.current = messages.length
      prevFirstRef.current = first
      if (flashId != null && scrollToMessage(flashId)) return
      // Land the reader AT the "New messages" line, not past it.
      if (dividerRef.current && !anchor) {
        dividerRef.current.scrollIntoView({ block: 'center' })
        pinnedRef.current = false
      } else if (!anchor) {
        toBottom()
        pinnedRef.current = true
      }
      return
    }
    // Older history loaded above: keep the reader where they were.
    if (first !== prevFirstRef.current && prevFirstRef.current != null && el) {
      el.scrollTop += el.scrollHeight - prevHeightRef.current
      prevFirstRef.current = first
      prevCountRef.current = messages.length
      return
    }
    prevFirstRef.current = first
    const added = messages.length - prevCountRef.current
    prevCountRef.current = messages.length
    if (added <= 0) return
    const last = messages[messages.length - 1]
    const mine = !!last?.sender && last.sender.toLowerCase() === me?.id?.toLowerCase()
    if (pinnedRef.current || mine) {
      toBottom()
      pinnedRef.current = true
      setUnseen(null)
    } else {
      // Reading history: count what arrived instead of pulling them down (#942).
      const firstNew = messages[messages.length - added]
      setUnseen((u) => ({ count: (u?.count ?? 0) + added, firstId: u?.firstId ?? firstNew.id }))
    }
  }, [messages])

  // Keep the newest message in view while the content settles.
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) toBottom()
      prevHeightRef.current = scrollerRef.current?.scrollHeight ?? 0
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  // Delivery timing sample for chat health (#989): one in five messages that
  // arrive while the room is open report how late they reached this browser.
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last || !firstScrollRef.current || last.sender?.toLowerCase() === me?.id?.toLowerCase())
      return
    const lag = Date.now() - new Date(last.date_created).getTime()
    if (lag > 0 && lag < 5 * 60_000 && Math.random() < 0.2) {
      void client.request(post('/chat/health/delivery', { ms: lag })).catch(() => {})
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: per newest message
  }, [messages[messages.length - 1]?.id])

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
        get<{
          data: Array<{
            id: string
            filename_download: string | null
            title: string | null
            type: string | null
            filesize: number | null
          }>
        }>('/files', {
          filter: JSON.stringify({ id: { _in: attachmentIds } }),
          limit: String(attachmentIds.length),
          fields: 'id,filename_download,title,type,filesize'
        })
      )) as {
        data: Array<{
          id: string
          filename_download: string | null
          title: string | null
          type: string | null
          filesize: number | null
        }>
      }
      return new Map((res.data ?? []).map((f) => [f.id, f]))
    },
    enabled: attachmentIds.length > 0,
    staleTime: 5 * 60_000
  })

  useEffect(() => {
    if (!anchor) markRead.mutate(room)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, messages.length, anchor])

  const onSent = (text: string) => {
    pinnedRef.current = true
    if (anchor) setAnchor(null)
    if (botName) {
      const esc = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`@\\[?${esc}\\]?\\b`, 'i').test(text)) setBotAskedAt(Date.now())
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
  const density = useMyPreferences().chat_density === 'compact' ? 'compact' : 'comfortable'
  const channel = roomInfo?.channel ?? null
  const ownsChannel =
    !!channel && !!me && String(channel.created_by ?? '').toUpperCase() === me.id.toUpperCase()
  const announceClosed =
    channel?.announce && !ownsChannel && !isAdmin
      ? 'Only the channel owner and admins post here. Hover a message and reply in its thread.'
      : null
  const showWelcome =
    !!channel?.welcome_note &&
    !!roomInfo?.joined &&
    !roomInfo?.welcome_seen_at &&
    !channel.is_direct

  const renderToken: TokenRenderer = (p, key) => {
    if (p.entity) return <EntityChip key={key} token={p.text} url={cfg.entityUrl(p.entity)} />
    if (p.mention)
      return (
        <span key={key} className={cn('rounded px-0.5 font-semibold', th.accentSoft)}>
          {p.text}
        </span>
      )
    return <span key={key}>{p.text}</span>
  }
  const renderTokenMine: TokenRenderer = (p, key) => {
    if (p.entity) return <EntityChip key={key} token={p.text} url={cfg.entityUrl(p.entity)} mine />
    if (p.mention)
      return (
        <span key={key} className='rounded bg-black/15 px-0.5 font-semibold'>
          {p.text}
        </span>
      )
    return <span key={key}>{p.text}</span>
  }

  /** One message, used by the timeline and the thread pane alike. */
  const renderRow = (
    m: ChatMessage,
    opts: {
      inThread?: boolean
      isLastMine?: boolean
      showSender?: boolean
    } = {}
  ) => {
    const mine = m.sender?.toLowerCase() === myId
    if (m.is_system) {
      return (
        <div
          className='flex justify-center px-4 py-0.5 text-center text-[11px] leading-snug text-slate-500 dark:text-slate-400'
          data-chat-msg={m.id}
          data-chat-system
        >
          <span>
            {m.message}
            <span className='ml-1.5 text-[10px] text-slate-400'>
              {new Date(m.date_created).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit'
              })}
            </span>
          </span>
        </div>
      )
    }
    const wasRead =
      opts.isLastMine && readTime > 0 && new Date(m.date_created).getTime() <= readTime
    const deleted = !!m.deleted_at
    const editable =
      mine && !deleted && Date.now() - new Date(m.date_created).getTime() < 15 * 60_000
    const deletable = !deleted && (mine || isAdmin)
    const isEditing = editingId === m.id
    const reactionGroups = new Map<string, { count: number; mine: boolean; names: string[] }>()
    for (const r of m.reactions ?? []) {
      const g = reactionGroups.get(r.emoji) ?? { count: 0, mine: false, names: [] }
      g.count++
      if (r.user?.toLowerCase() === myId) g.mine = true
      if (r.user_name) g.names.push(r.user_name)
      reactionGroups.set(r.emoji, g)
    }
    const toolBtn =
      'rounded-full p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
    return (
      <div
        className={cn(
          'group/msg flex gap-2 rounded-lg transition-colors',
          mine && 'flex-row-reverse',
          flashId === m.id && 'bg-[#00ceff1f]'
        )}
        data-chat-msg={m.id}
      >
        {!mine && (
          <UserChip userId={m.sender}>
            <button
              type='button'
              className='h-fit shrink-0 rounded-full'
              aria-label={`${m.sender_name ?? 'Sender'} — profile`}
              data-chat-avatar-card
            >
              <Avatar id={m.sender} name={m.sender_name} size={density === 'compact' ? 22 : 26} />
            </button>
          </UserChip>
        )}
        <div className={cn('relative max-w-[78%]', mine && 'text-right')}>
          {!mine && opts.showSender !== false && (
            <p className='mb-0.5 text-[10.5px] font-medium text-slate-500 dark:text-slate-400'>
              {m.sender_name ?? 'Unknown'}
              {m.masquerade_admin_name && (
                <span
                  className='ml-1 font-normal text-violet-600 dark:text-violet-300'
                  title={`Sent by ${m.masquerade_admin_name} while masquerading as ${m.sender_name ?? 'this person'}`}
                  data-chat-message-masquerade
                >
                  · via {m.masquerade_admin_name}
                </span>
              )}
            </p>
          )}
          {!deleted && !isEditing && (
            <div
              className={cn(
                'absolute -top-3 z-10 hidden items-center gap-0.5 rounded-full border px-1 py-0.5 shadow-sm group-hover/msg:flex',
                th.surface,
                'border-slate-200 dark:border-border',
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
              {!opts.inThread && !m.parent_id && (
                <button
                  type='button'
                  title='Reply in thread'
                  onClick={() => {
                    setInfoOpen(false)
                    setThreadRoot(m.id)
                  }}
                  className={toolBtn}
                  data-chat-reply-thread
                >
                  <MessageSquareReply className='h-3 w-3' />
                </button>
              )}
              <button
                type='button'
                title='Quote'
                onClick={() => (opts.inThread ? setThreadQuote(m) : setQuote(m))}
                className={toolBtn}
                data-chat-quote
              >
                <Quote className='h-3 w-3' />
              </button>
              {roomRecord && (
                <>
                  <button
                    type='button'
                    title='Make a task from this message'
                    onClick={() => makeTask.mutate(m)}
                    className={toolBtn}
                  >
                    <ClipboardPlus className='h-3 w-3' />
                  </button>
                  {m.message && (
                    <button
                      type='button'
                      title={`Copy into the Notes of ${roomRecord.label}`}
                      onClick={() => toNotes.mutate(m)}
                      className={toolBtn}
                      data-chat-to-notes
                    >
                      <NotebookPen className='h-3 w-3' />
                    </button>
                  )}
                </>
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
                title={
                  savedIds.has(m.id) ? 'Remove from saved' : 'Save for later (personal bookmark)'
                }
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
                  className={toolBtn}
                >
                  <Pencil className='h-3 w-3' />
                </button>
              )}
              {deletable &&
                (confirmDeleteId === m.id ? (
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
                ))}
            </div>
          )}
          {m.urgent && !deleted && (
            <p
              className={cn(
                'mb-0.5 flex items-center gap-1 text-[10.5px] font-semibold text-red-600 dark:text-red-400',
                mine && 'justify-end'
              )}
              data-chat-urgent
            >
              <AlertTriangle className='h-3 w-3' /> Urgent
            </p>
          )}
          {deleted ? (
            <div className='inline-block rounded-2xl border border-dashed border-slate-200 px-3 py-1.5 text-left text-[11.5px] italic text-slate-500 dark:border-border'>
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
                className={cn(
                  'h-8 w-[240px] rounded-lg border px-2 text-[12px] outline-none',
                  th.input
                )}
                aria-label='Edit message'
              />
              <button
                type='submit'
                className={cn('rounded-md px-1.5 py-1 text-[11px] font-medium', th.accentText)}
              >
                Save
              </button>
            </form>
          ) : (
            <div
              className={cn(
                'inline-block max-w-full rounded-2xl text-left leading-snug',
                density === 'compact' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[12.5px]',
                mine ? cn('rounded-br-md', th.bubbleMine) : cn('rounded-bl-md', th.bubbleOther),
                m.urgent && 'ring-2 ring-red-400/70'
              )}
            >
              {m.quote && (
                <button
                  type='button'
                  onClick={() => openMessage(m.quote!.id)}
                  className={cn(
                    'mb-1 block w-full rounded-md border-l-2 px-2 py-1 text-left text-[11px]',
                    mine
                      ? 'border-white/60 bg-black/10'
                      : 'border-slate-400 bg-white/70 dark:border-slate-500 dark:bg-black/20'
                  )}
                  data-chat-quote-block
                >
                  <span className='block font-semibold'>{m.quote.sender_name ?? 'Someone'}</span>
                  <span className='line-clamp-2 opacity-90'>
                    {m.quote.deleted
                      ? 'Message removed'
                      : m.quote.message || (m.quote.has_attachments ? 'Attachment' : '')}
                  </span>
                </button>
              )}
              {m.message &&
                (renderMessageBody ? (
                  renderMessageBody(m, { mine })
                ) : (
                  <FormattedMessage
                    text={m.message}
                    mine={mine}
                    renderToken={mine ? renderTokenMine : renderToken}
                    entityPattern={cfg.entityPattern}
                    timeRefs={m.time_refs}
                    navigate={cfg.navigate}
                  />
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
                    const attach =
                      roomRecord && fileTargets.length > 0 ? (
                        <AttachToRecordButton
                          targets={fileTargets}
                          recordLabel={roomRecord.label}
                          onPick={(field) =>
                            attachToRecord.mutate({ messageId: m.id, fileId: aid, field })
                          }
                        />
                      ) : null
                    return isImg ? (
                      <span key={aid} className='relative inline-block'>
                        <button
                          type='button'
                          onClick={openPreview}
                          className='block cursor-zoom-in'
                        >
                          <img
                            src={url}
                            alt={name}
                            className='max-h-40 max-w-[220px] rounded-lg object-cover'
                            loading='lazy'
                          />
                        </button>
                        {attach && <span className='absolute right-1 top-1'>{attach}</span>}
                      </span>
                    ) : (
                      <span key={aid} className='inline-flex items-center gap-1'>
                        <button
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
                        {attach}
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {!deleted && !isEditing && m.message && !m.no_preview && (
            <div className={cn(mine && 'flex justify-end')}>
              <LinkPreviews
                text={m.message}
                navigate={cfg.navigate}
                onDismiss={mine ? () => dismissPreview.mutate(m.id) : undefined}
              />
            </div>
          )}
          {reactionGroups.size > 0 && (
            <div
              className={cn('mt-0.5 flex flex-wrap gap-1', mine && 'justify-end')}
              data-chat-reactions
            >
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
          {!opts.inThread && m.thread && m.thread.count > 0 && (
            <button
              type='button'
              onClick={() => setThreadRoot(m.id)}
              className={cn(
                'mt-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] font-medium hover:bg-slate-100 dark:hover:bg-muted',
                th.accentText,
                mine && 'ml-auto'
              )}
              data-chat-thread-summary={m.thread.count}
            >
              <span className='flex -space-x-1.5'>
                {m.thread.people.slice(0, 3).map((p) => (
                  <Avatar key={p.id} id={p.id} name={p.name} size={16} presence={false} />
                ))}
              </span>
              {m.thread.count} {m.thread.count === 1 ? 'reply' : 'replies'}
              {m.thread.last_reply_at && (
                <span className='font-normal text-slate-500 dark:text-slate-400'>
                  · last {formatRelative(m.thread.last_reply_at)}
                </span>
              )}
            </button>
          )}
          <p className='mt-0.5 flex items-center justify-end gap-1 text-[10px] text-slate-500 dark:text-slate-400'>
            {!mine && <span className='mr-auto' />}
            {m.edited_at && !deleted && <span className='italic'>(edited)</span>}
            {new Date(m.date_created).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit'
            })}
            {mine &&
              isGroupRoom &&
              !deleted &&
              (() => {
                const seen = seenBy(m)
                if (seen.length === 0) return null
                return (
                  <SeenByPopover
                    seen={seen}
                    channelId={roomInfo?.channel?.id ?? null}
                    senderId={String(m.sender ?? '')}
                  />
                )
              })()}
            {opts.isLastMine &&
              room.startsWith('dm:') &&
              (wasRead ? (
                <span className={cn('inline-flex items-center gap-0.5 font-medium', th.accentText)}>
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
    )
  }

  const composer = (parentId: number | null) => (
    <ChatComposer
      ref={parentId ? undefined : composerRef}
      room={room}
      label={label}
      parentId={parentId}
      quote={parentId ? threadQuote : quote}
      onClearQuote={() => (parentId ? setThreadQuote(null) : setQuote(null))}
      onSent={onSent}
      disabledReason={parentId ? null : announceClosed}
      th={th}
      renderAvatar={(id, name) => (
        <Avatar id={id} name={name} size={22} presence={id !== '__bot__'} />
      )}
    />
  )

  return (
    <div
      className='relative flex h-full min-h-0 flex-col'
      data-chat-room={room}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') && !announceClosed) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragging(false)
        composerRef.current?.addFiles([...e.dataTransfer.files])
      }}
    >
      {dragging && (
        <div
          className='pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-nvr-cyan bg-white/85 text-[13px] font-semibold text-slate-700 dark:bg-card/90 dark:text-slate-100'
          data-chat-drop-target
        >
          Drop to attach to your message
        </div>
      )}
      <div className={cn('flex shrink-0 items-center gap-1.5 border-b px-3 py-2', th.divider)}>
        <button
          type='button'
          onClick={onBack}
          className='rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
          aria-label='Back to conversations'
        >
          <ChevronLeft className='h-4 w-4' strokeWidth={2} />
        </button>
        {roomInfo?.kind === 'channel' && !roomInfo.channel?.is_direct && (
          <ChannelTile icon={roomInfo.channel?.icon} color={roomInfo.channel?.color} size={24} />
        )}
        <div className='min-w-0 flex-1'>
          <p className='flex items-center gap-1 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
            <span className='truncate'>{label}</span>
            {channel?.announce && (
              <span
                className='shrink-0 rounded bg-slate-100 px-1 text-[9.5px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-muted dark:text-slate-300'
                title='Announcement channel — the owner and admins post, members reply in threads'
              >
                Announcements
              </span>
            )}
          </p>
          {me && dmPeer(room, me.id) ? (
            <DmPeerLine peerId={dmPeer(room, me.id) as string} name={label} />
          ) : room.startsWith('ch:') ? (
            <MemberCountLine
              room={room}
              me={cfg.me?.id ?? null}
              renderAvatar={(id, name) => <Avatar id={id} name={name} size={24} />}
            />
          ) : null}
        </div>
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
        {roomInfo && (
          <button
            type='button'
            onClick={() => setStarred.mutate({ room, starred: !roomInfo.starred })}
            className={cn(
              'rounded-md p-1 transition-colors',
              roomInfo.starred
                ? 'text-amber-500'
                : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
            )}
            aria-pressed={!!roomInfo.starred}
            aria-label={roomInfo.starred ? 'Unstar' : 'Star — keep it at the top of your list'}
            title={
              roomInfo.starred
                ? 'Starred — click to unstar'
                : 'Star — keep it at the top of your list'
            }
            data-chat-star={roomInfo.starred ? 'on' : 'off'}
          >
            <Star
              className={cn('h-3.5 w-3.5', roomInfo.starred && 'fill-current')}
              strokeWidth={2}
            />
          </button>
        )}
        <ChatTipsButton botName={botName} />
        <JumpToDate
          onJump={(d) => {
            firstScrollRef.current = false
            pinnedRef.current = false
            setAnchor({ date: d })
          }}
        />
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
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
          )}
          aria-label='Search in this conversation'
        >
          <Search className='h-3.5 w-3.5' strokeWidth={2} />
        </button>
        {roomInfo?.channel?.is_direct && (
          <GroupMembersButton channel={roomInfo.channel} onLeft={onBack} />
        )}
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
            className='rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
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
                  : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
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
                    [
                      'mentions',
                      'Mentions only',
                      !roomInfo.muted && roomInfo.notify_mode === 'mentions'
                    ],
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
                      active
                        ? th.accentSoft
                        : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-muted'
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
        {roomInfo?.kind === 'entity' && roomInfo.joined && (
          <button
            type='button'
            onClick={() =>
              leave.mutate(room, {
                onSuccess: () => {
                  toast.success(`Left ${roomInfo.label}`, {
                    description: "Open the record's chat again to rejoin."
                  })
                  onBack()
                }
              })
            }
            title="Leave this record's chat — it leaves your list; open it from the record again to rejoin"
            aria-label="Leave this record's chat"
            className='rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
            data-chat-leave-room
          >
            <LogOut className='h-3.5 w-3.5' strokeWidth={2} />
          </button>
        )}
        {roomInfo && archivable && (
          <button
            type='button'
            onClick={() =>
              setArchived.mutate(
                { room, archived: !roomInfo.archived },
                {
                  onSuccess: () => {
                    if (roomInfo.archived) toast.success('Moved back to your chats')
                    else {
                      toast.success('Archived for you — others in the conversation still see it', {
                        description: 'Find it under the Archived tab.'
                      })
                      onBack()
                    }
                  }
                }
              )
            }
            title={
              roomInfo.archived
                ? 'Unarchive — back to your chats'
                : 'Archive for me — hides it from my list and stops my alerts. Others in the conversation are not affected.'
            }
            aria-label={
              roomInfo.archived ? 'Unarchive conversation' : 'Archive conversation for me'
            }
            className='rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
            data-chat-archive={roomInfo.archived ? 'unarchive' : 'archive'}
          >
            {roomInfo.archived ? (
              <ArchiveRestore className='h-3.5 w-3.5' strokeWidth={2} />
            ) : (
              <Archive className='h-3.5 w-3.5' strokeWidth={2} />
            )}
          </button>
        )}
        <button
          type='button'
          onClick={() => {
            setThreadRoot(null)
            setInfoOpen((o) => !o)
          }}
          className={cn(
            'rounded-md p-1 transition-colors',
            infoOpen
              ? th.accentSoft
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
          )}
          aria-label='Room info — members, pinned, files and links'
          title='Room info — members, pinned, files and links'
          data-chat-info-button
        >
          <Info className='h-3.5 w-3.5' strokeWidth={2} />
        </button>
        {onOpenSettings && (
          <button
            type='button'
            onClick={onOpenSettings}
            className='rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
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
      {channel && !channel.is_direct && (
        <ChannelIntro
          description={channel.description}
          links={channel.links}
          th={th}
          navigate={cfg.navigate}
        />
      )}
      {pins.length > 0 && (
        <div className={cn('shrink-0 border-b px-3 py-1', th.divider)} data-chat-pins-strip>
          <button
            type='button'
            onClick={() => {
              setThreadRoot(null)
              setInfoOpen(true)
            }}
            className='flex w-full items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400'
          >
            <Pin className='h-3 w-3' strokeWidth={2} />
            {pins.length} pinned
            <ChevronLeft className='ml-auto h-3 w-3 -rotate-90' />
          </button>
        </div>
      )}
      {showWelcome && channel?.welcome_note && (
        <WelcomeNote
          note={channel.welcome_note}
          channelName={label}
          th={th}
          onDismiss={() => dismissWelcome.mutate(room)}
        />
      )}
      <div
        ref={scrollerRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          prevHeightRef.current = el.scrollHeight
          if (pinnedRef.current && unseen) setUnseen(null)
        }}
        className='relative min-h-0 flex-1 overflow-y-auto px-3 py-3'
        data-chat-messages
      >
        <div ref={contentRef} className={density === 'compact' ? 'space-y-1' : 'space-y-2.5'}>
          {hasOlder && !searching && (
            <div className='flex justify-center'>
              <button
                type='button'
                disabled={loadingOlder}
                onClick={() => {
                  prevHeightRef.current = scrollerRef.current?.scrollHeight ?? 0
                  void loadOlder()
                }}
                className='rounded-full border border-slate-200 px-2.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-300'
                data-chat-load-older
              >
                {loadingOlder ? 'Loading…' : 'Load earlier messages'}
              </button>
            </div>
          )}
          {loading ? (
            <p className='py-6 text-center text-[12px] text-slate-500'>Loading…</p>
          ) : visibleMessages.length === 0 && outbox.length === 0 ? (
            <div className='py-6 text-center text-[12px] text-slate-500'>
              {searching ? (
                'No messages match.'
              ) : anchor ? (
                'Nothing was said around then.'
              ) : (
                <>
                  <p>No messages yet — say hello.</p>
                  <p className='mt-1 text-[11px]'>
                    Tip: @ mentions someone{botName ? `, @${botName} asks the AI` : ''}, # inserts a
                    record, and a record ID like AB26-12345 becomes a live link.
                  </p>
                </>
              )}
            </div>
          ) : (
            visibleMessages.map((m, idx) => {
              const prev = visibleMessages[idx - 1]
              const newDay =
                idx === 0 ||
                (prev &&
                  new Date(prev.date_created).toDateString() !==
                    new Date(m.date_created).toDateString())
              // "New messages" — anchored to the unread count frozen at open.
              const showUnreadDivider =
                !searching &&
                !anchor &&
                initialUnreadRef.current > 0 &&
                idx === Math.max(0, visibleMessages.length - initialUnreadRef.current)
              // Compact: consecutive messages from one person within 5 minutes
              // drop the repeated name.
              const grouped =
                density === 'compact' &&
                !newDay &&
                !!prev &&
                prev.sender === m.sender &&
                !prev.is_system &&
                new Date(m.date_created).getTime() - new Date(prev.date_created).getTime() <
                  5 * 60_000
              return (
                <div key={m.id}>
                  {newDay && (
                    <div className='my-2 flex items-center gap-2'>
                      <span className='h-px flex-1 bg-slate-100 dark:bg-border' />
                      <span className='text-[10px] font-medium text-slate-500 dark:text-slate-400'>
                        {dateDivider(m.date_created)}
                      </span>
                      <span className='h-px flex-1 bg-slate-100 dark:bg-border' />
                    </div>
                  )}
                  {showUnreadDivider && (
                    <div
                      ref={dividerRef}
                      className='my-2 flex items-center gap-2'
                      data-chat-unread-divider
                    >
                      <span className='h-px flex-1 bg-red-300 dark:bg-red-500/50' />
                      <span className='text-[10px] font-semibold uppercase tracking-wide text-red-500'>
                        New messages
                      </span>
                      {initialUnreadRef.current > 20 && (
                        <button
                          type='button'
                          disabled={catchupMut.isPending}
                          onClick={() => catchupMut.mutate()}
                          className='rounded-full border border-red-200 px-1.5 py-px text-[9.5px] font-medium text-red-500 hover:text-red-600 disabled:opacity-50 dark:border-red-500/40'
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
                  {renderRow(m, {
                    isLastMine: m.sender?.toLowerCase() === myId && idx === lastMineIndex,
                    showSender: !grouped
                  })}
                </div>
              )
            })
          )}
          {!searching && !hasNewer && <OutboxBubbles items={outbox} th={th} />}
        </div>
      </div>
      {(unseen || hasNewer) && (
        <div className='pointer-events-none relative z-10 -mt-9 flex h-9 shrink-0 items-center justify-center'>
          <button
            type='button'
            onClick={() => {
              if (hasNewer) {
                firstScrollRef.current = false
                pinnedRef.current = true
                setAnchor(null)
                return
              }
              if (unseen && !scrollToMessage(unseen.firstId)) toBottom()
              setUnseen(null)
            }}
            className={cn(
              'pointer-events-auto rounded-full px-3 py-1 text-[11.5px] font-semibold shadow-md',
              th.pill
            )}
            data-chat-new-pill={unseen?.count ?? 0}
          >
            {hasNewer
              ? 'Jump to the latest ↓'
              : `${unseen?.count} new ${unseen?.count === 1 ? 'message' : 'messages'} ↓`}
          </button>
        </div>
      )}
      <div className='min-h-[18px] shrink-0 px-3.5'>
        {botAskedAt && botName ? (
          <p
            className='flex items-center gap-1.5 text-[11px] italic text-slate-500'
            data-chat-bot-thinking
          >
            <span className='inline-flex gap-0.5'>
              <span className='h-1 w-1 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]' />
              <span className='h-1 w-1 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]' />
              <span className='h-1 w-1 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]' />
            </span>
            {botName} is thinking…
          </p>
        ) : (
          typing.typingText && (
            <p className='text-[11px] italic text-slate-500'>{typing.typingText}</p>
          )
        )}
      </div>
      {preview && <FilePreviewLightbox file={preview} onClose={() => setPreview(null)} />}
      {composer(null)}
      {threadRoot != null && (
        <ThreadPane
          room={room}
          rootId={threadRoot}
          th={th}
          onClose={() => setThreadRoot(null)}
          renderRow={(m) => renderRow(m, { inThread: true })}
          renderComposer={(pid) => composer(pid)}
          renderOutbox={(pid) => <ThreadOutbox room={room} parentId={pid} th={th} />}
        />
      )}
      {infoOpen && (
        <RoomInfoDrawer
          room={room}
          label={label}
          th={th}
          pins={pins}
          onClose={() => setInfoOpen(false)}
          onOpenMessage={openMessage}
          onUnpin={(id) => togglePin.mutate(id)}
          navigate={cfg.navigate}
          renderAvatar={(id, name) => <Avatar id={id} name={name} size={22} />}
        />
      )}
    </div>
  )
}

function ThreadOutbox({ room, parentId, th }: { room: string; parentId: number; th: ChatTheme }) {
  const items = useOutbox(room, parentId)
  return <OutboxBubbles items={items} th={th} />
}

/** "Attach to the record" on a chat file (#949): pick the record's file field. */
function AttachToRecordButton({
  targets,
  recordLabel,
  onPick
}: {
  targets: Array<{ field: string; label: string }>
  recordLabel: string
  onPick: (field: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='rounded-full border border-slate-200 bg-white p-0.5 text-slate-500 shadow-sm hover:text-slate-800 dark:border-border dark:bg-card dark:hover:text-slate-100'
          title={`Attach to ${recordLabel}`}
          aria-label={`Attach to ${recordLabel}`}
          data-chat-attach-to-record
        >
          <FilePlus2 className='h-3 w-3' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[220px] p-1.5'>
        <p className='px-2 pb-1 pt-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
          Attach to {recordLabel}
        </p>
        {targets.map((t) => (
          <button
            key={t.field}
            type='button'
            onClick={() => {
              setOpen(false)
              onPick(t.field)
            }}
            className='flex w-full rounded-md px-2 py-1.5 text-left text-[12px] text-slate-700 hover:bg-muted dark:text-slate-200'
          >
            {t.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function channelMeta(c: DirectoryChannel): ChannelMeta {
  return {
    id: c.id,
    visibility: c.visibility,
    role: c.role,
    topic: c.topic,
    created_by: (c as { created_by?: string | null }).created_by ?? null,
    icon: c.icon ?? null,
    color: c.color ?? null
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

/** Short, local, 12-hour: "8:04 PM" today, "Mon 8:04 PM" this week, else "Sep 21, 8:04 PM". */
function readTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return time
  const days = (now.getTime() - d.getTime()) / 86_400_000
  if (days < 6) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}

/**
 * "Seen by N" under your own message in a group: click it for who has read it
 * and who has not yet. A read watermark records when someone last caught up
 * on the room, so the time shown is when they read up to (at least) this
 * message — not the exact second their eyes passed over it.
 */
function SeenByPopover({
  seen,
  channelId,
  senderId
}: {
  seen: Array<{ user: string; last_read_at: string; name: string }>
  channelId: number | null
  senderId: string
}) {
  const th = useTheme()
  const [open, setOpen] = useState(false)
  // Members only matter once the list is open (who has NOT read it yet).
  const { members } = useChannelMembers(open ? channelId : null)
  const seenIds = new Set(seen.map((s) => String(s.user).toUpperCase()))
  const notYet = members.filter((mb) => {
    const id = String(mb.user).toUpperCase()
    return id !== senderId.toUpperCase() && !seenIds.has(id)
  })
  const sorted = [...seen].sort(
    (a, b) => new Date(a.last_read_at).getTime() - new Date(b.last_read_at).getTime()
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid',
            th.accentText
          )}
          aria-label={`Seen by ${seen.length} — show who`}
          data-chat-seen-by={seen.length}
        >
          Seen by {seen.length}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        sideOffset={4}
        className={cn('w-[240px] p-0', th.surface)}
        data-chat-seen-by-panel
      >
        <p className='border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400 dark:border-border'>
          Seen by {seen.length}
        </p>
        <div className='max-h-[260px] overflow-y-auto py-1'>
          {sorted.map((s) => (
            <div key={s.user} className='flex items-center gap-2 px-3 py-1.5'>
              <Avatar id={s.user} name={s.name || null} size={22} />
              <span className='min-w-0 flex-1 truncate text-[12px] text-slate-700 dark:text-slate-200'>
                {s.name || 'Someone'}
              </span>
              <span
                className='shrink-0 text-[10.5px] tabular-nums text-slate-400'
                data-tip={`Last read the conversation ${new Date(s.last_read_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`}
              >
                {readTime(s.last_read_at)}
              </span>
            </div>
          ))}
          {notYet.length > 0 && (
            <>
              <p className='px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400'>
                Not seen yet · {notYet.length}
              </p>
              {notYet.map((mb) => {
                const nm =
                  [mb.first_name, mb.last_name].filter(Boolean).join(' ') || mb.email || 'Someone'
                return (
                  <div key={mb.user} className='flex items-center gap-2 px-3 py-1.5 opacity-70'>
                    <Avatar id={mb.user} name={nm} size={22} />
                    <span className='min-w-0 flex-1 truncate text-[12px] text-slate-600 dark:text-slate-300'>
                      {nm}
                    </span>
                  </div>
                )
              })}
            </>
          )}
        </div>
        <p className='border-t border-slate-100 px-3 py-1.5 text-[10.5px] leading-snug text-slate-400 dark:border-border'>
          Times are when each person last caught up on this conversation.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Who is in a group conversation. Group DMs have no settings page (they are
 * conversations, not channels), so the member list lives behind a header
 * button: everyone can see who is here and leave; whoever started the group
 * (or an admin) can add and remove people.
 */
function GroupMembersButton({ channel, onLeft }: { channel: ChannelMeta; onLeft: () => void }) {
  const th = useTheme()
  const cfg = useChatConfig()
  const { isAdmin } = useItemEditAuth()
  const [open, setOpen] = useState(false)
  const { members, loading } = useChannelMembers(channel.id)
  const { addMember, removeMember } = useChannelAdmin(channel.id)
  const [search, setSearch] = useState('')
  const debounced = useDebouncedValue(search, 250)
  const meId = cfg.me?.id.toUpperCase() ?? ''
  const canEdit = isAdmin || (!!meId && String(channel.created_by ?? '').toUpperCase() === meId)
  const { users } = useUserSearch(debounced, open && canEdit && !!search.trim())
  const memberIds = new Set(members.map((m) => String(m.user).toUpperCase()))
  const nameOf = (m: {
    first_name: string | null
    last_name: string | null
    email: string | null
    user: string
  }) => [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.user
  const sorted = [...members].sort((a, b) => {
    const ua = String(a.user).toUpperCase()
    const ub = String(b.user).toUpperCase()
    if (ua === meId) return -1
    if (ub === meId) return 1
    return nameOf(a).localeCompare(nameOf(b))
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          title='People in this conversation'
          aria-label='People in this conversation'
          className={cn(
            'flex items-center gap-1 rounded-md px-1 py-1 text-[11px] font-medium tabular-nums transition-colors',
            open
              ? th.accentSoft
              : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
          )}
          data-chat-group-members
        >
          <Users className='h-3.5 w-3.5' strokeWidth={2} />
          {members.length > 0 && members.length}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        sideOffset={6}
        className={cn('w-[260px] p-0', th.surface)}
        data-chat-group-members-panel
      >
        <div className={cn('border-b px-3 py-2', th.divider)}>
          <p className='text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400'>
            In this conversation {members.length > 0 && `· ${members.length}`}
          </p>
        </div>
        <div className='max-h-[280px] overflow-y-auto py-1'>
          {loading && <p className='px-3 py-2 text-[12px] text-slate-400'>Loading…</p>}
          {sorted.map((m) => {
            const uid = String(m.user).toUpperCase()
            const nm = nameOf(m)
            const isMe = uid === meId
            const isOwner = String(channel.created_by ?? '').toUpperCase() === uid
            return (
              <div
                key={m.user}
                className='group flex items-center gap-2 px-3 py-1.5'
                data-chat-group-member={m.user}
              >
                <Avatar id={m.user} name={nm} size={26} />
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-[12.5px] text-slate-700 dark:text-slate-200'>
                    {nm}
                    {isMe && <span className='text-slate-400'> (you)</span>}
                  </span>
                  {isOwner && (
                    <span className='block text-[10.5px] text-slate-400'>Started the group</span>
                  )}
                </span>
                {canEdit && !isMe && (
                  <button
                    type='button'
                    title={`Remove ${nm}`}
                    aria-label={`Remove ${nm}`}
                    onClick={() => removeMember.mutate(m.user)}
                    className='rounded p-1 text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-red-500 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-muted'
                  >
                    <X className='h-3 w-3' />
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {canEdit && (
          <div className={cn('border-t px-3 py-2', th.divider)}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Add someone…'
              className={cn('h-7 w-full rounded-md px-2 text-[12px] outline-none', th.input)}
              data-chat-group-add
            />
            {search.trim() && (
              <div className='mt-1 max-h-36 overflow-y-auto'>
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
                          setSearch('')
                        }}
                        className='flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-muted'
                      >
                        <Avatar id={u.id} name={nm} size={22} />
                        <span className='min-w-0 flex-1 truncate text-[12px] text-slate-700 dark:text-slate-200'>
                          {nm}
                        </span>
                      </button>
                    )
                  })}
              </div>
            )}
          </div>
        )}
        {meId && memberIds.has(meId) && (
          <div className={cn('border-t px-3 py-1.5', th.divider)}>
            <button
              type='button'
              onClick={() => {
                removeMember.mutate(cfg.me!.id, {
                  onSuccess: () => {
                    setOpen(false)
                    onLeft()
                  }
                })
              }}
              className='text-[11.5px] font-medium text-red-500 hover:underline'
              data-chat-group-leave
            >
              Leave conversation
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
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
  const [look, setLook] = useState<{ icon: string | null; color: string | null }>({
    icon: channel.icon ?? null,
    color: channel.color ?? null
  })
  const [memberSearch, setMemberSearch] = useState('')
  const debounced = useDebouncedValue(memberSearch, 250)
  const { users } = useUserSearch(debounced, visibility === 'private')

  const canEdit = isAdmin || (!!cfg.me && String(channel.created_by ?? '') === String(cfg.me.id))
  const memberIds = new Set(members.map((m) => String(m.user).toUpperCase()))
  const dirty =
    name !== label ||
    topic !== (channel.topic ?? '') ||
    visibility !== channel.visibility ||
    look.icon !== (channel.icon ?? null) ||
    look.color !== (channel.color ?? null) ||
    (visibility === 'role' && role !== (channel.role ?? ''))

  return (
    <div className='flex min-h-0 flex-1 flex-col' data-chat-settings>
      <div className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-2.5', th.divider)}>
        <button
          type='button'
          onClick={onBack}
          className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-100'
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
            {!channel.is_direct && (
              <div className='flex items-start gap-3'>
                <ChannelTile icon={look.icon} color={look.color} size={40} />
                <div className='min-w-0 flex-1'>
                  <ChannelLookPicker icon={look.icon} color={look.color} onChange={setLook} />
                </div>
              </div>
            )}
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
              <span className='mb-1 block text-[11px] font-medium text-slate-400'>
                Who can see it
              </span>
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
                  className={cn(
                    'mt-2 h-8 w-full rounded-md px-2 text-[12.5px] outline-none',
                    th.input
                  )}
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
                    role: visibility === 'role' ? role : null,
                    icon: look.icon,
                    color: look.color
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
            {!channel.is_direct && (
              <ChannelExtrasEditor channel={channel} th={th} isAdmin={isAdmin} />
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
          {canEdit && !channel.is_direct && (
            <div className='mt-2'>
              <BulkInvitePanel channelId={channel.id} th={th} />
            </div>
          )}
        </div>
        {!channel.is_direct && <ChannelAuditLog channelId={channel.id} th={th} />}
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

/** Direct messages, group conversations and record rooms can be archived;
 *  channels are left instead. */
function canArchive(r: RoomInfo | null): boolean {
  if (!r) return false
  return r.kind === 'dm' || r.kind === 'entity' || (r.kind === 'channel' && !!r.channel?.is_direct)
}

type SidebarSort = 'recent' | 'unread' | 'alpha'

const SIDEBAR_SORTS: Array<{ value: SidebarSort; label: string }> = [
  { value: 'recent', label: 'Recent activity' },
  { value: 'unread', label: 'Unread first' },
  { value: 'alpha', label: 'A–Z' }
]

function lastAt(r: RoomInfo): number {
  return r.lastMessage?.date_created ? new Date(r.lastMessage.date_created).getTime() : 0
}

/** Order within each sidebar group; ties fall back to the name. */
function sortRooms(rooms: RoomInfo[], mode: SidebarSort): RoomInfo[] {
  const byName = (a: RoomInfo, b: RoomInfo) => a.label.localeCompare(b.label)
  const byRecent = (a: RoomInfo, b: RoomInfo) => lastAt(b) - lastAt(a) || byName(a, b)
  const list = [...rooms]
  if (mode === 'alpha') return list.sort(byName)
  if (mode === 'unread')
    return list.sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || byRecent(a, b))
  return list.sort(byRecent)
}

/** How the room list is ordered — remembered on the person, across devices. */
function SidebarSortButton({
  value,
  onChange
}: {
  value: SidebarSort
  onChange: (v: SidebarSort) => void
}) {
  const [open, setOpen] = useState(false)
  const current = SIDEBAR_SORTS.find((o) => o.value === value) ?? SIDEBAR_SORTS[0]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          title={`Sort: ${current.label}`}
          aria-label={`Sort rooms: ${current.label}`}
          className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:text-slate-400 dark:hover:bg-muted'
          data-chat-sort={value}
        >
          <ArrowUpDown className='h-3.5 w-3.5' strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-44 p-1'>
        <p className='px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400'>
          Sort rooms
        </p>
        {SIDEBAR_SORTS.map((o) => (
          <button
            key={o.value}
            type='button'
            onClick={() => {
              onChange(o.value)
              setOpen(false)
            }}
            className='flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-slate-200'
            data-chat-sort-option={o.value}
          >
            {o.label}
            {o.value === value && <Check className='h-3.5 w-3.5' strokeWidth={2} />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export function ChatRoomList({
  rooms,
  onOpen,
  onNewGroup,
  archivedView = false,
  loading = false,
  onView
}: {
  rooms: RoomInfo[]
  onOpen: (room: RoomInfo, anchor?: ChatAnchor) => void
  /** Opens the group-conversation composer (host renders the dialog). */
  onNewGroup?: () => void
  /** Opens the mentions / scheduled / catch-up views (host renders them). */
  onView?: (view: 'mentions' | 'scheduled' | 'catchup') => void
  /** The Archived tab: no assistant entry, rows offer Unarchive. */
  archivedView?: boolean
  loading?: boolean
}) {
  const th = useTheme()
  const cfg = useChatConfig()
  const { setMuted, leave, setArchived, setStarred } = useRoomMembership()
  const sf = useSearchFilterState()
  const presence = useMemo(
    () =>
      new Map(
        cfg.onlineUsers.map((u) => [
          String(u.user_id).toUpperCase(),
          u.is_idle ? ('idle' as const) : ('online' as const)
        ])
      ),
    [cfg.onlineUsers]
  )
  const bot = useChatBotInfo()
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 250)
  // Cross-room message search rides the same box: type ≥2 chars and matching
  // MESSAGES appear under the filtered room list.
  const { hits, loading: searching } = useChatSearch(q, sf.filters)
  const searchActive = q.length >= 2 || sf.active
  // Hits grouped by room, busiest room first (#987).
  const hitGroups = useMemo(() => {
    const m = new Map<string, typeof hits>()
    for (const h of hits) m.set(h.room, [...(m.get(h.room) ?? []), h])
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [hits])
  const unreadRooms = rooms.filter((r) => r.unread > 0 && !r.muted).length
  const roomByKey = useMemo(() => new Map(rooms.map((r) => [r.room, r])), [rooms])
  const prefs = useMyPreferences()
  const setPrefs = useSetMyPreferences()
  const sortMode: SidebarSort =
    prefs.chat_sidebar_sort === 'unread' || prefs.chat_sidebar_sort === 'alpha'
      ? prefs.chat_sidebar_sort
      : 'recent'
  const filteredRooms = sortRooms(
    q ? rooms.filter((r) => r.label.toLowerCase().includes(q.toLowerCase())) : rooms,
    sortMode
  )
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
          className={cn(
            'h-7 min-w-0 flex-1 rounded-md border px-2 text-[12px] outline-none',
            th.input
          )}
          aria-label='Search rooms and messages'
          data-chat-global-search
        />
        {!archivedView && (
          <FilterToggle open={sf.open} active={sf.active} onClick={() => sf.setOpen(!sf.open)} />
        )}
        <SidebarSortButton
          value={sortMode}
          onChange={(v) => setPrefs.mutate({ chat_sidebar_sort: v === 'recent' ? null : v })}
        />
        {!archivedView && <ChatSettingsButton />}
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
      {!archivedView && sf.open && (
        <SearchFilterBar filters={sf.filters} onChange={sf.setFilters} rooms={rooms} th={th} />
      )}
      {!archivedView && onView && !searchActive && (
        <div className='mb-1 flex flex-wrap gap-1 px-1' data-chat-view-links>
          <button
            type='button'
            onClick={() => onView('mentions')}
            className='inline-flex h-6 items-center gap-1 rounded-full border border-slate-200 px-2 text-[11px] text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
            data-chat-view='mentions'
          >
            <AtSign className='h-3 w-3' /> Mentions
          </button>
          <button
            type='button'
            onClick={() => onView('scheduled')}
            className='inline-flex h-6 items-center gap-1 rounded-full border border-slate-200 px-2 text-[11px] text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
            data-chat-view='scheduled'
          >
            <AlarmClock className='h-3 w-3' /> Scheduled
          </button>
          {unreadRooms > 1 && (
            <button
              type='button'
              onClick={() => onView('catchup')}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium',
                th.accentSoft
              )}
              data-chat-view='catchup'
            >
              <Sparkles className='h-3 w-3' /> Catch up · {unreadRooms} rooms
            </button>
          )}
        </div>
      )}
      {searchActive && !archivedView && (
        <div className='mb-1.5' data-chat-search-results>
          <p className='px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400'>
            Messages{hits.length ? ` · ${hits.length}` : ''}
          </p>
          {searching ? (
            <p className='px-2.5 py-1 text-[11px] text-slate-400'>Searching…</p>
          ) : hits.length === 0 ? (
            <p className='px-2.5 py-1 text-[11px] text-slate-400'>No messages match.</p>
          ) : (
            hitGroups.map(([roomKey, group]) => {
              const r = roomByKey.get(roomKey)
              return (
                <div key={roomKey} className='mb-1' data-chat-search-group={roomKey}>
                  <p className='flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                    <span className='truncate'>{r?.label ?? roomKey}</span>
                    <span className='rounded-full bg-slate-100 px-1.5 text-[10px] font-medium tabular-nums text-slate-500 dark:bg-muted dark:text-slate-400'>
                      {group.length}
                    </span>
                  </p>
                  {group.slice(0, 5).map((h) => (
                    <button
                      key={h.id}
                      type='button'
                      disabled={!r}
                      onClick={() => {
                        if (r) onOpen(r, { around: h.parent_id ?? h.id })
                      }}
                      className='flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-slate-50 disabled:cursor-default dark:hover:bg-muted/50'
                      data-chat-search-hit={h.id}
                    >
                      <span className='flex items-center gap-1.5 text-[10.5px] text-slate-400'>
                        <span className='truncate'>{h.sender_name ?? 'Someone'}</span>
                        <span className='ml-auto shrink-0'>
                          {new Date(h.date_created).toLocaleDateString()}
                        </span>
                      </span>
                      <span className='line-clamp-2 text-[12px] text-slate-700 dark:text-slate-200'>
                        {h.message}
                      </span>
                    </button>
                  ))}
                  {group.length > 5 && r && (
                    <button
                      type='button'
                      onClick={() => sf.setFilters({ ...sf.filters, room: roomKey })}
                      className={cn('px-2.5 py-0.5 text-[11px] font-medium', th.accentText)}
                    >
                      All {group.length} in {r.label}
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
      {archivedView && !loading && rooms.length === 0 && (
        <p className='px-3 py-6 text-center text-[12px] leading-relaxed text-slate-400'>
          Nothing archived. Archiving is just for you: the conversation leaves your chat list and
          stops alerting you, while everyone else in it carries on as before. Archive from a room's
          header or its row in your chat list; writing in it again brings it back.
        </p>
      )}
      {archivedView && loading && <p className='px-3 py-3 text-[12px] text-slate-400'>Loading…</p>}
      {!archivedView && bot.bot_name && bot.bot_user_id && cfg.me && (
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
          <span
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold',
              th.accentSoft
            )}
          >
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
          ['Starred', filteredRooms.filter((r) => r.starred)],
          [
            'Channels',
            filteredRooms.filter(
              (r) => !r.starred && (r.kind === 'global' || r.kind === 'channel') && !isGroupDm(r)
            )
          ],
          [
            'Direct messages',
            filteredRooms.filter((r) => !r.starred && (r.kind === 'dm' || isGroupDm(r)))
          ],
          ['Records', filteredRooms.filter((r) => !r.starred && r.kind === 'entity')]
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
                  {(() => {
                    const peer = r.kind === 'dm' && cfg.me ? dmPeer(r.room, cfg.me.id) : null
                    if (!peer) return null
                    const state = presence.get(peer.toUpperCase()) ?? 'offline'
                    return (
                      <span className='relative shrink-0' data-chat-room-avatar={state}>
                        <Avatar id={peer} name={r.label} size={32} />
                      </span>
                    )
                  })()}
                  {r.kind === 'channel' && !r.channel?.is_direct ? (
                    <ChannelTile icon={r.channel?.icon} color={r.channel?.color} size={32} />
                  ) : (
                    <span
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400',
                        r.kind === 'dm' && cfg.me && dmPeer(r.room, cfg.me.id) && 'hidden'
                      )}
                    >
                      {r.kind === 'dm' ? (
                        <MessageCircle className='h-4 w-4' strokeWidth={1.8} />
                      ) : r.channel?.is_direct ? (
                        <Users className='h-4 w-4' strokeWidth={1.8} />
                      ) : (
                        <Hash className='h-4 w-4' strokeWidth={1.8} />
                      )}
                    </span>
                  )}
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
                  {(r.mentions ?? 0) > 0 && (
                    <span
                      className='flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white'
                      title={`${r.mentions} mention you`}
                      data-chat-room-mentions={r.mentions}
                    >
                      @
                    </span>
                  )}
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
                  {!archivedView && (
                    <button
                      type='button'
                      title={r.starred ? 'Unstar' : 'Star — keep it at the top'}
                      aria-label={r.starred ? `Unstar ${r.label}` : `Star ${r.label}`}
                      onClick={() => setStarred.mutate({ room: r.room, starred: !r.starred })}
                      className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
                      data-chat-row-star={r.starred ? 'on' : 'off'}
                    >
                      <Star
                        className={cn('h-3 w-3', r.starred && 'fill-amber-400 text-amber-500')}
                      />
                    </button>
                  )}
                  {canArchive(r) && (
                    <button
                      type='button'
                      title={
                        archivedView
                          ? 'Unarchive — back to your chats'
                          : 'Archive for me — hides it from my list and stops my alerts. Others in the conversation are not affected.'
                      }
                      aria-label={
                        archivedView ? `Unarchive ${r.label}` : `Archive ${r.label} for me`
                      }
                      onClick={() => setArchived.mutate({ room: r.room, archived: !archivedView })}
                      className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
                      data-chat-row-archive={archivedView ? 'unarchive' : 'archive'}
                    >
                      {archivedView ? (
                        <ArchiveRestore className='h-3 w-3' />
                      ) : (
                        <Archive className='h-3 w-3' />
                      )}
                    </button>
                  )}
                  <button
                    type='button'
                    title={r.muted ? 'Unmute' : 'Mute'}
                    onClick={() => setMuted.mutate({ room: r.room, muted: !r.muted })}
                    className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
                  >
                    {r.muted ? <Bell className='h-3 w-3' /> : <BellOff className='h-3 w-3' />}
                  </button>
                  {(r.kind === 'channel' || r.kind === 'global' || r.kind === 'entity') &&
                    r.joined && (
                      <button
                        type='button'
                        title={
                          r.kind === 'global'
                            ? 'Leave General'
                            : r.kind === 'entity'
                              ? "Leave this record's chat — open it from the record again to rejoin"
                              : 'Leave channel'
                        }
                        aria-label={`Leave ${r.label}`}
                        data-chat-row-leave
                        onClick={() => leave.mutate(r.room)}
                        className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100'
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
 * The mentions / scheduled / catch-up views for hosts that lay chat out
 * themselves (the admin /chat workspace). The slide-over panel renders the
 * same views internally.
 */
export function ChatSideView({
  view,
  rooms,
  onBack,
  onOpen
}: {
  view: 'mentions' | 'scheduled' | 'catchup'
  rooms: RoomInfo[]
  onBack: () => void
  onOpen: (room: string, label: string, anchor?: ChatAnchor) => void
}) {
  const th = useTheme()
  if (view === 'mentions') return <MentionsView th={th} onBack={onBack} onOpen={onOpen} />
  if (view === 'scheduled')
    return (
      <ScheduledView
        th={th}
        onBack={onBack}
        roomLabel={(room) => rooms.find((r) => r.room === room)?.label ?? room}
      />
    )
  return <CatchUpView rooms={rooms} th={th} onBack={onBack} onOpen={onOpen} />
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
  const [look, setLook] = useState<{ icon: string | null; color: string | null }>({
    icon: null,
    color: null
  })
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
          className={cn(
            'flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium',
            th.action
          )}
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
              {
                name: name.trim(),
                visibility,
                role: visibility === 'role' ? role : null,
                icon: look.icon,
                color: look.color
              },
              {
                onSuccess: () => {
                  setName('')
                  setLook({ icon: null, color: null })
                  setCreating(false)
                }
              }
            )
          }}
        >
          <div className='flex items-center gap-2'>
            <ChannelTile icon={look.icon} color={look.color} size={32} />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Channel name'
              className={cn(
                'h-8 min-w-0 flex-1 rounded-md px-2 text-[12.5px] outline-none',
                th.input
              )}
            />
          </div>
          <ChannelLookPicker icon={look.icon} color={look.color} onChange={setLook} />
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
                  visibility === v
                    ? th.accentSoft
                    : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
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
              Channels and General are shared rooms you join to follow. Record conversations appear
              on their own once someone posts on a record.
            </p>
          </div>
        )}
        {channels.map((c) => (
          <div
            key={c.key}
            className='flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-slate-50 dark:hover:bg-muted/50'
          >
            <ChannelTile
              icon={c.icon}
              color={c.color}
              size={32}
              fallback={c.visibility === 'private' ? Lock : Hash}
            />
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
                onClick={() => onOpen(c.room, c.name, channelMeta(c))}
                className='shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
              >
                Open
              </button>
            ) : (
              <button
                type='button'
                onClick={() =>
                  join.mutate(c.room, {
                    onSuccess: () => onOpen(c.room, c.name, channelMeta(c))
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
  /** An admin is masquerading as this person right now. */
  masquerade?: { admin_id: string | null; admin_name: string } | null
  /** The person chose "appear away" — reads as away whatever they are doing. */
  away?: boolean
}

/** End of today in the viewer's clock, for "until tomorrow". */
function endOfToday(): Date {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d
}

/**
 * "Appear away" (#952): the Online list, badges and DM headers show you as
 * away whatever you are doing, until you switch it off or the time runs out.
 */
export function ChatAppearAwayRow() {
  const prefs = useMyPreferences()
  const setPrefs = useSetMyPreferences()
  const [open, setOpen] = useState(false)
  const po = prefs.presence_override as { mode?: string; until?: string | null } | null | undefined
  const active =
    !!po && po.mode === 'away' && !(po.until && new Date(po.until).getTime() < Date.now())
  const set = (until: Date | null | 'off') => {
    setPrefs.mutate({
      presence_override:
        until === 'off' ? null : { mode: 'away', until: until?.toISOString() ?? null }
    })
    setOpen(false)
  }
  const untilText =
    active && po?.until
      ? `until ${new Date(po.until).toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: getDisplayTimezone() ?? undefined
        })}`
      : active
        ? 'until you switch it off'
        : null
  return (
    <div
      className='mb-1.5 flex items-center gap-2 px-1 text-[12px]'
      data-chat-appear-away={active ? 'on' : 'off'}
    >
      <span
        className={cn(
          'h-2.5 w-2.5 shrink-0 rounded-full border-2',
          active ? 'border-amber-400 bg-white dark:bg-card' : 'border-emerald-400 bg-emerald-400'
        )}
        aria-hidden
      />
      <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
        {active ? `Appearing away ${untilText}` : 'You appear online'}
      </span>
      {active ? (
        <button
          type='button'
          onClick={() => set('off')}
          className='shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
          data-chat-appear-away-off
        >
          Back online
        </button>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
              data-chat-appear-away-open
            >
              Appear away
            </button>
          </PopoverTrigger>
          <PopoverContent align='end' className='w-48 p-1'>
            <p className='px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400'>
              Appear away for
            </p>
            {(
              [
                ['1 hour', () => new Date(Date.now() + 3600_000)],
                ['4 hours', () => new Date(Date.now() + 4 * 3600_000)],
                ['The rest of today', endOfToday],
                ['Until I switch it off', () => null]
              ] as Array<[string, () => Date | null]>
            ).map(([label, until]) => (
              <button
                key={label}
                type='button'
                onClick={() => set(until())}
                className='flex w-full rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-slate-200'
                data-chat-appear-away-option={label}
              >
                {label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

/** Set-your-status control (#33): free text + emoji, self-clearing. Saved in
 *  user preferences; /presence/online serves it to every host. */
function MyStatusRow({ myStatus }: { myStatus: { text: string; emoji: string | null } | null }) {
  const th = useTheme()
  return (
    <CustomStatusEditor
      status={myStatus ? { text: myStatus.text, emoji: myStatus.emoji } : null}
      theme={{ accentSoft: th.accentSoft, input: th.input, action: th.action }}
      className='mb-1.5 px-1'
    />
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
    .map((p, i) => (i === 0 ? p.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : p))
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
  const displayName = (u: {
    first_name: string | null
    last_name: string | null
    email: string | null
  }) => [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.email ?? 'Unknown')

  return (
    <div className='flex min-h-0 flex-1 flex-col p-3' data-chat-group-dialog>
      <div className='mb-2 flex items-center gap-2'>
        <button
          type='button'
          onClick={onClose}
          className='rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
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
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                th.accentSoft
              )}
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
        className={cn(
          'mb-2 mt-1.5 h-8 rounded-md border px-2.5 text-[12.5px] outline-none',
          th.input
        )}
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
        {createGroup.isPending
          ? 'Creating…'
          : `Start conversation${selected.size ? ` (${selected.size + 1})` : ''}`}
      </button>
    </div>
  )
}

const PIN_KEY = 'nvr-chat-pinned'
/** Width the pinned panel takes from the page. */
const PINNED_WIDTH = 400

/** Whether this browser pinned the chat panel open — hosts read it for their
 *  initial open state, so a pinned panel is still there after a reload. */
export function isChatPanelPinned(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(PIN_KEY) === '1'
  } catch {
    return false
  }
}

function useWideViewport(): boolean {
  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
  )
  useEffect(() => {
    const mq = window.matchMedia?.(query)
    if (!mq) return
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
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
  // Pinned: the panel docks beside the page instead of covering it — no
  // backdrop, the page narrows to make room, and it stays through navigation.
  // Only on wide screens; a phone keeps the overlay.
  const [pinnedPref, setPinnedPref] = useState(isChatPanelPinned)
  const wide = useWideViewport()
  const pinned = pinnedPref && wide
  const togglePinned = () => {
    const next = !pinnedPref
    setPinnedPref(next)
    try {
      if (next) window.localStorage.setItem(PIN_KEY, '1')
      else window.localStorage.removeItem(PIN_KEY)
    } catch {
      /* private window — pinned for this visit only */
    }
  }
  useEffect(() => {
    if (!open || !pinned) return
    const body = document.body
    const before = body.style.paddingRight
    body.style.paddingRight = `${PINNED_WIDTH}px`
    body.dataset.nvrChatPinned = '1'
    // Things that float at the page's right edge (toasts, the bug button,
    // import chips) would land on the panel — over the message box. They move
    // over by the panel's width while it is pinned. A host marks any other
    // floating widget with data-nvr-dock-aware.
    const style = document.createElement('style')
    style.dataset.nvrChatPinnedStyle = ''
    style.textContent = `body[data-nvr-chat-pinned] [data-sonner-toaster][data-x-position="right"],
body[data-nvr-chat-pinned] [data-nvr-dock-aware] { margin-right: ${PINNED_WIDTH}px; }`
    document.head.appendChild(style)
    return () => {
      body.style.paddingRight = before
      delete body.dataset.nvrChatPinned
      style.remove()
    }
  }, [open, pinned])
  const [tab, setTab] = useState<'online' | 'chat' | 'browse' | 'archived'>('online')
  const [activeRoom, setActiveRoom] = useState<{
    room: string
    label: string
    channel?: ChannelMeta | null
    unread?: number
    anchor?: ChatAnchor
  } | null>(null)
  const [chatView, setChatView] = useState<'mentions' | 'scheduled' | 'catchup' | null>(null)
  const openFromView = (room: string, label: string, anchor?: ChatAnchor) => {
    const r = rooms.find((x) => x.room === room)
    setSettingsOpen(false)
    // The view stays set, so Back from the room returns to it.
    setActiveRoom({ room, label: r?.label ?? label, channel: r?.channel, anchor })
  }
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The Archived tab keeps its own open room, so each tab returns to where
  // the person left it.
  const [archivedRoom, setArchivedRoom] = useState<{ room: string; label: string } | null>(null)
  const { rooms, totalUnread } = useChatRooms()
  const archived = useArchivedRooms(tab === 'archived')
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
          : x?.scopes_by_dimension?.[by]?.length
            ? x.scopes_by_dimension[by]
            : ['Unassigned']
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
      className={
        pinned
          ? // No backdrop: the rest of the page stays usable.
            'pointer-events-none fixed inset-y-0 right-0 z-40'
          : 'fixed inset-0 z-40 bg-black/40 animate-in fade-in duration-150'
      }
      style={pinned ? { width: PINNED_WIDTH } : undefined}
      onClick={pinned ? undefined : onClose}
      data-chat-panel
      data-chat-pinned={pinned ? '1' : undefined}
    >
      <aside
        className={cn(
          'pointer-events-auto absolute right-0 top-0 flex h-full w-full flex-col border-l',
          pinned
            ? 'max-w-none'
            : 'max-w-[400px] shadow-2xl animate-in slide-in-from-right duration-200',
          th.surface,
          'border-slate-200 dark:border-border'
        )}
        onClick={(e) => e.stopPropagation()}
        aria-label='Team'
      >
        <div className={cn('flex shrink-0 items-center gap-2 border-b px-3.5 py-2.5', th.divider)}>
          <div className='flex gap-0.5 rounded-lg border border-slate-200 p-0.5 dark:border-border'>
            {(['online', 'chat', 'browse', 'archived'] as const).map((t) => (
              <button
                key={t}
                type='button'
                // The open conversation survives a visit to another tab —
                // coming back to Chat returns to where the person was.
                onClick={() => setTab(t)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                  tab === t
                    ? th.accentSoft
                    : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                )}
              >
                {t === 'online'
                  ? `Online · ${users.length}`
                  : t === 'chat'
                    ? 'Chat'
                    : t === 'browse'
                      ? 'Browse'
                      : 'Archived'}
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
            onClick={togglePinned}
            aria-pressed={pinnedPref}
            title={
              pinnedPref
                ? 'Unpin — go back to opening chat over the page'
                : 'Pin — keep chat open beside the page while you work'
            }
            aria-label={pinnedPref ? 'Unpin chat panel' : 'Pin chat panel'}
            className={cn(
              'ml-auto hidden rounded-md p-1.5 transition-colors lg:flex',
              pinnedPref
                ? th.accentSoft
                : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
            )}
            data-chat-pin={pinnedPref ? 'on' : 'off'}
          >
            {pinnedPref ? (
              <PinOff className='h-4 w-4' strokeWidth={2} />
            ) : (
              <Pin className='h-4 w-4' strokeWidth={2} />
            )}
          </button>
          <button
            type='button'
            onClick={onClose}
            className='rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 max-lg:ml-auto dark:hover:bg-white/10 dark:hover:text-slate-100'
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
            <MyStatusRow
              myStatus={
                me
                  ? (presenceExtras.byUser.get(String(me.id).toUpperCase())?.custom_status ?? null)
                  : null
              }
            />
            <ChatAppearAwayRow />
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
                      <span className='font-normal normal-case text-slate-300'>
                        {section.users.length}
                      </span>
                    </div>
                  )}
                  {section.users.map((u) => {
                    // /presence/online is the ONE classifier of idle: it weighs
                    // last_active freshness against the row's is_idle bit, so a
                    // host feeding raw table rows here (admin) must not disagree
                    // with a host feeding the endpoint's own rows (a portal).
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
                        <Avatar id={u.user_id} name={u.display_name} />
                        <span className='min-w-0 flex-1'>
                          <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                            {u.display_name ?? 'Unknown user'}
                            {isIdle && (
                              <span className='ml-1.5 rounded-full bg-amber-500/10 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400'>
                                {px?.away ? 'Away' : idleLabel(idleSrc)}
                              </span>
                            )}
                            {(() => {
                              const mq = presenceExtras.byUser.get(
                                String(u.user_id).toUpperCase()
                              )?.masquerade
                              if (!mq) return null
                              return (
                                <span
                                  className='ml-1.5 rounded-full bg-violet-500/10 px-1.5 py-px text-[10px] font-medium text-violet-700 dark:bg-violet-400/15 dark:text-violet-300'
                                  title={`${mq.admin_name} is signed in as this person right now`}
                                  data-chat-masquerade={mq.admin_id ?? ''}
                                >
                                  {mq.admin_name} masquerading
                                </span>
                              )
                            })()}
                          </span>
                          {(() => {
                            const cs = presenceExtras.byUser.get(
                              String(u.user_id).toUpperCase()
                            )?.custom_status
                            if (!cs) return null
                            return (
                              <span
                                className='block truncate text-[11px] italic text-slate-500 dark:text-slate-400'
                                data-chat-status
                              >
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
                                    // ("Orders › AB26-12345"); prettyPath can only
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
                                    return app
                                      ? `${page ?? ''}${page ? ' · ' : ''}${app}`.trim()
                                      : page
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
                              new URL(base, window.location.origin).origin !==
                                window.location.origin)
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
                        <MessageCircle
                          className='h-4 w-4 shrink-0 text-slate-300'
                          strokeWidth={1.8}
                        />
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        ) : tab === 'archived' ? (
          archivedRoom ? (
            <ChatRoomView
              room={archivedRoom.room}
              label={archivedRoom.label}
              onBack={() => setArchivedRoom(null)}
              renderMessageBody={renderMessageBody}
            />
          ) : (
            <ChatRoomList
              rooms={archived.rooms}
              loading={archived.loading}
              archivedView
              onOpen={(r) => setArchivedRoom({ room: r.room, label: r.label })}
            />
          )
        ) : tab === 'browse' ? (
          // The tab is checked BEFORE the open room: leaving it last meant
          // switching to Browse with a conversation open kept showing that
          // conversation (or its settings) under the Browse tab.
          <ChatChannelBrowser
            onOpen={(room, label, channel) => {
              setSettingsOpen(false)
              // General rides the directory with id 0 — it has no channel row,
              // so no settings/members surface behind it.
              setActiveRoom({ room, label, channel: channel.id > 0 ? channel : undefined })
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
            anchor={activeRoom.anchor ?? null}
          />
        ) : chatView === 'mentions' ? (
          <MentionsView th={th} onBack={() => setChatView(null)} onOpen={openFromView} />
        ) : chatView === 'scheduled' ? (
          <ScheduledView
            th={th}
            onBack={() => setChatView(null)}
            roomLabel={(room) => rooms.find((r) => r.room === room)?.label ?? room}
          />
        ) : chatView === 'catchup' ? (
          <CatchUpView
            rooms={rooms}
            th={th}
            onBack={() => setChatView(null)}
            onOpen={openFromView}
          />
        ) : (
          <ChatRoomList
            rooms={rooms}
            onOpen={(r, anchor) => {
              setSettingsOpen(false)
              setActiveRoom({
                room: r.room,
                label: r.label,
                channel: r.channel,
                unread: r.unread,
                anchor
              })
            }}
            onNewGroup={() => setGroupDialogOpen(true)}
            onView={setChatView}
          />
        )}
      </aside>
    </div>
  )
}

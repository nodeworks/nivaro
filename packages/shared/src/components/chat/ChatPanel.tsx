import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronLeft,
  ExternalLink,
  Hash,
  Lock,
  LogOut,
  MessageCircle,
  Plus,
  PlayCircle,
  Search,
  Send,
  Settings,
  X
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useItemEditAuth, useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import {
  CHAT_DEFAULTS,
  type ChatConfig,
  ChatConfigContext,
  type ChatMessage,
  type ChatOnlineUser,
  type RoomInfo,
  chatAvatarColor,
  chatInitials,
  dmRoom,
  getMentionQuery,
  splitMessageTokens,
  type ChannelMeta,
  type DirectoryChannel,
  useChannelAdmin,
  useChannelDirectory,
  useChannelMembers,
  useChatConfig,
  useChatRoles,
  useChatMessages,
  useChatRooms,
  useCreateChannel,
  useEntityRoomLink,
  useMarkRoomRead,
  useRoomMembership,
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

function MessageBody({ text, mine }: { text: string; mine?: boolean }) {
  const cfg = useChatConfig()
  const th = useTheme()
  const parts = useMemo(() => splitMessageTokens(text, cfg.entityPattern), [text, cfg.entityPattern])
  return (
    <>
      {parts.map((p, i) => {
        if (p.entity) {
          const url = cfg.entityUrl(p.entity)
          return url ? (
            <button
              key={i}
              type='button'
              onClick={() => cfg.navigate?.(url)}
              className={cn(
                'font-medium underline-offset-2 hover:underline',
                mine ? 'underline' : th.accentText
              )}
            >
              {p.text}
            </button>
          ) : (
            <span key={i}>{p.text}</span>
          )
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

export function ChatRoomView({
  room,
  label,
  onBack,
  onOpenSettings,
  renderMessageBody
}: {
  room: string
  label: string
  onBack: () => void
  /** Channel rooms only — opens members/visibility settings. */
  onOpenSettings?: () => void
  renderMessageBody?: (m: ChatMessage, ctx: { mine: boolean }) => React.ReactNode
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
  const [draft, setDraft] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [msgSearch, setMsgSearch] = useState('')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const mentionMapRef = useRef(new Map<string, ChatOnlineUser>())
  const inputRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])
  useEffect(() => {
    markRead.mutate(room)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, messages.length])

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    return cfg.onlineUsers
      .filter((u) => (u.display_name ?? '').toLowerCase().startsWith(q))
      .slice(0, 6)
  }, [mentionQuery, cfg.onlineUsers])

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
    if (!text) return
    setDraft('')
    setMentionQuery(null)
    typing.clearTyping()
    // Mentions ride the send call: the server notifies only people who can
    // actually see the room and aren't muted, which the old client-side
    // /notifications blast could not check.
    const mentioned = me
      ? [...mentionMapRef.current.entries()]
          .filter(([name]) => text.includes(`@[${name}]`))
          .map(([, u]) => u.user_id)
      : []
    send.mutate({ text, mentions: mentioned })
    mentionMapRef.current.clear()
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
      <div className='min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3' data-chat-messages>
        {loading ? (
          <p className='py-6 text-center text-[12px] text-slate-400'>Loading…</p>
        ) : visibleMessages.length === 0 ? (
          <p className='py-6 text-center text-[12px] text-slate-400'>
            {searching ? 'No messages match.' : 'No messages yet — say hello.'}
          </p>
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
                <div className={cn('flex gap-2', mine && 'flex-row-reverse')}>
                  {!mine && <Avatar id={m.sender} name={m.sender_name} size={26} />}
                  <div className={cn('max-w-[78%]', mine && 'text-right')}>
                    {!mine && (
                      <p className='mb-0.5 text-[10.5px] font-medium text-slate-400'>
                        {m.sender_name ?? 'Unknown'}
                      </p>
                    )}
                    <div
                      className={cn(
                        'inline-block rounded-2xl px-3 py-1.5 text-left text-[12.5px] leading-snug',
                        mine ? cn('rounded-br-md', th.bubbleMine) : cn('rounded-bl-md', th.bubbleOther)
                      )}
                    >
                      {renderMessageBody ? (
                        renderMessageBody(m, { mine })
                      ) : (
                        <MessageBody text={m.message} mine={mine} />
                      )}
                    </div>
                    <p className='mt-0.5 flex items-center justify-end gap-1 text-[10px] text-slate-400'>
                      {!mine && <span className='mr-auto' />}
                      {new Date(m.date_created).toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
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
        {typing.typingText && (
          <p className='text-[11px] italic text-slate-400'>{typing.typingText}</p>
        )}
      </div>
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
                <span className='truncate'>{u.display_name ?? 'Unknown'}</span>
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
          placeholder={`Message ${label}… (@ to mention)`}
          className={cn('h-9 min-w-0 flex-1 rounded-lg border px-3 text-[12.5px] outline-none', th.input)}
          aria-label={`Message ${label}`}
        />
        <button
          type='submit'
          disabled={!draft.trim() || send.isPending}
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
  onOpen
}: {
  rooms: RoomInfo[]
  onOpen: (room: RoomInfo) => void
}) {
  const th = useTheme()
  const { setMuted, leave } = useRoomMembership()
  return (
    <div className='min-h-0 flex-1 overflow-y-auto p-2' data-chat-room-list>
      {(
        [
          ['Channels', rooms.filter((r) => r.kind === 'global' || r.kind === 'channel')],
          ['Direct messages', rooms.filter((r) => r.kind === 'dm')],
          ['Records', rooms.filter((r) => r.kind === 'entity')]
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
  scopes?: string[]
  /** dimension -> labels, e.g. {division: ['Zone 1'], region: ['BLT']} */
  scopes_by_dimension?: Record<string, string[]>
  recording_id?: string | null
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
  } | null>(null)
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
                  {section.users.map((u) => (
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
                        u.is_idle ? 'border-amber-400 bg-white dark:bg-card' : 'bg-emerald-400'
                      )}
                      title={u.is_idle ? 'Idle' : 'Online'}
                    />
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                      {u.display_name ?? 'Unknown user'}
                    </span>
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
                            if (f === 'page') return prettyPath(x?.current_path ?? u.current_path)
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
                  ))}
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
            onOpenSettings={activeRoom.channel ? () => setSettingsOpen(true) : undefined}
            onBack={() => setActiveRoom(null)}
            renderMessageBody={renderMessageBody}
          />
        ) : (
          <ChatRoomList
            rooms={rooms}
            onOpen={(r) => {
              setSettingsOpen(false)
              setActiveRoom({ room: r.room, label: r.label, channel: r.channel })
            }}
          />
        )}
      </aside>
    </div>
  )
}

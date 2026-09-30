import {
  AlarmClock,
  AtSign,
  Check,
  ChevronLeft,
  Filter,
  Paperclip,
  Pencil,
  Settings2,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { cn, formatRelative } from '../../lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  type ChatAnchor,
  type ChatSearchFilters,
  type RoomInfo,
  useMarkRoomRead,
  useMyPreferences,
  useSetMyPreferences,
  useUserSearch
} from './chat-core'
import { useMentions, useRoomSummary, useScheduledMessages } from './chat-hooks'

/**
 * Chat views beside the room list: every mention of you (#943), your
 * scheduled messages (#939), catch-up mode (#979), search filters (#938) and
 * the chat display/notification settings (#965, #966, #981).
 */

interface Th {
  divider: string
  surface: string
  accentText: string
  accentSoft: string
  input: string
  action: string
  pill: string
}

type OpenRoom = (room: string, label: string, anchor?: ChatAnchor) => void

function ViewHeader({
  title,
  onBack,
  th,
  right
}: {
  title: string
  onBack: () => void
  th: Th
  right?: React.ReactNode
}) {
  return (
    <div className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-2', th.divider)}>
      <button
        type='button'
        onClick={onBack}
        className='rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
        aria-label='Back to conversations'
      >
        <ChevronLeft className='h-4 w-4' strokeWidth={2} />
      </button>
      <p className='min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
        {title}
      </p>
      {right}
    </div>
  )
}

function clean(text: string): string {
  return text
    .replace(/@\[([^\]]+)\]/g, '@$1')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Mentions (#943) ──────────────────────────────────────────────────────────

export function MentionsView({
  th,
  onBack,
  onOpen
}: {
  th: Th
  onBack: () => void
  onOpen: OpenRoom
}) {
  const { mentions, loading } = useMentions(true)
  return (
    <div className='flex min-h-0 flex-1 flex-col' data-chat-mentions-view>
      <ViewHeader title='Mentions' onBack={onBack} th={th} />
      <div className='min-h-0 flex-1 overflow-y-auto p-2'>
        {loading ? (
          <p className='px-3 py-6 text-center text-[12px] text-slate-500'>Loading…</p>
        ) : mentions.length === 0 ? (
          <p className='px-3 py-8 text-center text-[12px] leading-relaxed text-slate-500'>
            No one has mentioned you yet. When someone writes @your name, @here or @channel in a
            room you are in, it lands here.
          </p>
        ) : (
          mentions.map((m) => (
            <button
              key={m.id}
              type='button'
              onClick={() =>
                onOpen(m.room, m.room_label ?? m.room, { around: m.parent_id ?? m.id })
              }
              className='flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/50'
              data-chat-mention={m.unread ? 'unread' : 'read'}
            >
              <span className='flex items-center gap-1.5 text-[10.5px] text-slate-500 dark:text-slate-400'>
                {m.unread && (
                  <span
                    className='h-1.5 w-1.5 shrink-0 rounded-full bg-red-500'
                    aria-label='Unread'
                  />
                )}
                <span className='truncate font-medium'>{m.room_label ?? m.room}</span>
                <span className='ml-auto shrink-0'>{formatRelative(m.date_created)}</span>
              </span>
              <span
                className={cn(
                  'line-clamp-2 text-[12px] text-slate-700 dark:text-slate-200',
                  m.unread && 'font-medium'
                )}
              >
                <span className='font-semibold'>{m.sender_name ?? 'Someone'}: </span>
                {clean(m.message)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// ── Scheduled (#939) ─────────────────────────────────────────────────────────

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ScheduledView({
  th,
  onBack,
  roomLabel
}: {
  th: Th
  onBack: () => void
  roomLabel: (room: string) => string
}) {
  const { scheduled, loading, update, cancel } = useScheduledMessages()
  const [editing, setEditing] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [when, setWhen] = useState('')
  return (
    <div className='flex min-h-0 flex-1 flex-col' data-chat-scheduled-view>
      <ViewHeader title='Scheduled messages' onBack={onBack} th={th} />
      <div className='min-h-0 flex-1 overflow-y-auto p-2'>
        {loading ? (
          <p className='px-3 py-6 text-center text-[12px] text-slate-500'>Loading…</p>
        ) : scheduled.length === 0 ? (
          <p className='px-3 py-8 text-center text-[12px] leading-relaxed text-slate-500'>
            Nothing scheduled. Write a message and use the alarm-clock button beside Send to send it
            later.
          </p>
        ) : (
          scheduled.map((s) => (
            <div
              key={s.id}
              className={cn('mb-1.5 rounded-lg border px-2.5 py-2', th.divider)}
              data-chat-scheduled={s.id}
            >
              <p className='flex items-center gap-1.5 text-[10.5px] text-slate-500 dark:text-slate-400'>
                <AlarmClock className='h-3 w-3' />
                <span className='truncate font-medium'>{roomLabel(s.room)}</span>
                <span className='ml-auto shrink-0'>
                  {new Date(s.send_at).toLocaleString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })}
                </span>
              </p>
              {s.status === 'failed' && (
                <p className='mt-0.5 text-[11px] text-red-600 dark:text-red-400'>
                  Not sent{s.error ? ` — ${s.error}` : ''}. Change the time to try again.
                </p>
              )}
              {editing === s.id ? (
                <div className='mt-1.5 space-y-1.5'>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={3}
                    className={cn(
                      'w-full resize-none rounded-md border px-2 py-1 text-[12px] outline-none',
                      th.input
                    )}
                    aria-label='Message'
                  />
                  <div className='flex items-center gap-1.5'>
                    <input
                      type='datetime-local'
                      value={when}
                      onChange={(e) => setWhen(e.target.value)}
                      className={cn(
                        'h-7 min-w-0 flex-1 rounded-md border px-1.5 text-[11.5px] outline-none',
                        th.input
                      )}
                      aria-label='Send at'
                    />
                    <button
                      type='button'
                      onClick={() =>
                        update.mutate(
                          { id: s.id, message: text, send_at: new Date(when).toISOString() },
                          {
                            onSuccess: () => setEditing(null),
                            onError: (e) =>
                              toast.error(
                                (e as { response?: { error?: string } })?.response?.error ??
                                  'Could not save it'
                              )
                          }
                        )
                      }
                      className={cn('h-7 rounded-md px-2 text-[11.5px] font-medium', th.action)}
                    >
                      Save
                    </button>
                    <button
                      type='button'
                      onClick={() => setEditing(null)}
                      className='h-7 rounded-md px-2 text-[11.5px] text-slate-600 hover:bg-muted dark:text-slate-300'
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className='mt-1 whitespace-pre-wrap text-[12px] text-slate-700 dark:text-slate-200'>
                    {s.message}
                    {s.attachments.length > 0 && (
                      <span className='ml-1 inline-flex items-center gap-0.5 text-[11px] text-slate-500'>
                        <Paperclip className='h-3 w-3' /> {s.attachments.length}
                      </span>
                    )}
                  </p>
                  <div className='mt-1 flex gap-2 text-[11px]'>
                    <button
                      type='button'
                      onClick={() => {
                        setEditing(s.id)
                        setText(s.message)
                        setWhen(toLocalInput(s.send_at))
                      }}
                      className={cn('inline-flex items-center gap-0.5 font-medium', th.accentText)}
                    >
                      <Pencil className='h-3 w-3' /> Edit
                    </button>
                    <button
                      type='button'
                      onClick={() => cancel.mutate(s.id)}
                      className='inline-flex items-center gap-0.5 text-slate-500 hover:text-red-600'
                    >
                      <Trash2 className='h-3 w-3' /> Don’t send
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Catch-up mode (#979) ─────────────────────────────────────────────────────

export function CatchUpView({
  rooms,
  th,
  onBack,
  onOpen
}: {
  rooms: RoomInfo[]
  th: Th
  onBack: () => void
  onOpen: OpenRoom
}) {
  // The walk is fixed when it starts — marking a room read must not reshuffle it.
  const [queue] = useState(() => rooms.filter((r) => r.unread > 0 && !r.muted))
  const [i, setI] = useState(0)
  const summary = useRoomSummary()
  const markRead = useMarkRoomRead()
  const [text, setText] = useState<Record<string, string>>({})
  const room = queue[i]
  // biome-ignore lint/correctness/useExhaustiveDependencies: one summary per room
  useEffect(() => {
    if (!room || text[room.room] !== undefined) return
    if (room.unread < 5) {
      setText((t) => ({ ...t, [room.room]: '' }))
      return
    }
    summary.mutate(
      { room: room.room },
      {
        onSuccess: (d) => setText((t) => ({ ...t, [room.room]: d.summary ?? '' })),
        onError: () => setText((t) => ({ ...t, [room.room]: '' }))
      }
    )
  }, [room?.room])
  const next = () => {
    if (room) markRead.mutate(room.room)
    setI((n) => n + 1)
  }
  return (
    <div className='flex min-h-0 flex-1 flex-col' data-chat-catchup>
      <ViewHeader
        title='Catch up'
        onBack={onBack}
        th={th}
        right={
          queue.length > 0 && room ? (
            <span className='text-[11px] tabular-nums text-slate-500'>
              {i + 1} of {queue.length}
            </span>
          ) : null
        }
      />
      <div className='min-h-0 flex-1 overflow-y-auto p-3'>
        {!room ? (
          <div className='py-10 text-center'>
            <Check className='mx-auto h-6 w-6 text-emerald-600' />
            <p className='mt-2 text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
              {queue.length ? 'You are caught up.' : 'Nothing unread.'}
            </p>
            <button
              type='button'
              onClick={onBack}
              className={cn('mt-3 text-[12px] font-medium', th.accentText)}
            >
              Back to conversations
            </button>
          </div>
        ) : (
          <div
            className={cn('rounded-xl border p-3', th.divider)}
            data-chat-catchup-room={room.room}
          >
            <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
              {room.label}
            </p>
            <p className='text-[11px] text-slate-500 dark:text-slate-400'>
              {room.unread} unread{room.mentions ? ` · ${room.mentions} for you` : ''}
            </p>
            <div className='mt-2 min-h-[48px] text-[12px] leading-relaxed text-slate-700 dark:text-slate-200'>
              {text[room.room] === undefined ? (
                <span className='inline-flex items-center gap-1 text-slate-500'>
                  <Sparkles className='h-3.5 w-3.5' /> Summarizing…
                </span>
              ) : text[room.room] ? (
                text[room.room]
              ) : room.lastMessage ? (
                <>
                  <span className='font-semibold'>
                    {room.lastMessage.sender_name ?? 'Someone'}:{' '}
                  </span>
                  {clean(room.lastMessage.message)}
                </>
              ) : null}
            </div>
            <div className='mt-3 flex gap-2'>
              <button
                type='button'
                onClick={() => onOpen(room.room, room.label)}
                className='h-8 flex-1 rounded-md border border-slate-200 text-[12px] font-medium text-slate-700 hover:bg-muted dark:border-border dark:text-slate-200'
              >
                Open the room
              </button>
              <button
                type='button'
                onClick={next}
                className={cn('h-8 flex-1 rounded-md text-[12px] font-semibold', th.action)}
                data-chat-catchup-next
              >
                {i + 1 < queue.length ? 'Mark read · next' : 'Mark read · done'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Search filters (#938) ────────────────────────────────────────────────────

export function SearchFilterBar({
  filters,
  onChange,
  rooms,
  th
}: {
  filters: ChatSearchFilters
  onChange: (f: ChatSearchFilters) => void
  rooms: RoomInfo[]
  th: Th
}) {
  const [personQ, setPersonQ] = useState('')
  const [personName, setPersonName] = useState<string | null>(null)
  const { users } = useUserSearch(personQ, personQ.trim().length >= 2)
  const roomName = rooms.find((r) => r.room === filters.room)?.label
  const chip = (active: boolean) =>
    cn(
      'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px]',
      active
        ? cn(th.accentSoft, 'border-transparent font-medium')
        : 'border-slate-200 text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
    )
  return (
    <div className='mb-1.5 flex flex-wrap items-center gap-1 px-1' data-chat-search-filters>
      <Popover>
        <PopoverTrigger asChild>
          <button type='button' className={chip(!!filters.sender)} data-chat-filter='sender'>
            {filters.sender ? `From ${personName ?? 'person'}` : 'From…'}
            {filters.sender && (
              <X
                className='h-3 w-3'
                onClick={(e) => {
                  e.stopPropagation()
                  onChange({ ...filters, sender: null })
                }}
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[240px] p-0'>
          <Command shouldFilter={false}>
            <CommandInput placeholder='Search people…' value={personQ} onValueChange={setPersonQ} />
            <CommandList>
              <CommandEmpty>
                {personQ.trim().length < 2 ? 'Type a name' : 'No one found'}
              </CommandEmpty>
              <CommandGroup>
                {users.map((u) => {
                  const name =
                    [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.id
                  return (
                    <CommandItem
                      key={u.id}
                      value={u.id}
                      onSelect={() => {
                        setPersonName(name)
                        onChange({ ...filters, sender: u.id })
                      }}
                    >
                      {name}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <button type='button' className={chip(!!filters.room)} data-chat-filter='room'>
            {filters.room ? `In ${roomName ?? 'room'}` : 'In…'}
            {filters.room && (
              <X
                className='h-3 w-3'
                onClick={(e) => {
                  e.stopPropagation()
                  onChange({ ...filters, room: null })
                }}
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[240px] p-0'>
          <Command>
            <CommandInput placeholder='Search rooms…' />
            <CommandList>
              <CommandEmpty>No room found</CommandEmpty>
              <CommandGroup>
                {rooms.map((r) => (
                  <CommandItem
                    key={r.room}
                    value={`${r.label} ${r.room}`}
                    onSelect={() => onChange({ ...filters, room: r.room })}
                  >
                    {r.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type='button'
            className={chip(!!(filters.from || filters.to))}
            data-chat-filter='date'
          >
            {filters.from || filters.to
              ? `${filters.from ? new Date(filters.from).toLocaleDateString() : '…'} – ${filters.to ? new Date(filters.to).toLocaleDateString() : '…'}`
              : 'Date…'}
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[220px] space-y-1.5 p-2.5'>
          {(['from', 'to'] as const).map((k) => (
            <label
              key={k}
              className='flex items-center gap-2 text-[11.5px] text-slate-600 dark:text-slate-300'
            >
              <span className='w-8'>{k === 'from' ? 'From' : 'To'}</span>
              <input
                type='date'
                value={filters[k] ? String(filters[k]).slice(0, 10) : ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) return onChange({ ...filters, [k]: null })
                  const [y, m, d] = v.split('-').map(Number)
                  const dt =
                    k === 'from'
                      ? new Date(y, m - 1, d, 0, 0, 0)
                      : new Date(y, m - 1, d, 23, 59, 59)
                  onChange({ ...filters, [k]: dt.toISOString() })
                }}
                className={cn(
                  'h-7 min-w-0 flex-1 rounded-md border px-1.5 text-[11.5px] outline-none',
                  th.input
                )}
              />
            </label>
          ))}
          {(filters.from || filters.to) && (
            <button
              type='button'
              onClick={() => onChange({ ...filters, from: null, to: null })}
              className='text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-100'
            >
              Clear dates
            </button>
          )}
        </PopoverContent>
      </Popover>
      <button
        type='button'
        className={chip(!!filters.has_attachment)}
        aria-pressed={!!filters.has_attachment}
        onClick={() => onChange({ ...filters, has_attachment: !filters.has_attachment })}
        data-chat-filter='files'
      >
        <Paperclip className='h-3 w-3' /> Has files
      </button>
      <button
        type='button'
        className={chip(!!filters.mentions_me)}
        aria-pressed={!!filters.mentions_me}
        onClick={() => onChange({ ...filters, mentions_me: !filters.mentions_me })}
        data-chat-filter='mentions'
      >
        <AtSign className='h-3 w-3' /> Mentions me
      </button>
    </div>
  )
}

export function hasFilters(f: ChatSearchFilters): boolean {
  return !!(f.sender || f.room || f.from || f.to || f.has_attachment || f.mentions_me)
}

export function FilterToggle({
  open,
  active,
  onClick
}: {
  open: boolean
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={open}
      title='Search filters'
      aria-label='Search filters'
      className={cn(
        'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-slate-500 hover:bg-slate-50 dark:border-border dark:text-slate-400 dark:hover:bg-muted',
        open ? 'border-slate-400 dark:border-slate-400' : 'border-slate-200'
      )}
      data-chat-filter-toggle
    >
      <Filter className='h-3.5 w-3.5' strokeWidth={2} />
      {active && <span className='absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-nvr-cyan' />}
    </button>
  )
}

// ── Chat settings (#965, #966, #981) ─────────────────────────────────────────

export function ChatSettingsButton() {
  const prefs = useMyPreferences()
  const set = useSetMyPreferences()
  const density = prefs.chat_density === 'compact' ? 'compact' : 'comfortable'
  const badge = prefs.chat_badge_mode === 'conversations' ? 'conversations' : 'all'
  const emailFallback = prefs.chat_email_fallback === true
  const seg = (active: boolean) =>
    cn(
      'flex-1 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors',
      active
        ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-slate-100'
        : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
    )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          title='Chat settings'
          aria-label='Chat settings'
          className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:text-slate-400 dark:hover:bg-muted'
          data-chat-settings
        >
          <Settings2 className='h-3.5 w-3.5' strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[280px] space-y-3 p-3'>
        <div>
          <p className='mb-1 text-[11.5px] font-semibold text-slate-800 dark:text-slate-100'>
            Spacing
          </p>
          <div className='flex gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-muted'>
            {(['comfortable', 'compact'] as const).map((v) => (
              <button
                key={v}
                type='button'
                onClick={() => set.mutate({ chat_density: v === 'comfortable' ? null : v })}
                className={seg(density === v)}
                data-chat-density={v}
              >
                {v === 'comfortable' ? 'Comfortable' : 'Compact'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className='mb-1 text-[11.5px] font-semibold text-slate-800 dark:text-slate-100'>
            The chat badge counts
          </p>
          <div className='flex gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-muted'>
            <button
              type='button'
              onClick={() => set.mutate({ chat_badge_mode: null })}
              className={seg(badge === 'all')}
              data-chat-badge-mode='all'
            >
              Everything
            </button>
            <button
              type='button'
              onClick={() => set.mutate({ chat_badge_mode: 'conversations' })}
              className={seg(badge === 'conversations')}
              data-chat-badge-mode='conversations'
            >
              DMs & mentions
            </button>
          </div>
          <p className='mt-1 text-[10.5px] leading-snug text-slate-500 dark:text-slate-400'>
            Channels keep their own unread counts either way.
          </p>
        </div>
        <label className='flex items-start gap-2 text-[11.5px] text-slate-700 dark:text-slate-200'>
          <input
            type='checkbox'
            checked={emailFallback}
            onChange={(e) => set.mutate({ chat_email_fallback: e.target.checked || null })}
            className='mt-0.5'
            data-chat-email-fallback
          />
          <span>
            Email me about direct messages I have not read for 30 minutes
            <span className='block text-[10.5px] text-slate-500 dark:text-slate-400'>
              One email per conversation until you read it. Quiet hours apply.
            </span>
          </span>
        </label>
      </PopoverContent>
    </Popover>
  )
}

export function useSearchFilterState() {
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<ChatSearchFilters>({})
  const active = useMemo(() => hasFilters(filters), [filters])
  return { open, setOpen, filters, setFilters, active }
}

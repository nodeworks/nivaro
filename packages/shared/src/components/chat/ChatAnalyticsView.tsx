import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Eye,
  Paperclip,
  RotateCw,
  Search,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useApiFetchConfig, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { TipLayer } from '../TipLayer'
import { useUserSearch } from './chat-core'

/**
 * Chat analytics (#955) for administrators, in two parts.
 *
 * Overview — how much chat is used and how quickly people answer each other:
 * counts and timings only (GET /chat/admin/analytics).
 *
 * Messages — the compliance view: every message from anyone to anyone, in any
 * room, with its full details (GET /chat/admin/messages, /messages/:id). The
 * server records every search and every opened message in the activity log
 * under the administrator's name, and this view says so where it is used.
 */

type Kind = 'dm' | 'group' | 'channel' | 'general' | 'record'

const KIND_LABEL: Record<Kind, string> = {
  dm: 'Direct message',
  group: 'Group conversation',
  channel: 'Channel',
  general: 'General',
  record: 'Record room'
}

const KIND_SHORT: Record<Kind, string> = {
  dm: 'DM',
  group: 'Group',
  channel: 'Channel',
  general: 'General',
  record: 'Record'
}

interface Analytics {
  window: { days: number; from: string; to: string; time_zone: string; truncated: boolean }
  totals: {
    messages: number
    senders: number
    active_rooms: number
    attachments: number
    reactions: number
  }
  by_kind: Array<{ kind: Kind; messages: number; rooms: number }>
  per_day: Array<{ day: string; messages: number; senders: number }>
  by_hour: number[]
  busiest_channels: Array<{ room: string; label: string; messages: number; senders: number }>
  busiest_records: Array<{ room: string; label: string; messages: number; senders: number }>
  dm_response: {
    samples: number
    median_minutes: number | null
    p90_minutes: number | null
    within_hour_pct: number | null
  }
}

interface MessageRow {
  id: number
  room: string
  kind: Kind
  room_label: string
  participants: Array<{ id: string; name: string | null }>
  participant_count: number
  sender: string | null
  sender_name: string | null
  message: string
  date_created: string
  edited_at: string | null
  deleted_at: string | null
  attachment_count: number
  reaction_count: number
  masquerade: boolean
}

interface MessageDetail {
  message: {
    id: number
    room: string
    sender: string | null
    sender_name: string | null
    message: string
    date_created: string
    edited_at: string | null
    deleted_at: string | null
    masquerade_admin: string | null
    masquerade_admin_name: string | null
  }
  room: {
    room: string
    kind: Kind
    label: string
    participants: Array<{ id: string; name: string | null }>
  }
  mentions: string[]
  attachments: Array<{ id: string; name: string; type: string | null; size: number | null }>
  reactions: Array<{ emoji: string; user: string; name: string | null }>
  reads: Array<{ user: string; name: string | null; read: boolean; last_read_at: string | null }>
  saved_by: number
  pinned: boolean
  history: Array<{ action: string; at: string; by: string | null; comment: string | null }>
  admin_views?: { count: number; previous: { by: string | null; at: string } | null }
  context: {
    before: Array<ContextMessage>
    after: Array<ContextMessage>
  }
}

interface ContextMessage {
  id: number
  sender: string | null
  sender_name: string | null
  message: string
  date_created: string
  edited_at: string | null
  deleted_at: string | null
}

function minutesText(m: number | null): string {
  if (m == null) return '—'
  if (m < 1) return 'under a minute'
  if (m < 60) return `${Math.round(m)} min`
  const h = m / 60
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)} h`
  return `${(h / 24).toFixed(1)} days`
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <p className='text-[11px] font-medium uppercase tracking-[0.06em] text-slate-500 dark:text-slate-400'>
        {label}
      </p>
      <p className='mt-1 text-[22px] font-semibold tabular-nums text-slate-900 dark:text-slate-50'>
        {value}
      </p>
      {sub && <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>{sub}</p>}
    </div>
  )
}

/** Single-series column chart; each column carries its own hover tip. */
function Columns({
  values,
  labels,
  tips,
  height = 120,
  axis
}: {
  values: number[]
  labels: string[]
  tips: string[]
  height?: number
  axis: Array<{ index: number; text: string }>
}) {
  const max = Math.max(1, ...values)
  return (
    <div>
      <div
        className='flex items-end gap-[2px]'
        style={{ height }}
        role='img'
        aria-label={tips.join('; ')}
      >
        {values.map((v, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
            key={i}
            className='group flex h-full min-w-0 flex-1 items-end'
            data-tip={tips[i]}
          >
            <div
              className={cn(
                'w-full rounded-t-[4px] transition-colors',
                v > 0
                  ? 'bg-nvr-cyan group-hover:bg-nvr-navy dark:group-hover:bg-white'
                  : 'bg-transparent'
              )}
              style={{ height: v > 0 ? Math.max(3, (v / max) * height) : 0 }}
            />
          </div>
        ))}
      </div>
      <div className='relative mt-1 h-4 border-t border-slate-200 dark:border-border'>
        {axis.map((a) => (
          <span
            key={a.index}
            className='absolute top-0.5 -translate-x-1/2 whitespace-nowrap text-[10.5px] tabular-nums text-slate-500 dark:text-slate-400'
            style={{ left: `${((a.index + 0.5) / values.length) * 100}%` }}
          >
            {a.text}
          </span>
        ))}
      </div>
      <span className='sr-only'>{labels.join(', ')}</span>
    </div>
  )
}

function Section({
  title,
  children,
  note
}: {
  title: string
  children: React.ReactNode
  note?: string
}) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='mb-3 flex items-baseline justify-between gap-3'>
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h3>
        {note && <p className='text-[11px] text-slate-500 dark:text-slate-400'>{note}</p>}
      </div>
      {children}
    </section>
  )
}

function RoomTable({
  rows,
  empty,
  onOpen
}: {
  rows: Array<{ room: string; label: string; messages: number; senders: number }>
  empty: string
  onOpen: (room: string, label: string) => void
}) {
  if (rows.length === 0)
    return <p className='text-[12px] text-slate-500 dark:text-slate-400'>{empty}</p>
  const max = Math.max(1, ...rows.map((r) => r.messages))
  return (
    <table className='w-full text-[12.5px]'>
      <thead>
        <tr className='text-left text-[10.5px] uppercase tracking-[0.06em] text-slate-500 dark:text-slate-400'>
          <th className='pb-1.5 font-medium'>Room</th>
          <th className='pb-1.5 text-right font-medium'>Messages</th>
          <th className='pb-1.5 text-right font-medium'>People</th>
        </tr>
      </thead>
      <tbody className='tabular-nums'>
        {rows.map((r) => (
          <tr key={r.room} className='border-t border-slate-100 dark:border-border/60'>
            <td className='py-1.5 pr-3'>
              <button
                type='button'
                onClick={() => onOpen(r.room, r.label)}
                className='block max-w-full truncate text-left font-medium text-slate-800 hover:underline dark:text-slate-100'
                title='Read the messages in this room'
              >
                {r.label}
              </button>
              <span className='mt-1 block h-1 rounded-full bg-slate-100 dark:bg-muted'>
                <span
                  className='block h-1 rounded-full bg-nvr-cyan'
                  style={{ width: `${(r.messages / max) * 100}%` }}
                />
              </span>
            </td>
            <td className='py-1.5 text-right text-slate-700 dark:text-slate-200'>{r.messages}</td>
            <td className='py-1.5 text-right text-slate-700 dark:text-slate-200'>{r.senders}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Overview({ onOpenRoom }: { onOpenRoom: (room: string, label: string) => void }) {
  const client = useNivaroClient()
  const [days, setDays] = useState(30)
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['nvr-chat-analytics', days],
    queryFn: () =>
      client
        .request<{ data: Analytics }>(get('/chat/admin/analytics', { days }))
        .then((r) => r.data),
    staleTime: 60_000
  })

  const perDay = data?.per_day ?? []
  const dayTips = perDay.map(
    (d) =>
      `${new Date(`${d.day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${d.messages} message${d.messages === 1 ? '' : 's'} from ${d.senders} ${d.senders === 1 ? 'person' : 'people'}`
  )
  const dayAxis = useMemo(() => {
    const n = perDay.length
    if (!n) return []
    const step = Math.max(1, Math.ceil(n / 6))
    const out: Array<{ index: number; text: string }> = []
    for (let i = 0; i < n; i += step)
      out.push({
        index: i,
        text: new Date(`${perDay[i].day}T12:00:00`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric'
        })
      })
    return out
  }, [perDay])
  const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='inline-flex rounded-md border border-slate-200 bg-white p-0.5 dark:border-border dark:bg-card'>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type='button'
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              className={cn(
                'rounded px-2.5 py-1 text-[12px] font-medium',
                days === d
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted'
              )}
              data-chat-analytics-days={d}
            >
              {d} days
            </button>
          ))}
        </div>
        <button
          type='button'
          onClick={() => void refetch()}
          className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted'
        >
          <RotateCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
        {data && (
          <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
            Times in {data.window.time_zone.replace(/_/g, ' ')}. Counts only — no message text on
            this tab.
          </p>
        )}
      </div>

      {isError && (
        <p className='rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'>
          Couldn't load chat analytics.{' '}
          <button type='button' onClick={() => void refetch()} className='underline'>
            Try again
          </button>
        </p>
      )}
      {isLoading && (
        <div className='grid grid-cols-2 gap-3 md:grid-cols-4'>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className='h-[86px] animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]'
            />
          ))}
        </div>
      )}

      {data && (
        <>
          {data.window.truncated && (
            <p className='text-[12px] text-amber-700 dark:text-amber-400'>
              Only the newest 50,000 messages in this window were counted.
            </p>
          )}
          <div
            className='grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6'
            data-chat-analytics-totals
          >
            <Stat label='Messages' value={data.totals.messages.toLocaleString()} />
            <Stat label='People who wrote' value={data.totals.senders.toLocaleString()} />
            <Stat label='Active rooms' value={data.totals.active_rooms.toLocaleString()} />
            <Stat
              label='DM reply time'
              value={minutesText(data.dm_response.median_minutes)}
              sub={
                data.dm_response.samples
                  ? `median of ${data.dm_response.samples} replies · 90% within ${minutesText(data.dm_response.p90_minutes)}`
                  : 'no replies in this window'
              }
            />
            <Stat
              label='DMs answered within an hour'
              value={
                data.dm_response.within_hour_pct == null
                  ? '—'
                  : `${data.dm_response.within_hour_pct}%`
              }
            />
            <Stat
              label='Files · reactions'
              value={`${data.totals.attachments} · ${data.totals.reactions}`}
            />
          </div>

          <Section title='Messages per day' note={`Last ${data.window.days} days`}>
            <Columns
              values={perDay.map((d) => d.messages)}
              labels={perDay.map((d) => `${d.day} ${d.messages}`)}
              tips={dayTips}
              axis={dayAxis}
            />
          </Section>

          <div className='grid gap-4 lg:grid-cols-2'>
            <Section title='When people write' note='Messages by hour of day'>
              <Columns
                values={data.by_hour}
                labels={data.by_hour.map((v, h) => `${hourLabel(h)} ${v}`)}
                tips={data.by_hour.map(
                  (v, h) =>
                    `${hourLabel(h)}m–${hourLabel((h + 1) % 24)}m: ${v} message${v === 1 ? '' : 's'}`
                )}
                height={96}
                axis={[0, 6, 12, 18].map((h) => ({ index: h, text: hourLabel(h) }))}
              />
            </Section>
            <Section title='Where people write'>
              {data.by_kind.length === 0 ? (
                <p className='text-[12px] text-slate-500 dark:text-slate-400'>
                  No messages in this window.
                </p>
              ) : (
                <table className='w-full text-[12.5px] tabular-nums'>
                  <thead>
                    <tr className='text-left text-[10.5px] uppercase tracking-[0.06em] text-slate-500 dark:text-slate-400'>
                      <th className='pb-1.5 font-medium'>Kind</th>
                      <th className='pb-1.5 text-right font-medium'>Rooms</th>
                      <th className='pb-1.5 text-right font-medium'>Messages</th>
                      <th className='pb-1.5 pl-3 font-medium'>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_kind.map((k) => {
                      const pct = data.totals.messages
                        ? (k.messages / data.totals.messages) * 100
                        : 0
                      return (
                        <tr
                          key={k.kind}
                          className='border-t border-slate-100 dark:border-border/60'
                        >
                          <td className='py-1.5 text-slate-800 dark:text-slate-100'>
                            {KIND_LABEL[k.kind]}
                          </td>
                          <td className='py-1.5 text-right text-slate-700 dark:text-slate-200'>
                            {k.rooms}
                          </td>
                          <td className='py-1.5 text-right text-slate-700 dark:text-slate-200'>
                            {k.messages}
                          </td>
                          <td className='py-1.5 pl-3'>
                            <span className='flex items-center gap-2'>
                              <span className='h-1.5 flex-1 rounded-full bg-slate-100 dark:bg-muted'>
                                <span
                                  className='block h-1.5 rounded-full bg-nvr-cyan'
                                  style={{ width: `${pct}%` }}
                                />
                              </span>
                              <span className='w-9 text-right text-[11px] text-slate-500 dark:text-slate-400'>
                                {Math.round(pct)}%
                              </span>
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </Section>
          </div>

          <div className='grid gap-4 lg:grid-cols-2'>
            <Section title='Busiest channels'>
              <RoomTable
                rows={data.busiest_channels}
                empty='No channel messages in this window.'
                onOpen={onOpenRoom}
              />
            </Section>
            <Section title='Busiest record conversations'>
              <RoomTable
                rows={data.busiest_records}
                empty='No record conversations in this window.'
                onOpen={onOpenRoom}
              />
            </Section>
          </div>
        </>
      )}
    </div>
  )
}

/** A person picker over the user directory, for the From / With filters. */
function PersonFilter({
  label,
  value,
  onChange
}: {
  label: string
  value: { id: string; name: string } | null
  onChange: (v: { id: string; name: string } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const { users } = useUserSearch(search, open)
  if (value) {
    return (
      <span className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 text-[12px] dark:border-border dark:bg-card'>
        <span className='text-slate-500 dark:text-slate-400'>{label}</span>
        <span className='font-medium text-slate-800 dark:text-slate-100'>{value.name}</span>
        <button
          type='button'
          onClick={() => onChange(null)}
          aria-label={`Clear ${label}`}
          className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-100'
        >
          <X className='h-3 w-3' />
        </button>
      </span>
    )
  }
  return (
    <div className='relative'>
      <input
        value={search}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`${label}: anyone`}
        className='h-8 w-44 rounded-md border border-slate-200 bg-white px-2 text-[12px] outline-none focus:border-slate-400 dark:border-border dark:bg-card'
        aria-label={`${label} person`}
      />
      {open && users.length > 0 && (
        <div className='absolute left-0 top-9 z-20 max-h-64 w-64 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-border dark:bg-card'>
          {users.map((u) => {
            const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.id
            return (
              <button
                key={u.id}
                type='button'
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange({ id: u.id, name })
                  setSearch('')
                  setOpen(false)
                }}
                className='block w-full truncate px-2.5 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-slate-200'
              >
                {name}
                {u.email && name !== u.email && (
                  <span className='ml-1.5 text-[11px] text-slate-400'>{u.email}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function whereText(r: { kind: Kind; room_label: string; participant_count?: number }): string {
  if (r.kind === 'group' && r.participant_count)
    return `${r.room_label} · ${r.participant_count} people`
  return r.room_label
}

function KindChip({ kind }: { kind: Kind }) {
  return (
    <span className='inline-flex shrink-0 rounded border border-slate-200 px-1.5 text-[10.5px] font-medium text-slate-600 dark:border-border dark:text-slate-300'>
      {KIND_SHORT[kind]}
    </span>
  )
}

function Messages({
  room,
  onRoomChange
}: {
  room: { room: string; label: string } | null
  onRoomChange: (v: { room: string; label: string } | null) => void
}) {
  const client = useNivaroClient()
  const [sender, setSender] = useState<{ id: string; name: string } | null>(null)
  const [participant, setParticipant] = useState<{ id: string; name: string } | null>(null)
  const [kinds, setKinds] = useState<Kind[]>([])
  const [text, setText] = useState('')
  const [appliedText, setAppliedText] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [attachments, setAttachments] = useState(false)
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<number | null>(null)
  const limit = 50

  const params = {
    ...(sender ? { sender: sender.id } : {}),
    ...(participant ? { participant: participant.id } : {}),
    ...(room ? { room: room.room } : {}),
    ...(kinds.length ? { kind: kinds.join(',') } : {}),
    ...(appliedText.trim().length >= 2 ? { q: appliedText.trim() } : {}),
    ...(since ? { since: new Date(`${since}T00:00:00`).toISOString() } : {}),
    ...(until ? { until: new Date(`${until}T23:59:59`).toISOString() } : {}),
    ...(attachments ? { attachments: '1' } : {}),
    ...(includeDeleted ? { include_deleted: '1' } : {}),
    page,
    limit
  }
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['nvr-chat-admin-messages', params],
    queryFn: () =>
      client.request<{ data: MessageRow[]; total: number }>(get('/chat/admin/messages', params)),
    placeholderData: (prev) => prev
  })
  const rows = data?.data ?? []
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / limit))
  const resetPage = () => setPage(1)

  return (
    <div className='space-y-3'>
      <p
        className='flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
        data-chat-admin-notice
      >
        <Eye className='mt-0.5 h-3.5 w-3.5 shrink-0' />
        <span>
          This tab shows private conversations, direct messages included. Every search you run and
          every message you open here is recorded in the activity log under your name.
        </span>
      </p>

      <div className='flex flex-wrap items-center gap-2' data-chat-admin-filters>
        <PersonFilter
          label='From'
          value={sender}
          onChange={(v) => {
            setSender(v)
            resetPage()
          }}
        />
        <PersonFilter
          label='With'
          value={participant}
          onChange={(v) => {
            setParticipant(v)
            resetPage()
          }}
        />
        {room && (
          <span className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 text-[12px] dark:border-border dark:bg-card'>
            <span className='text-slate-500 dark:text-slate-400'>Room</span>
            <span className='max-w-[220px] truncate font-medium text-slate-800 dark:text-slate-100'>
              {room.label}
            </span>
            <button
              type='button'
              onClick={() => {
                onRoomChange(null)
                resetPage()
              }}
              aria-label='Clear room'
              className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-100'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        )}
        <form
          className='relative'
          onSubmit={(e) => {
            e.preventDefault()
            setAppliedText(text)
            resetPage()
          }}
        >
          <Search className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              if (text !== appliedText) {
                setAppliedText(text)
                resetPage()
              }
            }}
            placeholder='Words in the message'
            className='h-8 w-52 rounded-md border border-slate-200 bg-white pl-7 pr-2 text-[12px] outline-none focus:border-slate-400 dark:border-border dark:bg-card'
            aria-label='Search message text'
          />
        </form>
        <label className='inline-flex h-8 items-center gap-1 text-[12px] text-slate-600 dark:text-slate-300'>
          From
          <input
            type='date'
            value={since}
            onChange={(e) => {
              setSince(e.target.value)
              resetPage()
            }}
            className='h-8 rounded-md border border-slate-200 bg-white px-1.5 text-[12px] dark:border-border dark:bg-card'
          />
        </label>
        <label className='inline-flex h-8 items-center gap-1 text-[12px] text-slate-600 dark:text-slate-300'>
          to
          <input
            type='date'
            value={until}
            onChange={(e) => {
              setUntil(e.target.value)
              resetPage()
            }}
            className='h-8 rounded-md border border-slate-200 bg-white px-1.5 text-[12px] dark:border-border dark:bg-card'
          />
        </label>
      </div>
      <div className='flex flex-wrap items-center gap-1.5'>
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => {
          const on = kinds.includes(k)
          return (
            <button
              key={k}
              type='button'
              aria-pressed={on}
              onClick={() => {
                setKinds((cur) => (on ? cur.filter((x) => x !== k) : [...cur, k]))
                resetPage()
              }}
              className={cn(
                'h-7 rounded-full border px-2.5 text-[12px]',
                on
                  ? 'border-slate-800 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-300'
              )}
              data-chat-admin-kind={k}
            >
              {KIND_LABEL[k]}
            </button>
          )
        })}
        <span className='mx-1 h-4 w-px bg-slate-200 dark:bg-border' aria-hidden />
        <label className='inline-flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
          <input
            type='checkbox'
            checked={attachments}
            onChange={(e) => {
              setAttachments(e.target.checked)
              resetPage()
            }}
          />
          Has files
        </label>
        <label className='inline-flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
          <input
            type='checkbox'
            checked={includeDeleted}
            onChange={(e) => {
              setIncludeDeleted(e.target.checked)
              resetPage()
            }}
          />
          Include deleted
        </label>
      </div>

      <div
        className={cn(
          'grid gap-4',
          selected != null && 'xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]'
        )}
      >
        <div className='min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2 text-[12px] text-slate-500 dark:border-border/60 dark:text-slate-400'>
            <span data-chat-admin-total={total}>
              {isLoading
                ? 'Loading…'
                : `${total.toLocaleString()} message${total === 1 ? '' : 's'}`}
              {isFetching && !isLoading && ' · updating…'}
            </span>
            {pages > 1 && (
              <span className='flex items-center gap-1'>
                <button
                  type='button'
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className='rounded p-1 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-muted'
                  aria-label='Previous page'
                >
                  <ChevronLeft className='h-3.5 w-3.5' />
                </button>
                <span className='tabular-nums'>
                  {page} / {pages}
                </span>
                <button
                  type='button'
                  disabled={page >= pages}
                  onClick={() => setPage((p) => p + 1)}
                  className='rounded p-1 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-muted'
                  aria-label='Next page'
                >
                  <ChevronRight className='h-3.5 w-3.5' />
                </button>
              </span>
            )}
          </div>
          {isError ? (
            <p className='px-3 py-6 text-center text-[12.5px] text-red-600 dark:text-red-400'>
              Couldn't load messages.
            </p>
          ) : !isLoading && rows.length === 0 ? (
            <p className='px-3 py-8 text-center text-[12.5px] text-slate-500 dark:text-slate-400'>
              No messages match these filters.
            </p>
          ) : (
            <table className='w-full table-fixed text-[12.5px]'>
              <thead>
                <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-[0.06em] text-slate-500 dark:border-border/60 dark:text-slate-400'>
                  <th className='w-[132px] px-3 py-1.5 font-medium'>When</th>
                  <th className='w-[150px] px-2 py-1.5 font-medium'>From</th>
                  <th className='w-[220px] px-2 py-1.5 font-medium'>Where</th>
                  <th className='px-2 py-1.5 font-medium'>Message</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setSelected(r.id)}
                    className={cn(
                      'cursor-pointer border-b border-slate-100 align-top last:border-0 hover:bg-slate-50 dark:border-border/60 dark:hover:bg-muted/50',
                      selected === r.id && 'bg-[#f2fdff] dark:bg-[#20303a]'
                    )}
                    data-chat-admin-row={r.id}
                  >
                    <td
                      className='px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300'
                      title={formatDateTime(r.date_created)}
                    >
                      {formatDateTime(r.date_created)}
                    </td>
                    <td className='truncate px-2 py-2 font-medium text-slate-800 dark:text-slate-100'>
                      {r.sender_name ?? 'Unknown'}
                    </td>
                    <td className='px-2 py-2'>
                      <span className='flex min-w-0 items-center gap-1.5'>
                        <KindChip kind={r.kind} />
                        <span
                          className='truncate text-slate-700 dark:text-slate-200'
                          title={whereText(r)}
                        >
                          {whereText(r)}
                        </span>
                      </span>
                    </td>
                    <td className='px-2 py-2'>
                      <span className='line-clamp-2 break-words text-slate-800 dark:text-slate-100'>
                        {r.deleted_at ? (
                          <em className='text-slate-500 dark:text-slate-400'>Deleted</em>
                        ) : (
                          r.message || (
                            <em className='text-slate-500 dark:text-slate-400'>(no text)</em>
                          )
                        )}
                      </span>
                      {(r.attachment_count > 0 ||
                        r.reaction_count > 0 ||
                        r.edited_at ||
                        r.masquerade) && (
                        <span className='mt-0.5 flex flex-wrap gap-2 text-[11px] text-slate-500 dark:text-slate-400'>
                          {r.attachment_count > 0 && (
                            <span className='inline-flex items-center gap-0.5'>
                              <Paperclip className='h-3 w-3' /> {r.attachment_count}
                            </span>
                          )}
                          {r.reaction_count > 0 && (
                            <span>
                              {r.reaction_count} reaction{r.reaction_count === 1 ? '' : 's'}
                            </span>
                          )}
                          {r.edited_at && <span>edited</span>}
                          {r.masquerade && <span>sent while masquerading</span>}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {selected != null && (
          <MessageDetailPanel
            id={selected}
            onClose={() => setSelected(null)}
            onRoom={(r) => {
              onRoomChange(r)
              setSelected(null)
              resetPage()
            }}
          />
        )}
      </div>
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='grid grid-cols-[104px_minmax(0,1fr)] gap-2 py-1 text-[12.5px]'>
      <dt className='text-slate-500 dark:text-slate-400'>{label}</dt>
      <dd className='min-w-0 text-slate-800 dark:text-slate-100'>{children}</dd>
    </div>
  )
}

function ContextLine({ m, target }: { m: ContextMessage; target?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-md px-2.5 py-1.5',
        target ? 'bg-[#f2fdff] ring-1 ring-nvr-cyan/50 dark:bg-[#20303a]' : ''
      )}
      data-chat-admin-context={m.id}
    >
      <p className='flex items-baseline gap-2 text-[11px] text-slate-500 dark:text-slate-400'>
        <span className='font-medium text-slate-700 dark:text-slate-200'>
          {m.sender_name ?? 'Unknown'}
        </span>
        <span className='tabular-nums'>{formatDateTime(m.date_created)}</span>
        {m.edited_at && <span>edited</span>}
      </p>
      <p className='whitespace-pre-wrap break-words text-[12.5px] text-slate-800 dark:text-slate-100'>
        {m.deleted_at ? (
          <em className='text-slate-500 dark:text-slate-400'>Deleted</em>
        ) : (
          m.message || '—'
        )}
      </p>
    </div>
  )
}

function MessageDetailPanel({
  id,
  onClose,
  onRoom
}: {
  id: number
  onClose: () => void
  onRoom: (r: { room: string; label: string }) => void
}) {
  const client = useNivaroClient()
  const { apiBase } = useApiFetchConfig()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['nvr-chat-admin-message', id],
    queryFn: () =>
      client.request<{ data: MessageDetail }>(get(`/chat/admin/messages/${id}`)).then((r) => r.data)
  })
  const unread =
    data?.reads.filter(
      (r) => !r.read && r.user.toUpperCase() !== String(data.message.sender ?? '').toUpperCase()
    ) ?? []
  const read =
    data?.reads.filter(
      (r) => r.read && r.user.toUpperCase() !== String(data.message.sender ?? '').toUpperCase()
    ) ?? []
  return (
    <aside
      className='min-w-0 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card xl:sticky xl:top-0 xl:max-h-[calc(100vh-180px)] xl:overflow-y-auto'
      data-chat-admin-detail={id}
    >
      <div className='flex items-center justify-between border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          Message #{id}
        </p>
        <button
          type='button'
          onClick={onClose}
          aria-label='Close'
          className='rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-100'
        >
          <X className='h-4 w-4' />
        </button>
      </div>
      {isLoading && (
        <div className='m-4 h-40 animate-pulse rounded-md bg-[hsl(var(--nvr-skeleton))]' />
      )}
      {isError && (
        <p className='p-4 text-[12.5px] text-red-600 dark:text-red-400'>
          Couldn't load this message.
        </p>
      )}
      {data && (
        <div className='space-y-4 p-4'>
          <div>
            <p className='whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-slate-900 dark:text-slate-50'>
              {data.message.deleted_at ? (
                <em className='text-slate-500 dark:text-slate-400'>
                  Deleted {formatDateTime(data.message.deleted_at)} — the text was removed when it
                  was deleted.
                </em>
              ) : (
                data.message.message || (
                  <em className='text-slate-500 dark:text-slate-400'>(no text)</em>
                )
              )}
            </p>
            {data.message.edited_at && !data.message.deleted_at && (
              <p className='mt-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
                Edited {formatDateTime(data.message.edited_at)}. Only the final text is kept.
              </p>
            )}
            {data.message.masquerade_admin_name && (
              <p className='mt-1 flex items-center gap-1 text-[11.5px] text-violet-700 dark:text-violet-300'>
                <AlertTriangle className='h-3 w-3' />
                Sent by {data.message.masquerade_admin_name} while signed in as{' '}
                {data.message.sender_name ?? 'this person'}.
              </p>
            )}
          </div>

          <dl className='divide-y divide-slate-100 dark:divide-border/60'>
            <DetailRow label='From'>{data.message.sender_name ?? 'Unknown'}</DetailRow>
            <DetailRow label='Sent'>
              {formatDateTime(data.message.date_created)}{' '}
              <span className='text-slate-500 dark:text-slate-400'>
                ({formatRelative(data.message.date_created)})
              </span>
            </DetailRow>
            <DetailRow label='Where'>
              <span className='flex flex-wrap items-center gap-1.5'>
                <KindChip kind={data.room.kind} />
                <button
                  type='button'
                  onClick={() => onRoom({ room: data.room.room, label: data.room.label })}
                  className='text-left font-medium hover:underline'
                  title='Show every message in this room'
                >
                  {data.room.label}
                </button>
              </span>
            </DetailRow>
            {data.room.participants.length > 0 && (
              <DetailRow label={data.room.kind === 'dm' ? 'Between' : 'Members'}>
                {data.room.participants.map((p) => p.name ?? 'Unknown').join(', ')}
              </DetailRow>
            )}
            {data.mentions.length > 0 && (
              <DetailRow label='Mentions'>{data.mentions.join(', ')}</DetailRow>
            )}
            {data.attachments.length > 0 && (
              <DetailRow label='Files'>
                <ul className='space-y-0.5'>
                  {data.attachments.map((f) => (
                    <li key={f.id}>
                      <a
                        href={`${apiBase}/files/${f.id}?download=1`}
                        className='inline-flex items-center gap-1 hover:underline'
                        target='_blank'
                        rel='noreferrer'
                      >
                        <Paperclip className='h-3 w-3' /> {f.name}
                      </a>
                      {f.size != null && (
                        <span className='ml-1 text-[11px] text-slate-500 dark:text-slate-400'>
                          {f.size >= 1_048_576
                            ? `${(f.size / 1_048_576).toFixed(1)} MB`
                            : `${Math.max(1, Math.round(f.size / 1024))} KB`}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </DetailRow>
            )}
            {data.reactions.length > 0 && (
              <DetailRow label='Reactions'>
                {data.reactions.map((r) => `${r.emoji} ${r.name ?? 'Someone'}`).join(', ')}
              </DetailRow>
            )}
            {(read.length > 0 || unread.length > 0) && (
              <DetailRow label='Read'>
                {read.length > 0 && (
                  <p>
                    <span className='text-emerald-700 dark:text-emerald-400'>Read by</span>{' '}
                    {read.map((r) => r.name ?? 'Someone').join(', ')}
                  </p>
                )}
                {unread.length > 0 && (
                  <p>
                    <span className='text-slate-500 dark:text-slate-400'>Not yet</span>{' '}
                    {unread.map((r) => r.name ?? 'Someone').join(', ')}
                  </p>
                )}
                <p className='text-[11px] text-slate-500 dark:text-slate-400'>
                  From each person's read marker for the room, not an exact read time.
                </p>
              </DetailRow>
            )}
            {(data.pinned || data.saved_by > 0) && (
              <DetailRow label='Kept'>
                {[
                  data.pinned && 'Pinned in the room',
                  data.saved_by > 0 && `saved by ${data.saved_by}`
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </DetailRow>
            )}
            {data.admin_views && (
              <DetailRow label='Reviewed'>
                Opened here {data.admin_views.count} time{data.admin_views.count === 1 ? '' : 's'}
                {data.admin_views.previous && (
                  <span className='text-slate-500 dark:text-slate-400'>
                    {' '}
                    · before you, by {data.admin_views.previous.by ?? 'an administrator'}{' '}
                    {formatRelative(data.admin_views.previous.at)}
                  </span>
                )}
              </DetailRow>
            )}
            {data.history.length > 0 && (
              <DetailRow label='History'>
                <ul className='space-y-0.5'>
                  {data.history.map((h, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: history rows have no id here
                    <li key={i} className='text-[12px]'>
                      <span className='font-medium'>
                        {h.action.replace(/^chat-message-/, '').replace(/-/g, ' ')}
                      </span>
                      {h.by && ` by ${h.by}`}
                      <span className='text-slate-500 dark:text-slate-400'>
                        {' '}
                        · {formatDateTime(h.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </DetailRow>
            )}
          </dl>

          <div>
            <p className='mb-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-slate-500 dark:text-slate-400'>
              Conversation around it
            </p>
            <div className='space-y-1'>
              {data.context.before.length === 0 && (
                <p className='px-2.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
                  Start of the conversation.
                </p>
              )}
              {data.context.before.map((m) => (
                <ContextLine key={m.id} m={m} />
              ))}
              <ContextLine
                target
                m={{
                  id: data.message.id,
                  sender: data.message.sender,
                  sender_name: data.message.sender_name,
                  message: data.message.message,
                  date_created: data.message.date_created,
                  edited_at: data.message.edited_at,
                  deleted_at: data.message.deleted_at
                }}
              />
              {data.context.after.map((m) => (
                <ContextLine key={m.id} m={m} />
              ))}
            </div>
            <button
              type='button'
              onClick={() => onRoom({ room: data.room.room, label: data.room.label })}
              className='mt-2 text-[12px] font-medium text-slate-700 hover:underline dark:text-slate-200'
            >
              Show every message in this room
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}

export function ChatAnalyticsView() {
  const [tab, setTab] = useState<'overview' | 'messages'>('overview')
  const [room, setRoom] = useState<{ room: string; label: string } | null>(null)
  return (
    <div className='space-y-4' data-chat-analytics>
      <TipLayer />
      <div className='flex gap-1 border-b border-slate-200 dark:border-border' role='tablist'>
        {(
          [
            ['overview', 'Overview'],
            ['messages', 'Messages']
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type='button'
            role='tab'
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium',
              tab === k
                ? 'border-nvr-cyan text-slate-900 dark:text-slate-50'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
            )}
            data-chat-analytics-tab={k}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === 'overview' ? (
        <Overview
          onOpenRoom={(r, label) => {
            setRoom({ room: r, label })
            setTab('messages')
          }}
        />
      ) : (
        <Messages room={room} onRoomChange={setRoom} />
      )}
    </div>
  )
}

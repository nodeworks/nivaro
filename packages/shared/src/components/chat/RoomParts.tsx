import {
  CalendarDays,
  ChevronLeft,
  ExternalLink,
  FileText,
  Link2,
  Pin,
  RotateCw,
  Sparkles,
  Trash2,
  Users,
  X
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { cn, formatFileSize, formatRelative } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  type ChatMessage,
  discardOutbox,
  type OutboxItem,
  type PinnedMessage,
  retryOutbox,
  useChatThread
} from './chat-core'
import { useRoomInfo, useRoomShared, useRoomSummary } from './chat-hooks'

/**
 * Pieces of a chat room that are not the message list itself: the thread
 * pane (#927), the room info drawer (#978 — members, pins, files, links,
 * #944; summaries over any range, #945), outbox bubbles (#983), the channel
 * purpose strip (#936), the welcome note (#961) and jump-to-date (#976).
 */

interface Th {
  divider: string
  surface: string
  accentText: string
  accentSoft: string
  bubbleMine: string
  input: string
  action: string
}

// ── Thread pane ──────────────────────────────────────────────────────────────

export function ThreadPane({
  room,
  rootId,
  th,
  onClose,
  renderRow,
  renderComposer,
  renderOutbox
}: {
  room: string
  rootId: number
  th: Th
  onClose: () => void
  renderRow: (m: ChatMessage, opts: { inThread: true }) => ReactNode
  renderComposer: (parentId: number) => ReactNode
  renderOutbox: (parentId: number) => ReactNode
}) {
  const { root, replies, loading } = useChatThread(room, rootId)
  const summary = useRoomSummary()
  const [text, setText] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll per new reply
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [replies.length])
  return (
    <div
      className={cn('absolute inset-0 z-20 flex min-h-0 flex-col', th.surface)}
      data-chat-thread={rootId}
    >
      <div className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-2', th.divider)}>
        <button
          type='button'
          onClick={onClose}
          className='rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
          aria-label='Back to the conversation'
        >
          <ChevronLeft className='h-4 w-4' strokeWidth={2} />
        </button>
        <p className='flex-1 text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          Thread
          <span className='ml-1.5 text-[11px] font-normal text-slate-500 dark:text-slate-400'>
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </span>
        </p>
        {replies.length >= 2 && (
          <button
            type='button'
            disabled={summary.isPending}
            onClick={() =>
              summary.mutate(
                { room, thread: rootId },
                { onSuccess: (d) => setText(d.summary ?? 'Not enough to summarize yet.') }
              )
            }
            className={cn(
              'flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-muted',
              th.accentText
            )}
            data-chat-thread-summarize
          >
            <Sparkles className='h-3.5 w-3.5' />
            {summary.isPending ? 'Summarizing…' : 'Summarize'}
          </button>
        )}
      </div>
      {text && (
        <div
          className={cn(
            'shrink-0 border-b px-3 py-2 text-[11.5px] leading-snug text-slate-700 dark:text-slate-200',
            th.divider
          )}
        >
          {text}
        </div>
      )}
      <div className='min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3'>
        {loading ? (
          <p className='py-6 text-center text-[12px] text-slate-500'>Loading…</p>
        ) : (
          <>
            {root && (
              <div className={cn('border-b pb-2.5', th.divider)}>
                {renderRow(root, { inThread: true })}
              </div>
            )}
            {replies.map((m) => (
              <div key={m.id}>{renderRow(m, { inThread: true })}</div>
            ))}
            {renderOutbox(rootId)}
          </>
        )}
        <div ref={endRef} />
      </div>
      {renderComposer(rootId)}
    </div>
  )
}

// ── Outbox bubbles (#983 / #984) ─────────────────────────────────────────────

export function OutboxBubbles({ items, th }: { items: OutboxItem[]; th: Th }) {
  if (items.length === 0) return null
  return (
    <>
      {items.map((o) => (
        <div key={o.client_id} className='flex flex-row-reverse gap-2' data-chat-outbox={o.status}>
          <div className='max-w-[78%] text-right'>
            <div
              className={cn(
                'inline-block whitespace-pre-wrap rounded-2xl rounded-br-md px-3 py-1.5 text-left text-[12.5px] leading-snug',
                th.bubbleMine,
                o.status !== 'failed' && 'opacity-70'
              )}
            >
              {o.text ||
                `${o.attachments.length} attachment${o.attachments.length === 1 ? '' : 's'}`}
            </div>
            <p className='mt-0.5 flex items-center justify-end gap-1.5 text-[10.5px]'>
              {o.status === 'sending' && <span className='text-slate-500'>Sending…</span>}
              {o.status === 'queued' && (
                <span className='text-amber-700 dark:text-amber-300'>
                  Waiting for a connection — it sends when you are back online
                </span>
              )}
              {o.status === 'failed' && (
                <>
                  <span className='text-red-600 dark:text-red-400'>
                    Not sent{o.error ? ` — ${o.error}` : ''}
                  </span>
                  <button
                    type='button'
                    onClick={() => retryOutbox(o.client_id)}
                    className={cn('inline-flex items-center gap-0.5 font-medium', th.accentText)}
                    data-chat-outbox-retry
                  >
                    <RotateCw className='h-3 w-3' /> Retry
                  </button>
                  <button
                    type='button'
                    onClick={() => discardOutbox(o.client_id)}
                    className='inline-flex items-center gap-0.5 text-slate-500 hover:text-red-600'
                  >
                    <Trash2 className='h-3 w-3' /> Remove
                  </button>
                </>
              )}
            </p>
          </div>
        </div>
      ))}
    </>
  )
}

// ── Channel purpose + pinned links (#936), welcome note (#961) ──────────────

export function ChannelIntro({
  description,
  links,
  th,
  navigate
}: {
  description: string | null | undefined
  links: Array<{ label: string; url: string }> | undefined
  th: Th
  navigate?: (url: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (!description && !links?.length) return null
  return (
    <div className={cn('shrink-0 border-b px-3 py-1.5', th.divider)} data-chat-channel-intro>
      <div className='flex items-start gap-2'>
        {description && (
          <p
            className={cn(
              'min-w-0 flex-1 text-[11.5px] leading-snug text-slate-600 dark:text-slate-300',
              !open && 'line-clamp-1'
            )}
          >
            {description}
          </p>
        )}
        {description && description.length > 80 && (
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            className='shrink-0 text-[11px] font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-100'
          >
            {open ? 'Less' : 'More'}
          </button>
        )}
      </div>
      {!!links?.length && (
        <div className='mt-1 flex flex-wrap gap-1.5'>
          {links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target={l.url.startsWith('/') ? undefined : '_blank'}
              rel='noopener noreferrer'
              onClick={(e) => {
                if (l.url.startsWith('/') && navigate) {
                  e.preventDefault()
                  navigate(l.url)
                }
              }}
              className='inline-flex max-w-[200px] items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-200'
              data-chat-channel-link
            >
              <Link2 className='h-3 w-3 shrink-0 opacity-60' />
              <span className='truncate'>{l.label}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

export function WelcomeNote({
  note,
  channelName,
  onDismiss,
  th
}: {
  note: string
  channelName: string
  onDismiss: () => void
  th: Th
}) {
  return (
    <div
      className={cn(
        'mx-3 mt-3 rounded-xl border px-3 py-2.5',
        th.divider,
        'bg-slate-50 dark:bg-muted/40'
      )}
      data-chat-welcome
    >
      <div className='flex items-start gap-2'>
        <div className='min-w-0 flex-1'>
          <p className='text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
            Welcome to {channelName}
          </p>
          <p className='mt-0.5 whitespace-pre-wrap text-[11.5px] leading-snug text-slate-600 dark:text-slate-300'>
            {note}
          </p>
        </div>
        <button
          type='button'
          onClick={onDismiss}
          className='shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-white dark:text-slate-300 dark:hover:bg-card'
          data-chat-welcome-dismiss
        >
          Got it
        </button>
      </div>
    </div>
  )
}

// ── Jump to a date (#976) ────────────────────────────────────────────────────

export function JumpToDate({ onJump }: { onJump: (dateIso: string) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
          aria-label='Jump to a date'
          title='Jump to a date'
          data-chat-jump-date
        >
          <CalendarDays className='h-3.5 w-3.5' strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[220px] p-2.5'>
        <p className='pb-1.5 text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
          Jump to a date
        </p>
        <input
          type='date'
          value={value}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => setValue(e.target.value)}
          className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] outline-none dark:border-border dark:bg-background dark:text-slate-100'
          aria-label='Date'
        />
        <div className='mt-2 flex gap-1.5'>
          {[
            ['Yesterday', 1],
            ['Last week', 7],
            ['Last month', 30]
          ].map(([l, d]) => (
            <button
              key={l as string}
              type='button'
              onClick={() => {
                const t = new Date(Date.now() - (d as number) * 86_400_000)
                t.setHours(0, 0, 0, 0)
                onJump(t.toISOString())
                setOpen(false)
              }}
              className='flex-1 rounded-md border border-slate-200 px-1 py-1 text-[10.5px] text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
            >
              {l}
            </button>
          ))}
        </div>
        <button
          type='button'
          disabled={!value}
          onClick={() => {
            const [y, m, d] = value.split('-').map(Number)
            onJump(new Date(y, m - 1, d).toISOString())
            setOpen(false)
          }}
          className='mt-2 h-8 w-full rounded-md bg-slate-900 text-[12px] font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900'
        >
          Go
        </button>
      </PopoverContent>
    </Popover>
  )
}

// ── Room info drawer (#978, #944, #945, #980) ────────────────────────────────

type InfoTab = 'members' | 'pinned' | 'files' | 'links'

export function RoomInfoDrawer({
  room,
  label,
  th,
  pins,
  onClose,
  onOpenMessage,
  renderAvatar,
  onUnpin,
  navigate
}: {
  room: string
  label: string
  th: Th
  pins: PinnedMessage[]
  onClose: () => void
  onOpenMessage: (id: number) => void
  renderAvatar: (id: string, name: string | null) => ReactNode
  onUnpin: (id: number) => void
  navigate?: (url: string) => void
}) {
  const client = useNivaroClient()
  const info = useRoomInfo(room)
  const [tab, setTab] = useState<InfoTab>('members')
  const shared = useRoomShared(room, tab === 'files' || tab === 'links')
  const summary = useRoomSummary()
  const [since, setSince] = useState('')
  const [summaryText, setSummaryText] = useState<string | null>(null)
  const tabs: Array<[InfoTab, string]> = [
    ['members', `Members${info ? ` · ${info.member_count}` : ''}`],
    ['pinned', `Pinned${pins.length ? ` · ${pins.length}` : ''}`],
    ['files', `Files${info?.file_count ? ` · ${info.file_count}` : ''}`],
    ['links', 'Links']
  ]
  return (
    <div
      className={cn('absolute inset-0 z-20 flex min-h-0 flex-col', th.surface)}
      data-chat-room-info
    >
      <div className={cn('flex shrink-0 items-center gap-2 border-b px-3 py-2', th.divider)}>
        <button
          type='button'
          onClick={onClose}
          className='rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'
          aria-label='Back to the conversation'
        >
          <ChevronLeft className='h-4 w-4' strokeWidth={2} />
        </button>
        <p className='min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          {label}
        </p>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        <dl
          className={cn(
            'grid grid-cols-2 gap-x-3 gap-y-2 border-b px-3 py-3 text-[11.5px]',
            th.divider
          )}
        >
          <div>
            <dt className='text-slate-500 dark:text-slate-400'>Members</dt>
            <dd className='font-medium text-slate-800 dark:text-slate-100'>
              {info ? `${info.member_count} · ${info.online_count} online` : '—'}
            </dd>
          </div>
          <div>
            <dt className='text-slate-500 dark:text-slate-400'>Your notifications</dt>
            <dd className='font-medium text-slate-800 dark:text-slate-100'>
              {info
                ? info.notify.muted
                  ? 'Muted'
                  : info.notify.mode === 'mentions'
                    ? 'Mentions only'
                    : 'All messages'
                : '—'}
            </dd>
          </div>
          {(info?.created_by || info?.created_at) && (
            <div className='col-span-2'>
              <dt className='text-slate-500 dark:text-slate-400'>Started</dt>
              <dd className='font-medium text-slate-800 dark:text-slate-100'>
                {[
                  info?.created_by ? `by ${info.created_by}` : null,
                  info?.created_at
                    ? new Date(info.created_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric'
                      })
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </dd>
            </div>
          )}
        </dl>
        <div className={cn('border-b px-3 py-2.5', th.divider)} data-chat-summarize-range>
          <p className='text-[11.5px] font-semibold text-slate-700 dark:text-slate-200'>
            Summarize
          </p>
          <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
            {[
              ['Last day', 1],
              ['Last week', 7]
            ].map(([l, d]) => (
              <button
                key={l as string}
                type='button'
                disabled={summary.isPending}
                onClick={() =>
                  summary.mutate(
                    {
                      room,
                      since: new Date(Date.now() - (d as number) * 86_400_000).toISOString()
                    },
                    {
                      onSuccess: (r) =>
                        setSummaryText(
                          r.summary ?? `Only ${r.count} messages — nothing to summarize.`
                        )
                    }
                  )
                }
                className='rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-300'
              >
                {l}
              </button>
            ))}
            <input
              type='date'
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className='h-6 rounded-md border border-slate-200 bg-white px-1.5 text-[11px] outline-none dark:border-border dark:bg-background dark:text-slate-100'
              aria-label='Summarize since'
            />
            <button
              type='button'
              disabled={!since || summary.isPending}
              onClick={() => {
                const [y, m, d] = since.split('-').map(Number)
                summary.mutate(
                  { room, since: new Date(y, m - 1, d).toISOString() },
                  {
                    onSuccess: (r) =>
                      setSummaryText(
                        r.summary ?? `Only ${r.count} messages — nothing to summarize.`
                      )
                  }
                )
              }}
              className={cn(
                'inline-flex items-center gap-1 text-[11px] font-medium disabled:opacity-40',
                th.accentText
              )}
            >
              <Sparkles className='h-3 w-3' /> {summary.isPending ? 'Summarizing…' : 'Since then'}
            </button>
          </div>
          {summaryText && (
            <p className='mt-2 text-[11.5px] leading-snug text-slate-700 dark:text-slate-200'>
              {summaryText}
            </p>
          )}
        </div>
        <div className={cn('flex gap-1 border-b px-2 pt-1.5', th.divider)} role='tablist'>
          {tabs.map(([k, l]) => (
            <button
              key={k}
              type='button'
              role='tab'
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                '-mb-px border-b-2 px-2 pb-1.5 text-[11.5px] font-medium',
                tab === k
                  ? 'border-slate-800 text-slate-800 dark:border-slate-100 dark:text-slate-100'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'
              )}
              data-chat-info-tab={k}
            >
              {l}
            </button>
          ))}
        </div>
        <div className='px-3 py-2'>
          {tab === 'members' &&
            (info?.members.length ? (
              <ul className='space-y-1'>
                {info.members.map((m) => (
                  <li key={m.id} className='flex items-center gap-2 py-0.5'>
                    {renderAvatar(m.id, m.name)}
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate text-[12px] text-slate-800 dark:text-slate-100'>
                        {m.name}
                      </span>
                      {m.title && (
                        <span className='block truncate text-[10.5px] text-slate-500'>
                          {m.title}
                        </span>
                      )}
                    </span>
                    {m.online && (
                      <span className='text-[10.5px] text-emerald-700 dark:text-emerald-400'>
                        Online
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className='py-4 text-center text-[11.5px] text-slate-500'>
                {info ? 'Anyone who can open this room can read it.' : 'Loading…'}
              </p>
            ))}
          {tab === 'pinned' &&
            (pins.length ? (
              <ul className='space-y-1.5'>
                {pins.map((p) => (
                  <li key={p.pin_id} className='flex items-start gap-1.5 text-[11.5px]'>
                    <Pin className='mt-0.5 h-3 w-3 shrink-0 text-slate-400' />
                    <button
                      type='button'
                      onClick={() => onOpenMessage(p.id)}
                      className='min-w-0 flex-1 text-left text-slate-700 hover:underline dark:text-slate-200'
                    >
                      <span className='font-medium'>{p.sender_name ?? 'Someone'}: </span>
                      {p.message.length > 160 ? `${p.message.slice(0, 160)}…` : p.message}
                    </button>
                    <button
                      type='button'
                      onClick={() => onUnpin(p.id)}
                      className='shrink-0 text-slate-400 hover:text-red-500'
                      aria-label='Unpin'
                    >
                      <X className='h-3 w-3' />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className='py-4 text-center text-[11.5px] text-slate-500'>
                Nothing pinned. Hover a message and use the pin to keep it here.
              </p>
            ))}
          {tab === 'files' &&
            (shared.loading ? (
              <p className='py-4 text-center text-[11.5px] text-slate-500'>Loading…</p>
            ) : shared.files.length ? (
              <ul className='space-y-1'>
                {shared.files.map((f) => (
                  <li
                    key={`${f.message_id}:${f.file_id}`}
                    className='flex items-center gap-2 text-[11.5px]'
                  >
                    <FileText className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                    <a
                      href={client.fileUrl(f.file_id)}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='min-w-0 flex-1 truncate text-slate-800 hover:underline dark:text-slate-100'
                    >
                      {f.name}
                    </a>
                    <span className='shrink-0 text-[10.5px] text-slate-500'>
                      {f.size != null ? `${formatFileSize(f.size)} · ` : ''}
                      {formatRelative(f.date_created)}
                    </span>
                    <button
                      type='button'
                      onClick={() => onOpenMessage(f.message_id)}
                      className='shrink-0 text-[10.5px] font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-100'
                    >
                      Show
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className='py-4 text-center text-[11.5px] text-slate-500'>
                No files shared here yet.
              </p>
            ))}
          {tab === 'links' &&
            (shared.loading ? (
              <p className='py-4 text-center text-[11.5px] text-slate-500'>Loading…</p>
            ) : shared.links.length ? (
              <ul className='space-y-1'>
                {shared.links.map((l) => (
                  <li
                    key={`${l.message_id}:${l.url}`}
                    className='flex items-center gap-2 text-[11.5px]'
                  >
                    <ExternalLink className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                    <a
                      href={l.url}
                      target='_blank'
                      rel='noopener noreferrer'
                      onClick={(e) => {
                        try {
                          const u = new URL(l.url)
                          if (u.origin === window.location.origin && navigate) {
                            e.preventDefault()
                            navigate(`${u.pathname}${u.search}`)
                          }
                        } catch {
                          /* external */
                        }
                      }}
                      className='min-w-0 flex-1 truncate text-slate-800 hover:underline dark:text-slate-100'
                    >
                      {l.url.replace(/^https?:\/\//, '')}
                    </a>
                    <span className='shrink-0 text-[10.5px] text-slate-500'>
                      {l.sender_name ?? ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className='py-4 text-center text-[11.5px] text-slate-500'>
                No links shared here yet.
              </p>
            ))}
        </div>
      </div>
    </div>
  )
}

export function MemberCountLine({ room }: { room: string }) {
  const info = useRoomInfo(room)
  if (!info) return null
  return (
    <p
      className='flex items-center gap-1 truncate text-[11px] text-slate-500 dark:text-slate-400'
      data-chat-member-count
    >
      <Users className='h-3 w-3' />
      {info.member_count} {info.member_count === 1 ? 'member' : 'members'} · {info.online_count}{' '}
      online
    </p>
  )
}

import { useQuery } from '@tanstack/react-query'
import { Bell, Eye, Mail, MailWarning, MessageSquareReply, Send, X } from 'lucide-react'
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import {
  channelTone,
  type DeliveryTone,
  deliverySummary,
  type MentionChannel,
  type MentionDelivery,
  mentionChannelText,
  mentionHeadline,
  repliesWhileTypingText,
  type SeenPerson,
  seenByText
} from '../../lib/comment-awareness'
import { useLivePreference } from '../../lib/live-preference'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * Realtime round 7 — the quiet awareness pieces of a comment thread (items 14–16). Shared by
 * the record's Comments panel and a field's comment popover; logic lives in
 * lib/comment-awareness.ts.
 */

// ── "2 new replies since you started typing" ──────────────────────────────

export interface ReplyPreview {
  id: string
  name: string
  text: string
  created_at?: string
}

/**
 * Above the composer while the draft is unsent and others have posted since it started. Never
 * scrolls anything by itself; a reply's name jumps to it only when clicked.
 */
export function RepliesWhileTyping({
  replies,
  onDismiss,
  onJump,
  compact
}: {
  replies: ReplyPreview[]
  onDismiss: () => void
  onJump?: (id: string) => void
  /** The field popover: one line per reply, smaller. */
  compact?: boolean
}) {
  if (replies.length === 0) return null
  const shown = replies.slice(-3)
  const more = replies.length - shown.length
  return (
    <section
      data-replies-while-typing={replies.length}
      aria-live='polite'
      aria-label={repliesWhileTypingText(replies.length)}
      className={cn(
        'rounded-lg border border-slate-200 bg-slate-50/80 dark:border-border dark:bg-muted/40',
        compact ? 'px-2.5 py-1.5' : 'px-3 py-2'
      )}
    >
      <div className='flex items-center gap-1.5'>
        <MessageSquareReply
          aria-hidden
          className='h-3.5 w-3.5 shrink-0 text-[#0e7490] dark:text-nvr-cyan'
        />
        <p className='m-0 min-w-0 flex-1 text-[11.5px] font-medium text-slate-700 dark:text-slate-200'>
          {repliesWhileTypingText(replies.length)}
        </p>
        <button
          type='button'
          onClick={onDismiss}
          aria-label='Dismiss new replies'
          data-replies-while-typing-dismiss
          className='rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-200'
        >
          <X aria-hidden className='h-3 w-3' />
        </button>
      </div>
      <ul className='m-0 mt-1 list-none space-y-0.5 p-0'>
        {shown.map((r) => (
          <li
            key={r.id}
            data-reply-while-typing={r.id}
            className='flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-snug'
          >
            {onJump ? (
              <button
                type='button'
                onClick={() => onJump(r.id)}
                className='shrink-0 font-medium text-slate-700 underline-offset-2 hover:text-[#0e7490] hover:underline dark:text-slate-200 dark:hover:text-nvr-cyan'
              >
                {r.name}
              </button>
            ) : (
              <span className='shrink-0 font-medium text-slate-700 dark:text-slate-200'>
                {r.name}
              </span>
            )}
            <span className='min-w-0 truncate text-slate-500 dark:text-slate-400'>{r.text}</span>
            {r.created_at && (
              <span className='ml-auto shrink-0 text-[10.5px] text-slate-400 dark:text-slate-500'>
                {formatRelative(r.created_at)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className='m-0 mt-0.5 text-[10.5px] text-slate-400 dark:text-slate-500'>
          and {more} earlier
        </p>
      )}
    </section>
  )
}

/** The nearest ancestor that scrolls vertically, else the page's scrolling element. */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

/**
 * Keep `target` (the comment box) where it is on screen when something above it changes size —
 * the replies note appearing or growing. Measures the box's top before and after the change and
 * scrolls its scroll container by the difference, so the person's caret never moves under them.
 * Skipped when the box was not on screen (nothing to hold still). The browser's own scroll
 * anchoring may already have held it; then the difference is 0 and nothing is scrolled.
 */
export function useHoldInPlace(target: RefObject<HTMLElement | null>, trigger: unknown): void {
  const lastTop = useRef<number | null>(null)
  const lastTrigger = useRef<unknown>(trigger)
  // Track the box's position as the person scrolls, so "before" is always current.
  useEffect(() => {
    const note = () => {
      const el = target.current
      lastTop.current = el ? el.getBoundingClientRect().top : null
    }
    note()
    window.addEventListener('scroll', note, { capture: true, passive: true })
    window.addEventListener('resize', note, { passive: true })
    return () => {
      window.removeEventListener('scroll', note, { capture: true })
      window.removeEventListener('resize', note)
    }
  }, [target])
  // Runs after every commit: compare against the position before this one.
  useLayoutEffect(() => {
    const el = target.current
    if (!el) {
      lastTop.current = null
      return
    }
    const before = lastTop.current
    const changed = !Object.is(lastTrigger.current, trigger)
    lastTrigger.current = trigger
    const now = el.getBoundingClientRect().top
    if (changed && before != null && now !== before) {
      const scroller = scrollParentOf(el)
      const view =
        scroller && scroller !== document.scrollingElement
          ? scroller.getBoundingClientRect()
          : { top: 0, bottom: window.innerHeight }
      const wasOnScreen = before + el.offsetHeight > view.top && before < view.bottom
      if (scroller && wasOnScreen) scroller.scrollTop += now - before
    }
    lastTop.current = el.getBoundingClientRect().top
  })
}

/** Briefly mark a thread entry the person jumped to from the strip (their click, not ours). */
export function jumpToComment(id: string): void {
  const el = document.querySelector(`[data-comment-id="${CSS.escape(id)}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('nvr-row-flash')
  setTimeout(() => el.classList.remove('nvr-row-flash'), 2400)
}

// ── Hover-or-click popover (shared by the two lines below) ────────────────

function useHoverOpen(): {
  open: boolean
  setOpen: (o: boolean) => void
  hover: { onMouseEnter: () => void; onMouseLeave: () => void }
} {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  return {
    open,
    setOpen,
    hover: {
      onMouseEnter: () => {
        clear()
        timer.current = setTimeout(() => setOpen(true), 250)
      },
      onMouseLeave: () => {
        clear()
        timer.current = setTimeout(() => setOpen(false), 200)
      }
    }
  }
}

// ── "Seen by Beth, Mark" ──────────────────────────────────────────────────

/**
 * Who has opened the record since the comment was written. `exclude` = people another line
 * already names (the mention receipts). Calm and Off show the count only ("Seen by 3"); the
 * names are one hover or click away in every mode.
 */
export function SeenByLine({
  people,
  exclude,
  hasMentions
}: {
  people: SeenPerson[] | undefined
  exclude?: ReadonlySet<string>
  hasMentions?: boolean
}) {
  const live = useLivePreference()
  const { open, setOpen, hover } = useHoverOpen()
  const list = (people ?? []).filter((p) => !exclude?.has(String(p.id).toUpperCase()))
  if (list.length === 0) return null
  const prefix = hasMentions ? 'Also seen by' : 'Seen by'
  const text = live.quiet ? `${prefix} ${list.length}` : seenByText(list, prefix)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-comment-seen-by={list.length}
          {...hover}
          className='mt-1 inline-flex max-w-full items-center gap-1 rounded text-[11px] text-slate-400 transition-colors hover:text-slate-600 focus-visible:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300'
        >
          <Eye aria-hidden className='h-3 w-3 shrink-0' />
          <span className='truncate'>{text}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[240px] p-0'
        onMouseEnter={hover.onMouseEnter}
        onMouseLeave={hover.onMouseLeave}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <p className='m-0 border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium text-slate-500 dark:border-border dark:text-slate-400'>
          Opened the record since this was written
        </p>
        <ul
          className='m-0 max-h-[220px] list-none overflow-y-auto overscroll-contain p-0 py-1'
          data-comment-seen-list
        >
          {list.map((p) => (
            <li
              key={p.id}
              className='flex items-baseline gap-2 px-3 py-1 text-[12px]'
              data-comment-seen-person={p.id}
            >
              <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200'>
                {p.name}
              </span>
              <span
                className='shrink-0 text-[11px] text-slate-400 dark:text-slate-500'
                data-tip={formatDateTime(p.seen_at)}
              >
                {formatRelative(p.seen_at)}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

// ── Mention delivery (the comment's author and administrators) ────────────

const TONE_DOT: Record<DeliveryTone, string> = {
  ok: 'bg-emerald-500',
  pending: 'bg-sky-500',
  warn: 'bg-amber-500',
  muted: 'bg-slate-300 dark:bg-slate-600'
}

const TONE_TEXT: Record<DeliveryTone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  pending: 'text-slate-600 dark:text-slate-300',
  warn: 'text-amber-700 dark:text-amber-400',
  muted: 'text-slate-500 dark:text-slate-400'
}

function ChannelIcon({ c }: { c: MentionChannel }) {
  const cls = 'h-3 w-3 shrink-0'
  if (c.key === 'email')
    return c.status === 'bounced' || c.status === 'failed' ? (
      <MailWarning aria-hidden className={cls} />
    ) : (
      <Mail aria-hidden className={cls} />
    )
  if (c.key === 'teams') return <Send aria-hidden className={cls} />
  return <Bell aria-hidden className={cls} />
}

/**
 * "Who did this reach?" — a small button at the end of the mention line that opens each
 * person's delivery: seen in app, in their notifications, alert sent, emailed, bounced, muted.
 * Read only when opened; kept fresh while open (30 s) and by the thread's own live refetch.
 */
export function MentionDeliveryButton({
  collection,
  item,
  commentId
}: {
  collection: string
  item: string
  commentId: string
}) {
  const client = useNivaroClient()
  const { open, setOpen, hover } = useHoverOpen()
  const { data, isLoading, isError } = useQuery<MentionDelivery[]>({
    queryKey: ['comments', collection, item, 'delivery', commentId],
    queryFn: () =>
      client
        .request<{ data: MentionDelivery[] }>(get(`/comments/${commentId}/delivery`))
        .then((r) => r.data ?? []),
    enabled: open,
    refetchInterval: open ? 30_000 : false,
    staleTime: 10_000
  })
  const summary = data ? deliverySummary(data) : ''
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          {...hover}
          data-mention-delivery={commentId}
          aria-label='Who this reached'
          className='inline-flex items-center gap-1 rounded px-1 py-px text-[11px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-muted dark:hover:text-slate-300'
        >
          <Send aria-hidden className='h-3 w-3' />
          Delivery
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[300px] p-0'
        onMouseEnter={hover.onMouseEnter}
        onMouseLeave={hover.onMouseLeave}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className='border-b border-slate-100 px-3 py-2 dark:border-border'>
          <p className='m-0 text-[12px] font-semibold text-slate-700 dark:text-slate-100'>
            Who this reached
          </p>
          <p className='m-0 mt-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
            {summary || 'Only you and administrators see this.'}
          </p>
        </div>
        {isLoading ? (
          <div className='space-y-2 px-3 py-3'>
            <div className='h-3 w-40 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
            <div className='h-3 w-28 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
          </div>
        ) : isError ? (
          <p className='m-0 px-3 py-3 text-[12px] text-slate-500 dark:text-slate-400'>
            Could not load who this reached. Try again in a moment.
          </p>
        ) : (data ?? []).length === 0 ? (
          <p className='m-0 px-3 py-3 text-[12px] text-slate-500 dark:text-slate-400'>
            This comment mentions only you.
          </p>
        ) : (
          <ul
            className='m-0 max-h-[300px] list-none divide-y divide-slate-100 overflow-y-auto overscroll-contain p-0 dark:divide-border'
            data-mention-delivery-list
          >
            {(data ?? []).map((p) => {
              const h = mentionHeadline(p)
              return (
                <li key={p.id} className='px-3 py-2' data-mention-delivery-person={p.headline}>
                  <div className='flex items-center gap-2'>
                    <span
                      aria-hidden
                      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[h.tone])}
                    />
                    <span className='min-w-0 flex-1 truncate text-[12px] font-medium text-slate-800 dark:text-slate-100'>
                      {p.name}
                    </span>
                  </div>
                  <p className={cn('m-0 mt-0.5 pl-3.5 text-[11.5px]', TONE_TEXT[h.tone])}>
                    {h.text}
                  </p>
                  {p.channels.length > 0 && (
                    <ul className='m-0 mt-0.5 list-none space-y-0.5 p-0 pl-3.5'>
                      {p.channels.map((c, i) => (
                        <li
                          // biome-ignore lint/suspicious/noArrayIndexKey: a person's channels are a fixed, ordered list
                          key={`${c.key}-${i}`}
                          data-mention-channel={`${c.key}:${c.status}`}
                          className={cn(
                            'flex items-center gap-1.5 text-[11px]',
                            TONE_TEXT[channelTone(c)]
                          )}
                        >
                          <ChannelIcon c={c} />
                          {mentionChannelText(c)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {p.reason && (
                    <p className='m-0 mt-0.5 pl-3.5 text-[10.5px] text-slate-400 dark:text-slate-500'>
                      {p.reason}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

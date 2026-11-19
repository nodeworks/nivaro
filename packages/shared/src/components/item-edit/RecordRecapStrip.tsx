import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, History, Mail, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatDateTime } from '../../lib/utils'
import { RevisionsPanel } from '../panels/RevisionsPanel'
import { RelativeTime } from '../RelativeTime'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { RecordRecapChangesList } from './RecordRecapChanges'

interface Recap {
  since: string
  field_changes: number
  fields: string[]
  comments: number
  transitions: number
  editors: string[]
}

interface EmailSince {
  since: string
  moved_to: { label: string; color: string | null } | null
  transitions: number
  field_changes: number
  fields: string[]
  comments: number
}

/** The `since` an email link carried (`?since=<iso>`), or null. Exported for tests. */
export function emailSinceFromSearch(search: string): string | null {
  try {
    const v = new URLSearchParams(search).get('since')
    if (!v || v.length > 40 || !Number.isFinite(Date.parse(v))) return null
    return v
  } catch {
    return null
  }
}

/** "moved to Approved · 2 fields changed · 1 new comment". Exported for tests. */
export function emailSinceParts(s: EmailSince): string[] {
  const parts: string[] = []
  if (s.moved_to) parts.push(`moved to ${s.moved_to.label}`)
  if (s.field_changes > 0)
    parts.push(`${s.field_changes} field${s.field_changes === 1 ? '' : 's'} changed`)
  if (s.comments > 0) parts.push(`${s.comments} new comment${s.comments === 1 ? '' : 's'}`)
  return parts
}

/** Drop `since` from the address bar without a navigation (a reload keeps the strip away). */
function forgetSinceParam(): void {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('since')) return
    url.searchParams.delete('since')
    window.history.replaceState(window.history.state, '', url.toString())
  } catch {
    /* the strip still hides */
  }
}

/** "1 new comment · 1 workflow transition" — what the popover's field list does not cover. */
export function recapExtras(r: { comments: number; transitions: number }): string | null {
  const parts: string[] = []
  if (r.comments > 0) parts.push(`${r.comments} new comment${r.comments === 1 ? '' : 's'}`)
  if (r.transitions > 0)
    parts.push(`${r.transitions} workflow transition${r.transitions === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : null
}

/**
 * The strip's text as a button that opens the field-by-field list beside it (an anchored
 * popover, never a modal): Escape closes it and focus returns to the strip; "See full history"
 * opens the record's history on the same window; "Mark as seen" is the strip's dismiss.
 */
function RecapPopover({
  collection,
  itemId,
  since,
  everyone,
  title,
  extras,
  historyAvailable,
  onMarkSeen,
  tone,
  children
}: {
  collection: string
  itemId: string
  since: string
  everyone?: boolean
  title: string
  extras: string | null
  historyAvailable: boolean
  onMarkSeen?: () => void
  tone: 'sky' | 'slate'
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // Mounted on first ask only: the history sheet loads the whole trail.
  const [history, setHistory] = useState<boolean | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const qc = useQueryClient()
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type='button'
            className={cn(
              'group flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none',
              tone === 'sky'
                ? 'hover:bg-sky-100/80 focus-visible:ring-sky-400/60 data-[state=open]:bg-sky-100/80 dark:hover:bg-sky-500/15 dark:data-[state=open]:bg-sky-500/15'
                : 'hover:bg-slate-200/50 focus-visible:ring-slate-400/50 data-[state=open]:bg-slate-200/50 dark:hover:bg-white/[0.06] dark:data-[state=open]:bg-white/[0.06]'
            )}
            data-recap-trigger
          >
            {children}
            <ChevronDown
              aria-hidden
              className={cn(
                'h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none',
                tone === 'sky' ? 'text-sky-500' : 'text-slate-400 dark:text-slate-500'
              )}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='start'
          side='bottom'
          sideOffset={6}
          collisionPadding={16}
          aria-label={title}
          onOpenAutoFocus={(e) => {
            // The list, not its first button: a reader starts at the top.
            e.preventDefault()
            bodyRef.current?.focus()
          }}
          className='w-[min(420px,calc(100vw-32px))] p-0 motion-reduce:animate-none'
          data-recap-popover
        >
          <div ref={bodyRef} tabIndex={-1} className='outline-none'>
            <div className='border-b border-slate-200/80 px-4 pb-2 pt-3 dark:border-border'>
              <p className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
                {title}
              </p>
              <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
                <time dateTime={since}>{formatDateTime(since)}</time> ·{' '}
                <RelativeTime value={since} />
              </p>
            </div>
            <div className='max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain px-4 py-1'>
              <RecordRecapChangesList
                collection={collection}
                itemId={itemId}
                since={since}
                everyone={everyone}
              />
            </div>
            {extras && (
              <p className='border-t border-slate-200/80 px-4 py-2 text-[11.5px] text-slate-500 dark:border-border dark:text-slate-400'>
                Also {extras}
              </p>
            )}
            {(historyAvailable || onMarkSeen) && (
              <div className='flex items-center justify-between gap-2 border-t border-slate-200/80 px-4 py-2 dark:border-border'>
                {historyAvailable ? (
                  <button
                    type='button'
                    onClick={() => {
                      setOpen(false)
                      setHistory(true)
                    }}
                    className='inline-flex items-center gap-1.5 rounded text-[12px] font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-300 dark:hover:text-slate-100'
                    data-recap-history
                  >
                    <History aria-hidden className='h-3.5 w-3.5' />
                    See full history
                  </button>
                ) : (
                  <span />
                )}
                {onMarkSeen && (
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='h-7 px-2.5 text-[12px]'
                    onClick={() => {
                      setOpen(false)
                      onMarkSeen()
                    }}
                    data-recap-mark-seen
                  >
                    Mark as seen
                  </Button>
                )}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {history !== null && (
        <RevisionsPanel
          collection={collection}
          item={itemId}
          open={history}
          onOpenChange={setHistory}
          since={since}
          onRollback={() => {
            // A rollback from here is our own write, so the live event skips it: re-read the
            // record, the "since you last viewed" changes and the history ourselves (rt audit #17).
            void qc.invalidateQueries({ queryKey: ['item', collection, itemId] })
            void qc.invalidateQueries({ queryKey: ['record-recap-changes', collection, itemId] })
            void qc.invalidateQueries({ queryKey: ['revisions', collection, itemId] })
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            triggerRef.current?.focus()
          }}
        />
      )}
    </>
  )
}

/**
 * "Since you last looked" — opening a saved record touches the per-user view
 * watermark and, when other people changed the record in between, renders a
 * one-line recap above the form. The server owns the session semantics (a
 * refresh within 30 minutes keeps the same baseline), the strip just shows
 * whatever the touch returned. Dismiss POSTs /dismiss, which collapses the
 * server baseline to now — a reload inside the session grace stays quiet, and
 * only changes made after the dismissal come back as news.
 *
 * The strip's text opens a popover beside it listing each changed field — before → after, who
 * and when (2026-11-18; it was a hover tooltip naming the fields). "Mark as seen" there is the
 * same dismiss.
 *
 * Opened from an email (realtime round 3 #2): the link carries the send time
 * (`?since=`), and the strip instead says quietly what happened since that
 * email — "Since this email: moved to Approved · 2 fields changed" — judged by
 * the server as the viewer (only fields they may read). Dismissing it drops
 * `since` from the address.
 */
export function RecordRecapStrip({
  collection,
  itemId,
  historyAvailable = false
}: {
  collection: string
  itemId: string
  /** The record page shows its revision history: the popover may open it ("See full history"). */
  historyAvailable?: boolean
}) {
  const client = useNivaroClient()
  const [recap, setRecap] = useState<Recap | null>(null)
  const [emailSince, setEmailSince] = useState<EmailSince | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const touchedRef = useRef<string | null>(null)

  useEffect(() => {
    const key = `${collection}|${itemId}`
    if (touchedRef.current === key) return
    touchedRef.current = key
    setRecap(null)
    setEmailSince(null)
    setDismissed(false)
    client
      .request<{ data: Recap | null }>(
        post(`/record-views/${collection}/${encodeURIComponent(itemId)}/touch`, {})
      )
      .then((r) => setRecap(r.data ?? null))
      .catch(() => {
        // A failed touch must never mark the record as "seen" — clear the
        // guard so a remount retries, and show nothing.
        touchedRef.current = null
      })
    const at = typeof window === 'undefined' ? null : emailSinceFromSearch(window.location.search)
    if (at) {
      client
        .request<{ data: EmailSince | null }>(
          get(`/record-views/${collection}/${encodeURIComponent(itemId)}/since`, { at })
        )
        .then((r) => setEmailSince(r.data ?? null))
        .catch(() => {
          /* the email strip is a courtesy — nothing on failure */
        })
    }
  }, [client, collection, itemId])

  const dismiss = () => {
    setDismissed(true)
    if (emailSince) {
      forgetSinceParam()
      return
    }
    // Best effort — a failed dismiss just means the strip may come back on
    // the next reload, which is the old behaviour, never worse.
    client
      .request(post(`/record-views/${collection}/${encodeURIComponent(itemId)}/dismiss`, {}))
      .catch(() => {})
  }

  if (dismissed) return null

  if (emailSince) {
    const parts = emailSinceParts(emailSince)
    if (parts.length === 0) return null
    const summary = (
      <>
        <Mail className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500' />
        <span className='min-w-0 flex-1 truncate text-[12px] text-slate-600 dark:text-slate-300'>
          <span className='text-slate-500 dark:text-slate-400'>Since this email:</span>{' '}
          {emailSince.moved_to && (
            <span
              aria-hidden
              className='mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle'
              style={{ backgroundColor: emailSince.moved_to.color ?? '#94a3b8' }}
            />
          )}
          <span className='font-medium text-slate-700 dark:text-slate-200'>
            {parts.join(' · ')}
          </span>
        </span>
      </>
    )
    return (
      <div
        className='nvr-expand-in flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 py-0.5 pl-1 pr-3 dark:border-border dark:bg-white/[0.03]'
        data-record-since-email
      >
        {emailSince.field_changes > 0 ? (
          <RecapPopover
            collection={collection}
            itemId={itemId}
            since={emailSince.since}
            everyone
            title='Changes since this email'
            extras={recapExtras({ comments: emailSince.comments, transitions: 0 })}
            historyAvailable={historyAvailable}
            tone='slate'
          >
            {summary}
          </RecapPopover>
        ) : (
          <p className='flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1'>{summary}</p>
        )}
        <button
          type='button'
          onClick={dismiss}
          aria-label='Dismiss'
          className='shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-300'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
    )
  }

  if (!recap) return null

  const parts: string[] = []
  if (recap.field_changes > 0) {
    parts.push(`${recap.field_changes} field${recap.field_changes === 1 ? '' : 's'} changed`)
  }
  if (recap.comments > 0)
    parts.push(`${recap.comments} new comment${recap.comments === 1 ? '' : 's'}`)
  if (recap.transitions > 0) {
    parts.push(`${recap.transitions} workflow transition${recap.transitions === 1 ? '' : 's'}`)
  }
  const who = recap.editors.length > 0 ? ` by ${recap.editors.join(', ')}` : ''

  const summary = (
    <>
      <History aria-hidden className='h-4 w-4 shrink-0 text-sky-500' />
      <span className='relative min-w-0 flex-1 truncate text-[12px] text-sky-800 dark:text-sky-300'>
        {/* A phone keeps the news, not the preamble ("7 fields changed", not "Since you la…"). */}
        <span className='max-sm:hidden'>
          Since you last viewed (<RelativeTime value={recap.since} />
          ):{' '}
        </span>
        <span className='sr-only sm:hidden'>Since you last viewed: </span>
        <span className='font-medium'>
          {recap.field_changes > 0 ? (
            <>
              {/* Only the part the popover lists reads as the thing to press. */}
              <span className='underline decoration-sky-400/60 decoration-dotted underline-offset-[3px] group-hover:decoration-solid dark:decoration-sky-400/50'>
                {parts[0]}
              </span>
              {parts.length > 1 ? ` · ${parts.slice(1).join(' · ')}` : ''}
            </>
          ) : (
            parts.join(' · ')
          )}
        </span>
        <span className='max-sm:hidden'>{who}</span>
      </span>
    </>
  )

  return (
    <div
      className='nvr-expand-in flex items-center gap-1 rounded-lg border border-sky-200 bg-sky-50 py-1 pl-1.5 pr-3.5 dark:border-sky-500/30 dark:bg-sky-500/10'
      data-record-recap
    >
      {recap.field_changes > 0 ? (
        <RecapPopover
          collection={collection}
          itemId={itemId}
          since={recap.since}
          title='Changes since you last viewed'
          extras={recapExtras(recap)}
          historyAvailable={historyAvailable}
          onMarkSeen={dismiss}
          tone='sky'
        >
          {summary}
        </RecapPopover>
      ) : (
        <p className='flex min-w-0 flex-1 items-center gap-3 px-2 py-1'>{summary}</p>
      )}
      <button
        type='button'
        onClick={dismiss}
        aria-label='Dismiss recap'
        className='shrink-0 rounded p-0.5 text-sky-400 hover:bg-sky-100 hover:text-sky-600 dark:hover:bg-sky-500/15'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}

import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNivaroClient } from '../context'
import { post } from '../lib/commands'
import { cn, formatRelative } from '../lib/utils'
import { RecapChangesPanel } from './item-edit/RecordRecapChanges'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** What changed on a record since the viewer last opened it (#643). */
export interface UnseenChange {
  changed_at: string
  by: string | null
  kinds: string[]
  /** The viewer's last open (ISO) — where the popover's list starts. Absent on older servers. */
  since?: string | null
}

const KIND_WORDS: Record<string, string> = {
  edit: 'edited',
  transition: 'moved',
  comment: 'commented on'
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? 'changed'
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** "Beth edited and moved this since you last opened it" — the popover's title. */
export function unseenHeadline(u: UnseenChange): string {
  const what = joinWords(u.kinds.map((k) => KIND_WORDS[k] ?? k))
  return `${u.by ?? 'Someone'} ${what} this since you last opened it`
}

/** "Beth edited and moved this · 2h ago" — one sentence for every host. */
export function unseenSentence(u: UnseenChange): string {
  const when = Number.isNaN(new Date(u.changed_at).getTime())
    ? ''
    : ` · ${formatRelative(u.changed_at)}`
  return `${unseenHeadline(u)}${when}`
}

/** What the field list cannot show: a move or a comment changes no field. Exported for tests. */
export function unseenExtras(kinds: string[]): string | null {
  const parts: string[] = []
  if (kinds.includes('transition')) parts.push('moved through its pipeline')
  if (kinds.includes('comment')) parts.push('new comments')
  return parts.length ? parts.join(' · ') : null
}

/** The empty list's words when the change was a move or a comment only. */
function unseenEmptyText(kinds: string[]): string | undefined {
  if (kinds.includes('edit')) return undefined
  return 'No field changed — open the record to see the move or the comments.'
}

const MARK =
  'h-[7px] w-[7px] rounded-full bg-nvr-cyan ring-[3px] ring-nvr-cyan/15 transition-[box-shadow] duration-150 motion-reduce:transition-none'

/**
 * The "changed since you last looked" mark. Always occupies its slot — pass
 * `change={null}` to reserve the space on rows that have nothing new, so the
 * column beside it never shifts between rows.
 *
 * The visible dot is 7px; the target around it is 16px so it is actually reachable. With
 * `collection` + `itemId` (and a server that sends `since`) it is a button: a click opens the
 * same field-by-field list the record form's "since you last looked" strip opens — who changed
 * what, before → after — with Open record and Mark as seen. Clicks inside never reach the row.
 */
export function UnseenDot({
  change,
  dataAttr = 'data-unseen',
  hang = false,
  collection,
  itemId,
  onOpen,
  onSeen
}: {
  change: UnseenChange | null | undefined
  /** Probe hook kept per host (`data-cbv-unseen`, `data-queue-unseen`). */
  dataAttr?: string
  /**
   * Hang the mark in the cell's left padding (inside a `gap-1.5` flex row) so
   * the text after it stays aligned with its column header. The host widens
   * that column's left padding to make room.
   */
  hang?: boolean
  /** The record the row is: turns the mark into the changes popover. */
  collection?: string
  itemId?: string
  /** Open the record the host's way (the row's own click). */
  onOpen?: () => void
  /** After Mark as seen: the host re-reads its marks. */
  onSeen?: () => void
}) {
  if (!change) return hang ? null : <span aria-hidden className='inline-block h-4 w-4 shrink-0' />
  const sentence = unseenSentence(change)
  if (!collection || !itemId || !change.since) {
    return (
      <span
        {...{ [dataAttr]: '' }}
        data-tip={sentence}
        role='img'
        aria-label={sentence}
        className={cn(
          'inline-flex h-4 w-4 shrink-0 cursor-default items-center justify-center',
          hang && '-ml-[22px]'
        )}
      >
        <span className={MARK} />
      </span>
    )
  }
  return (
    <UnseenPopover
      change={change}
      since={change.since}
      sentence={sentence}
      dataAttr={dataAttr}
      hang={hang}
      collection={collection}
      itemId={itemId}
      onOpen={onOpen}
      onSeen={onSeen}
    />
  )
}

function UnseenPopover({
  change,
  since,
  sentence,
  dataAttr,
  hang,
  collection,
  itemId,
  onOpen,
  onSeen
}: {
  change: UnseenChange
  since: string
  sentence: string
  dataAttr: string
  hang: boolean
  collection: string
  itemId: string
  onOpen?: () => void
  onSeen?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [marking, setMarking] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const markSeen = async () => {
    setMarking(true)
    try {
      await client.request(
        post(`/record-views/${collection}/${encodeURIComponent(itemId)}/dismiss`, {})
      )
      setOpen(false)
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'cbv-unseen' && q.queryKey[1] === collection
      })
      onSeen?.()
    } catch {
      // The mark stays; the next open of the record clears it anyway.
    } finally {
      setMarking(false)
    }
  }
  return (
    // The row opens on click and on Enter: nothing in here (portaled content included — React
    // events bubble through portals) may reach it.
    // biome-ignore lint/a11y/noStaticElementInteractions: an event fence; the button inside is the control
    <span
      className={cn('inline-flex shrink-0', hang && '-ml-[22px]')}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            {...{ [dataAttr]: '' }}
            aria-label={`${sentence}. Show what changed`}
            className='group/unseen inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
          >
            <span
              className={cn(
                MARK,
                'group-hover/unseen:ring-nvr-cyan/30 group-data-[state=open]/unseen:ring-nvr-cyan/40'
              )}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='start'
          side='bottom'
          sideOffset={6}
          collisionPadding={16}
          aria-label={unseenHeadline(change)}
          onOpenAutoFocus={(e) => {
            // The list, not its first button: a reader starts at the top.
            e.preventDefault()
            bodyRef.current?.focus()
          }}
          className='w-[min(420px,calc(100vw-32px))] p-0 motion-reduce:animate-none'
          data-unseen-popover
        >
          {open && (
            <RecapChangesPanel
              bodyRef={bodyRef}
              collection={collection}
              itemId={itemId}
              since={since}
              title={unseenHeadline(change)}
              sinceLabel='You last opened it'
              extras={unseenExtras(change.kinds)}
              emptyText={unseenEmptyText(change.kinds)}
              footer={
                <>
                  <button
                    type='button'
                    disabled={marking}
                    onClick={() => void markSeen()}
                    className='rounded text-[12px] font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:opacity-60 dark:text-slate-300 dark:hover:text-slate-100'
                    data-unseen-mark-seen
                  >
                    {marking ? 'Marking…' : 'Mark as seen'}
                  </button>
                  {onOpen ? (
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-7 gap-1 px-2.5 text-[12px]'
                      onClick={() => {
                        setOpen(false)
                        onOpen()
                      }}
                      data-unseen-open
                    >
                      Open record
                      <ArrowUpRight aria-hidden className='h-3.5 w-3.5' />
                    </Button>
                  ) : (
                    <span />
                  )}
                </>
              }
            />
          )}
        </PopoverContent>
      </Popover>
    </span>
  )
}

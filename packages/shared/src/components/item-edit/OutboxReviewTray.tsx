import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, GitMerge } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../../context'
import { type FieldMergeKind, fieldMergeKind } from '../../lib/field-merge'
import { liveMotionAllowed } from '../../lib/live-preference'
import { fetchCollectionMeta, queryKeys } from '../../lib/query-keys'
import {
  isRecordOutboxHeld,
  type OutboxPick,
  onOutboxReviewNudge,
  type RecordConflict,
  type RecordOutboxEntry,
  resolveRecordOutboxField
} from '../../lib/record-outbox'
import { cn, titleCase } from '../../lib/utils'
import { RelativeTime } from '../RelativeTime'
import { FieldMergePanel, useShown } from './RemoteChangeUi'
import type { CMSField } from './types'
import { useRecordLabels } from './useRecordLabels'

/**
 * Offline edits reviewed on reconnect (realtime round 8, item 3). When the connection comes
 * back the outbox checks every waiting save against what others changed meanwhile (read as the
 * viewer) and sends the fields nobody touched. A field someone else changed waits here — it is
 * never sent until the person picks Keep mine / Take theirs / Merge (the same merge the open
 * form offers, lib/field-merge.ts). A record whose form is open in this tab reviews in that
 * form's own merge dialog instead.
 *
 * A quiet card in the corner: a one-line pill until the person opens it (or presses Save /
 * leaves a record while a clash waits), never over the middle of the page, no sound, no
 * motion beyond the shared expand-in.
 */

export function conflictEntriesToReview(entries: RecordOutboxEntry[]): RecordOutboxEntry[] {
  return entries.filter(
    (e) => e.status === 'conflict' && (e.conflicts?.length ?? 0) > 0 && !isRecordOutboxHeld(e.id)
  )
}

export function OutboxReviewTray({
  entries,
  onOpenRecord
}: {
  entries: RecordOutboxEntry[]
  onOpenRecord?: (collection: string, itemId: string) => void
}) {
  const waiting = conflictEntriesToReview(entries)
  const fields = waiting.reduce((n, e) => n + (e.conflicts?.length ?? 0), 0)
  // Folded to its one-line pill by default (unobtrusive); it opens on a click, or by itself
  // only when the person presses Save or leaves a record while a clash still waits.
  const [open, setOpen] = useState(false)
  useEffect(() => onOutboxReviewNudge(() => setOpen(true)), [])
  if (waiting.length === 0 || typeof document === 'undefined') return null
  const summary = `${fields} offline change${fields === 1 ? '' : 's'} need${fields === 1 ? 's' : ''} a look`
  return createPortal(
    <section
      data-outbox-review
      aria-label='Offline changes to review'
      className='fixed bottom-20 right-4 z-[60] w-[400px] max-w-[calc(100vw-2rem)]'
    >
      {!open ? (
        <button
          type='button'
          data-outbox-review-open
          onClick={() => setOpen(true)}
          className='ml-auto flex items-center gap-2 rounded-full border border-amber-300/80 bg-white py-1.5 pl-3 pr-3.5 text-[12px] font-medium text-slate-800 shadow-[0_4px_14px_-6px_rgba(15,23,42,0.25)] transition-colors hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 dark:border-amber-400/30 dark:bg-card dark:text-slate-100 dark:hover:bg-amber-400/10'
        >
          <span className='h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400' />
          {summary}
        </button>
      ) : (
        <div className='nvr-expand-in flex max-h-[min(calc(100vh-7rem),640px)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_12px_32px_-12px_rgba(15,23,42,0.35)] dark:border-border dark:bg-card'>
          <header className='flex shrink-0 items-start gap-2 border-b border-slate-100 px-4 py-3 dark:border-border'>
            <span className='mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400' />
            <div className='min-w-0 flex-1'>
              <h2 className='text-[13px] font-semibold text-slate-900 dark:text-slate-50'>
                Changed while you were offline
              </h2>
              <p className='mt-0.5 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'>
                Nothing here is sent until you choose.
              </p>
            </div>
            <button
              type='button'
              onClick={() => setOpen(false)}
              aria-label='Fold this away'
              data-tip='Fold away'
              className='-mr-1 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:hover:bg-muted dark:hover:text-slate-200'
            >
              <ChevronDown className='h-4 w-4' />
            </button>
          </header>
          <ScrollBody>
            {waiting.map((e) => (
              <OutboxClashEntry key={e.id} entry={e} onOpenRecord={onOpenRecord} />
            ))}
          </ScrollBody>
        </div>
      )}
    </section>,
    document.body
  )
}

/** The card's scrolling list, with a soft fade at the bottom while more is below. */
function ScrollBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 4)
    check()
    el.addEventListener('scroll', check, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    ro?.observe(el)
    for (const c of Array.from(el.children)) ro?.observe(c)
    const mo = new MutationObserver(check)
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener('scroll', check)
      ro?.disconnect()
      mo.disconnect()
    }
  }, [])
  return (
    <div className='relative min-h-0 flex-1'>
      <div
        ref={ref}
        data-outbox-scroll
        className='h-full max-h-full divide-y divide-slate-100 overflow-y-auto overscroll-contain dark:divide-border'
      >
        {children}
      </div>
      {more && (
        <div
          aria-hidden
          data-outbox-more-below
          className='pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-white to-transparent dark:from-card'
        />
      )}
    </div>
  )
}

function OutboxClashEntry({
  entry,
  onOpenRecord
}: {
  entry: RecordOutboxEntry
  onOpenRecord?: (collection: string, itemId: string) => void
}) {
  const client = useNivaroClient()
  const { data: meta } = useQuery({
    queryKey: queryKeys.collectionMeta(entry.collection),
    queryFn: () => fetchCollectionMeta(client, entry.collection),
    staleTime: 10 * 60_000
  })
  const qc = useQueryClient()
  const labels = useRecordLabels(entry.collection, [entry.item])
  const labelState = qc.getQueryState(['record-label', entry.collection, entry.item])
  const labelPending = !labels.has(entry.item) && (!labelState || labelState.status === 'pending')
  const byField = useMemo(
    () => new Map((meta?.fields ?? []).map((f) => [f.field, f as unknown as CMSField])),
    [meta]
  )
  const relatedOf = (field: string): string | null =>
    (meta?.relations ?? []).find(
      (r) => r.many_collection === entry.collection && r.many_field === field && !r.junction_field
    )?.one_collection ?? null
  const singular = typeof meta?.singular === 'string' ? meta.singular.trim() : ''
  const noun = singular || singularOf(titleCase(entry.collection.replace(/_/g, ' ')))
  const label = labels.get(entry.item) ?? `#${entry.item}`
  if (!meta || labelPending)
    return (
      <article data-outbox-entry={entry.id} aria-busy='true' className='space-y-2 px-4 py-3'>
        <div className='h-3.5 w-40 rounded bg-slate-100 dark:bg-muted' />
        <div className='h-20 rounded-lg bg-slate-50 dark:bg-muted/50' />
      </article>
    )
  const sent = entry.sent_fields?.length ?? 0
  return (
    <article data-outbox-entry={entry.id} className='px-4 py-3'>
      <div className='flex items-baseline gap-2'>
        <p className='min-w-0 flex-1 truncate text-[12.5px] text-slate-500 dark:text-slate-400'>
          {noun} <span className='font-medium text-slate-900 dark:text-slate-100'>{label}</span>
        </p>
        {onOpenRecord && (
          <button
            type='button'
            onClick={() => onOpenRecord(entry.collection, entry.item)}
            className='inline-flex shrink-0 items-center gap-1 rounded text-[11.5px] font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:text-slate-400 dark:hover:text-slate-100'
          >
            Open <ExternalLink className='h-3 w-3' />
          </button>
        )}
      </div>
      {sent > 0 && (
        <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
          {sent} other change{sent === 1 ? ' was' : 's were'} saved.
        </p>
      )}
      <ul className='mt-2 space-y-2'>
        {(entry.conflicts ?? []).map((c) => {
          const f = byField.get(c.field) ?? null
          return (
            <OutboxClashRow
              key={c.field}
              entry={entry}
              clash={c}
              field={f}
              label={f?.label || titleCase(c.field.replace(/_/g, ' '))}
              relatedCollection={relatedOf(c.field)}
            />
          )
        })}
      </ul>
    </article>
  )
}

/** "Workflows" → "Workflow" (only when the collection names no singular of its own). */
function singularOf(words: string): string {
  if (/ies$/i.test(words)) return words.replace(/ies$/i, 'y')
  if (/[^s]s$/i.test(words)) return words.slice(0, -1)
  return words
}

const btn =
  'shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50'

export function OutboxClashRow({
  entry,
  clash,
  field,
  label,
  relatedCollection,
  onPick
}: {
  entry: RecordOutboxEntry
  clash: RecordConflict
  field: CMSField | null
  label: string
  relatedCollection: string | null
  /** Test seam; defaults to the outbox's own decision. */
  onPick?: (choice: OutboxPick) => void
}) {
  const mine = entry.payload[clash.field]
  const theirs = clash.current_value
  const base = entry.before[clash.field]
  const shownRaw = useShown(field, relatedCollection, [mine, theirs, base])
  // Plain numbers read with their thousands separators (17,900).
  const shown = (v: unknown, max?: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : shownRaw(v, max)
  // Two long values that share a start show from where they differ, or the cut hides the
  // very difference the preview is for (rt8 review).
  const views = clash.hidden ? ['', ''] : diffPreviews(shown(theirs, 400), shown(mine, 400))
  const [merging, setMerging] = useState(false)
  const [busy, setBusy] = useState(false)
  const rowRef = useRef<HTMLLIElement>(null)
  // The opened merge brings its result and its confirm into view inside the card.
  useEffect(() => {
    if (!merging) return
    const t = setTimeout(() => {
      rowRef.current
        ?.querySelector<HTMLElement>('[data-merge-apply]')
        ?.scrollIntoView({ block: 'nearest', behavior: liveMotionAllowed() ? 'smooth' : 'auto' })
    }, 60)
    return () => clearTimeout(t)
  }, [merging])
  const kind: FieldMergeKind = clash.hidden ? 'none' : fieldMergeKind(field, mine, theirs)
  const who = clash.by || 'Someone'
  const decide = (choice: OutboxPick) => {
    setBusy(true)
    setMerging(false)
    if (onPick) onPick(choice)
    else
      void resolveRecordOutboxField(entry.collection, entry.item, clash.field, choice).finally(() =>
        setBusy(false)
      )
  }
  return (
    <li
      data-outbox-clash={clash.field}
      ref={rowRef}
      className='rounded-lg border border-amber-200/80 bg-amber-50/50 px-3 py-2 dark:border-amber-400/30 dark:bg-white/[0.02]'
    >
      <p className='text-[12px] leading-snug text-slate-700 dark:text-slate-200'>
        <span className='font-semibold text-slate-900 dark:text-slate-50'>{who}</span> changed{' '}
        <span className='font-semibold text-slate-900 dark:text-slate-50'>{label}</span>{' '}
        <span className='whitespace-nowrap'>while you were offline</span>
        {clash.at && (
          <span className='whitespace-nowrap text-slate-500 dark:text-slate-400'>
            {' '}
            · <RelativeTime value={clash.at} />
          </span>
        )}
      </p>
      {clash.hidden ? (
        <p className='mt-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
          You can no longer see this field's value, so only its change is shown.
        </p>
      ) : (
        <dl className='mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]'>
          <dt className='text-slate-500 dark:text-slate-400'>Theirs</dt>
          <dd
            className='min-w-0 truncate font-medium text-slate-900 tabular-nums dark:text-slate-50'
            data-tip={shown(theirs, 400)}
          >
            {views[0]}
          </dd>
          <dt className='text-slate-500 dark:text-slate-400'>Yours</dt>
          <dd
            className='min-w-0 truncate font-medium text-slate-900 tabular-nums dark:text-slate-50'
            data-tip={shown(mine, 400)}
          >
            {views[1]}
          </dd>
        </dl>
      )}
      <div className='mt-2 flex flex-wrap items-center gap-1'>
        <button
          type='button'
          disabled={busy}
          onClick={() => decide('mine')}
          data-outbox-keep-mine
          className={cn(
            btn,
            // Quiet while a merge is open: only one choice looks chosen at a time.
            merging
              ? 'text-slate-700 hover:bg-amber-100/80 dark:text-slate-200 dark:hover:bg-amber-400/10'
              : 'border border-amber-300 bg-white text-amber-900 hover:bg-amber-50 dark:border-amber-400/30 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-400/10'
          )}
        >
          Keep mine
        </button>
        <button
          type='button'
          disabled={busy}
          onClick={() => decide('theirs')}
          data-outbox-take-theirs
          className={cn(
            btn,
            'text-slate-700 hover:bg-amber-100/80 dark:text-slate-200 dark:hover:bg-amber-400/10'
          )}
        >
          Take theirs
        </button>
        {kind !== 'none' && (
          <button
            type='button'
            disabled={busy}
            onClick={() => setMerging((v) => !v)}
            aria-expanded={merging}
            data-outbox-merge
            className={cn(
              btn,
              'inline-flex items-center gap-1',
              merging
                ? 'bg-amber-100 text-amber-900 ring-1 ring-amber-300 dark:bg-amber-400/15 dark:text-amber-100 dark:ring-amber-400/40'
                : 'text-slate-700 hover:bg-amber-100/80 dark:text-slate-200 dark:hover:bg-amber-400/10'
            )}
          >
            <GitMerge className='h-3 w-3' /> Merge
          </button>
        )}
      </div>
      {merging && kind !== 'none' && (
        <FieldMergePanel
          kind={kind}
          base={base}
          mine={mine}
          theirs={theirs}
          by={who}
          shown={(v) => shown(v, 120)}
          onCancel={() => setMerging(false)}
          onApply={(v) => decide({ merged: v })}
        />
      )}
    </li>
  )
}

/**
 * Previews of two values for one line each. When they share a long start (a note with a word
 * changed at the end), both start one word before the first difference: "…crew on Friday." vs
 * "…crew." Values that differ early show as they are. Exported for tests.
 */
export function diffPreviews(a: string, b: string): [string, string] {
  if (a === b) return [a, b]
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (i < 24) return [a, b]
  const wordStart = a.lastIndexOf(' ', i - 1)
  const before = wordStart > 0 ? a.lastIndexOf(' ', wordStart - 1) : -1
  const from = before >= 0 ? before + 1 : wordStart >= 0 ? wordStart + 1 : i
  if (from <= 0) return [a, b]
  return [`…${a.slice(from)}`, `…${b.slice(from)}`]
}

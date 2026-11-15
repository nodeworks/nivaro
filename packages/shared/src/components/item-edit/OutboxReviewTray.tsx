import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, GitMerge } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient } from '../../context'
import { type FieldMergeKind, fieldMergeKind } from '../../lib/field-merge'
import { fetchCollectionMeta, queryKeys } from '../../lib/query-keys'
import {
  isRecordOutboxHeld,
  type OutboxPick,
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
 * A quiet card in the corner: collapsed to one line after the first look, never over the
 * middle of the page, no sound, no motion beyond the shared expand-in.
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
  const [open, setOpen] = useState(true)
  // A clash that was not here before opens the card once; after that it stays as the person left it.
  const seen = useRef<Set<string>>(new Set())
  const mark = waiting.map((e) => `${e.id}@${e.latest_revision ?? ''}`).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the clash marks
  useEffect(() => {
    const fresh = waiting.some((e) => !seen.current.has(`${e.id}@${e.latest_revision ?? ''}`))
    for (const e of waiting) seen.current.add(`${e.id}@${e.latest_revision ?? ''}`)
    if (fresh) setOpen(true)
  }, [mark])
  if (waiting.length === 0 || typeof document === 'undefined') return null
  const summary = `${fields} offline change${fields === 1 ? '' : 's'} need${fields === 1 ? 's' : ''} a look`
  return createPortal(
    <section
      data-outbox-review
      aria-label='Offline changes to review'
      className='fixed bottom-4 right-4 z-[60] w-[400px] max-w-[calc(100vw-2rem)]'
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
        <div className='nvr-expand-in flex max-h-[min(70vh,560px)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_12px_32px_-12px_rgba(15,23,42,0.35)] dark:border-border dark:bg-card'>
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
          <div className='min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto overscroll-contain dark:divide-border'>
            {waiting.map((e) => (
              <OutboxClashEntry key={e.id} entry={e} onOpenRecord={onOpenRecord} />
            ))}
          </div>
        </div>
      )}
    </section>,
    document.body
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
  const labels = useRecordLabels(entry.collection, [entry.item])
  const byField = useMemo(
    () => new Map((meta?.fields ?? []).map((f) => [f.field, f as unknown as CMSField])),
    [meta]
  )
  const relatedOf = (field: string): string | null =>
    (meta?.relations ?? []).find(
      (r) => r.many_collection === entry.collection && r.many_field === field && !r.junction_field
    )?.one_collection ?? null
  const singular = typeof meta?.singular === 'string' ? meta.singular.trim() : ''
  const noun = singular || titleCase(entry.collection.replace(/_/g, ' '))
  const label = labels.get(entry.item) ?? `#${entry.item}`
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
  const [merging, setMerging] = useState(false)
  const [busy, setBusy] = useState(false)
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
      className='rounded-lg border border-amber-200/80 bg-amber-50/50 px-3 py-2 dark:border-amber-400/25 dark:bg-amber-400/[0.06]'
    >
      <p className='text-[12px] leading-snug text-slate-700 dark:text-slate-200'>
        <span className='font-semibold text-slate-900 dark:text-slate-50'>{who}</span> changed{' '}
        <span className='font-semibold text-slate-900 dark:text-slate-50'>{label}</span> while you
        were offline
        {clash.at && (
          <span className='text-slate-500 dark:text-slate-400'>
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
            {shown(theirs)}
          </dd>
          <dt className='text-slate-500 dark:text-slate-400'>Yours</dt>
          <dd
            className='min-w-0 truncate font-medium text-slate-900 tabular-nums dark:text-slate-50'
            data-tip={shown(mine, 400)}
          >
            {shown(mine)}
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
            'border border-amber-300 bg-white text-amber-900 hover:bg-amber-50 dark:border-amber-400/30 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-400/10'
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
            'text-slate-600 hover:bg-amber-100/80 dark:text-slate-300 dark:hover:bg-amber-400/10'
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
              'inline-flex items-center gap-1 text-slate-600 hover:bg-amber-100/80 dark:text-slate-300 dark:hover:bg-amber-400/10'
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

import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CloudOff, GitMerge, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import {
  bindRecordOutbox,
  getRecordOutbox,
  onRecordOutboxEvent,
  type RecordOutboxEntry,
  subscribeRecordOutbox
} from '../../lib/record-outbox'
import { announceRecordTabs } from '../../lib/record-tabs'
import { formatDate, formatRelative } from '../../lib/utils'

/** Every pending offline save of the signed-in person. */
export function useRecordOutbox(): RecordOutboxEntry[] {
  return useSyncExternalStore(subscribeRecordOutbox, getRecordOutbox, getRecordOutbox)
}

/** The pending offline save for one record, if any. */
export function useRecordOutboxEntry(
  collection: string,
  itemId: string | number | null | undefined
): RecordOutboxEntry | null {
  const all = useRecordOutbox()
  if (itemId == null || itemId === 'new') return null
  return all.find((e) => e.collection === collection && e.item === String(itemId)) ?? null
}

/**
 * Mounted ONCE by a host (admin's AppLayout), inside a NivaroProvider and a
 * QueryClientProvider: binds the outbox to the signed-in person so saves left
 * from an earlier visit replay on any page, and says what happened to them.
 * `onOpenRecord` opens a record whose replay hit someone else's change — the
 * record form then opens its merge dialog.
 */
export function RecordOutboxHost({
  userId,
  onOpenRecord
}: {
  userId: string | null | undefined
  onOpenRecord?: (collection: string, itemId: string) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  useEffect(() => {
    if (userId) bindRecordOutbox(client, userId, qc)
  }, [client, userId, qc])
  useEffect(
    () =>
      onRecordOutboxEvent((e) => {
        const { collection, item } = e.entry
        if (e.type === 'replayed') {
          announceRecordTabs(userId, 'saved', collection, item)
          toast.success('Your offline change was saved')
          return
        }
        if (e.type === 'expired') {
          // Values never ride the note — only when it was made.
          toast.info(
            `An unsaved change from ${formatDate(e.entry.created_at)} was discarded — it waited more than a week to be sent`,
            { duration: 20_000 }
          )
          return
        }
        const open = onOpenRecord
          ? { action: { label: 'Review', onClick: () => onOpenRecord(collection, item) } }
          : {}
        if (e.type === 'conflict')
          toast.warning('Someone else changed a record you saved offline — review the merge', {
            duration: 20_000,
            ...open
          })
        else toast.error(`An offline change could not be saved: ${e.entry.error ?? ''}`, open)
      }),
    [userId, onOpenRecord]
  )
  return null
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return 'empty'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const str = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return str.length > 60 ? `${str.slice(0, 60)}…` : str
}

/**
 * The record form's strip for its pending offline save: waiting for a
 * connection, conflicting with someone else's change (Review opens the merge
 * dialog), or refused (Retry / Discard).
 */
export function RecordOutboxBanner({
  entry,
  labelFor,
  onReview,
  onRetry,
  onDiscard
}: {
  entry: RecordOutboxEntry
  labelFor: (field: string) => string
  onReview: () => void
  onRetry: () => void
  onDiscard: () => void
}) {
  const fields = Object.keys(entry.payload)
  const names = fields.map((f) => labelFor(f) || f)
  const what = `${fields.length} field${fields.length === 1 ? '' : 's'} (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''})`
  const conflict = entry.status === 'conflict'
  const failed = entry.status === 'failed'
  return (
    <div
      role='status'
      data-record-outbox={entry.status}
      className='flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
    >
      {conflict || failed ? (
        <AlertTriangle className='h-4 w-4 shrink-0 text-amber-500' />
      ) : (
        <CloudOff className='h-4 w-4 shrink-0 text-amber-500' />
      )}
      <p className='min-w-0 flex-1'>
        <span className='font-semibold'>
          {conflict
            ? 'Someone else changed this record while your save was waiting.'
            : failed
              ? 'Your offline save was refused.'
              : 'Will save when you are back online.'}
        </span>{' '}
        {failed ? (entry.error ?? '') : `${what}, saved ${formatRelative(entry.created_at)}.`}
      </p>
      {conflict && (
        <button
          type='button'
          onClick={onReview}
          data-record-outbox-review
          className='inline-flex h-7 items-center gap-1 rounded-md bg-amber-600 px-2.5 text-[11.5px] font-semibold text-white hover:bg-amber-700'
        >
          <GitMerge className='h-3 w-3' /> Review
        </button>
      )}
      {failed && (
        <button
          type='button'
          onClick={onRetry}
          className='inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 px-2.5 text-[11.5px] font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15'
        >
          <RotateCcw className='h-3 w-3' /> Retry
        </button>
      )}
      <button
        type='button'
        onClick={onDiscard}
        data-record-outbox-discard
        title={fields.map((f, i) => `${names[i]}: ${fmt(entry.payload[f])}`).join('\n')}
        className='inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 px-2.5 text-[11.5px] font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15'
      >
        <Trash2 className='h-3 w-3' /> Discard
      </button>
    </div>
  )
}

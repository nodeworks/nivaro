import { History, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { StoredDraft } from '../../lib/draft-store'
import { formatRelative, titleCase } from '../../lib/utils'

/**
 * "Restore your unsaved changes from N min ago" — shown once at the top of
 * a record form when a persisted draft exists for this record and user
 * (tab crash, expired session, accidental navigation). Lists the diff
 * (field: was → will be) plus staged lines / links, and offers Restore or
 * Discard. Nothing is applied until the person chooses.
 */
export interface DraftRecoveryBannerProps {
  draft: StoredDraft
  /** Field key → label (from the form's field config). */
  labelFor: (field: string) => string
  /** The record's CURRENT loaded values (what Restore would overwrite). */
  current: Record<string, unknown>
  /** The loaded record changed since the draft was captured. */
  recordChanged: boolean
  onRestore: () => void
  onDiscard: () => void
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return 'empty'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const str = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return str.length > 60 ? `${str.slice(0, 60)}…` : str
}

export function DraftRecoveryBanner({
  draft,
  labelFor,
  current,
  recordChanged,
  onRestore,
  onDiscard
}: DraftRecoveryBannerProps) {
  const [open, setOpen] = useState(false)
  const fields = Object.entries(draft.fields ?? {})
  const rows = Object.values(draft.pending_rows ?? {}).reduce((n, r) => n + r.length, 0)
  const edits = Object.values(draft.pending_edits ?? {}).reduce(
    (n, e) => n + Object.keys(e).length,
    0
  )
  const deletes = Object.values(draft.pending_deletes ?? {}).reduce((n, x) => n + x.length, 0)
  const links = Object.values(draft.m2m_links ?? {}).reduce((n, x) => n + x.length, 0)
  const unlinks = Object.values(draft.m2m_unlinks ?? {}).reduce((n, x) => n + x.length, 0)
  const parts: string[] = []
  if (fields.length) parts.push(`${fields.length} field${fields.length === 1 ? '' : 's'}`)
  if (rows) parts.push(`${rows} new line${rows === 1 ? '' : 's'}`)
  if (edits) parts.push(`${edits} line edit${edits === 1 ? '' : 's'}`)
  if (deletes) parts.push(`${deletes} line removal${deletes === 1 ? '' : 's'}`)
  if (links) parts.push(`${links} link${links === 1 ? '' : 's'}`)
  if (unlinks) parts.push(`${unlinks} unlink${unlinks === 1 ? '' : 's'}`)

  return (
    <div
      className='mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
      data-nvr-draft-recovery
    >
      <div className='flex flex-wrap items-center gap-2'>
        <History className='h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400' />
        <span className='min-w-0 flex-1'>
          <span className='font-semibold'>
            Restore your unsaved changes from {formatRelative(draft.saved_at)}?
          </span>{' '}
          <span className='text-amber-800/80 dark:text-amber-200/80'>{parts.join(' · ')}</span>
          {recordChanged && (
            <span className='ml-1 rounded bg-amber-200/70 px-1 py-px text-[10.5px] font-semibold uppercase tracking-wide text-amber-900 dark:bg-amber-500/30 dark:text-amber-100'>
              record changed since — review before restoring
            </span>
          )}
        </span>
        <button
          type='button'
          onClick={() => setOpen((v) => !v)}
          className='text-[11.5px] underline decoration-dotted underline-offset-2'
        >
          {open ? 'Hide changes' : 'Show changes'}
        </button>
        <button
          type='button'
          onClick={onRestore}
          className='inline-flex h-7 items-center gap-1 rounded-md bg-amber-600 px-2.5 text-[11.5px] font-semibold text-white hover:bg-amber-700'
          data-nvr-draft-restore
        >
          <RotateCcw className='h-3 w-3' /> Restore
        </button>
        <button
          type='button'
          onClick={onDiscard}
          className='inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 px-2.5 text-[11.5px] font-medium hover:bg-amber-100 dark:border-amber-500/40 dark:hover:bg-amber-500/15'
          data-nvr-draft-discard
        >
          <Trash2 className='h-3 w-3' /> Discard
        </button>
      </div>
      {open && (
        <div className='mt-2 max-h-[240px] space-y-1 overflow-y-auto border-t border-amber-200/70 pt-2 dark:border-amber-500/30'>
          {fields.map(([k, v]) => (
            <div key={k} className='text-[11.5px]'>
              <span className='font-medium'>{labelFor(k) || titleCase(k.replace(/_/g, ' '))}</span>
              <p className='break-words text-amber-800/80 dark:text-amber-200/80'>
                <span className='line-through opacity-70'>{fmt(current[k])}</span>{' '}
                <span className='font-medium text-amber-900 dark:text-amber-100'>{fmt(v)}</span>
              </p>
            </div>
          ))}
          {Object.entries(draft.pending_rows ?? {})
            .filter(([, r]) => r.length > 0)
            .map(([k, r]) => (
              <p key={k} className='text-[11.5px]'>
                {r.length} new line{r.length === 1 ? '' : 's'} in{' '}
                {titleCase(k.split('.')[0].replace(/_/g, ' '))}
              </p>
            ))}
          {edits > 0 && (
            <p className='text-[11.5px]'>
              {edits} edited line{edits === 1 ? '' : 's'}
            </p>
          )}
          {deletes > 0 && (
            <p className='text-[11.5px]'>
              {deletes} line removal{deletes === 1 ? '' : 's'}
            </p>
          )}
          {links > 0 && (
            <p className='text-[11.5px]'>
              {links} relation link{links === 1 ? '' : 's'}
            </p>
          )}
          {unlinks > 0 && (
            <p className='text-[11.5px]'>
              {unlinks} relation removal{unlinks === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

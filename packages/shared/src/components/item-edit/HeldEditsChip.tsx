import { Check, Copy, PencilOff, Undo2, X } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { FieldStatus } from './layout-switch'

/**
 * Unsaved values the form could not carry into the form that now applies (rt8 #18): the new
 * form hides the field, makes it read-only or does not have it. They are out of the save and
 * kept here — copy one, put it back if the form lets the person edit that field again, or let
 * them go. Nothing is written by this chip.
 */

export interface HeldEdit {
  field: string
  label: string
  value: unknown
  status: FieldStatus
  /** A many-to-many field's staged picks / removals instead of a value. */
  links?: { stagingKey: string; add: unknown[]; remove: unknown[]; text: string }
}

/** A held value as text the person can read and copy (pure; exported for tests). */
export function heldText(value: unknown): string {
  if (value == null || value === '') return '(empty)'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** Why the value is held (pure; exported for tests). */
export function heldWhy(status: FieldStatus): string {
  if (status === 'readonly') return 'read-only on this form'
  if (status === 'hidden') return 'hidden on this form'
  return 'not on this form'
}

export function HeldEditsChip({
  edits,
  canPutBack,
  onPutBack,
  onDiscard
}: {
  edits: HeldEdit[]
  canPutBack: (field: string) => boolean
  onPutBack: (field: string) => void
  onDiscard: (field: string | null) => void
}) {
  const [copied, setCopied] = useState<string | null>(null)
  if (edits.length === 0) return null
  const n = edits.length
  const copy = (e: HeldEdit) => {
    void navigator.clipboard
      ?.writeText(heldText(e.value))
      .then(() => {
        setCopied(e.field)
        setTimeout(() => setCopied((c) => (c === e.field ? null : c)), 1500)
      })
      .catch(() => {})
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-held-edits={n}
          className='inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-[12px] font-medium text-amber-800 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/15'
        >
          <PencilOff aria-hidden className='h-3 w-3' />
          {n} unsaved change{n === 1 ? '' : 's'} not on this form
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[min(360px,calc(100vw-32px))] p-0'>
        <div className='border-b border-slate-100 px-3 py-2 dark:border-border'>
          <p className='text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
            Kept aside, not saved
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
            The record moved to a form that can’t take these. Copy what you need, or put a change
            back once its field can be edited again.
          </p>
        </div>
        <ul className='max-h-[260px] divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
          {edits.map((e) => {
            const back = canPutBack(e.field)
            return (
              <li key={e.field} className='px-3 py-2' data-held-edit={e.field}>
                <div className='flex items-baseline gap-2'>
                  <span className='min-w-0 flex-1 truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                    {e.label}
                  </span>
                  <span className='shrink-0 text-[11px] text-slate-400 dark:text-slate-500'>
                    {back ? 'editable again' : heldWhy(e.status)}
                  </span>
                </div>
                <p className='mt-0.5 line-clamp-3 break-words text-[12px] text-slate-600 dark:text-slate-300'>
                  {e.links ? e.links.text : heldText(e.value)}
                </p>
                <div className='mt-1 flex items-center gap-1'>
                  {!e.links && (
                    <button
                      type='button'
                      onClick={() => copy(e)}
                      className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-slate-600 hover:bg-muted dark:text-slate-300'
                    >
                      {copied === e.field ? (
                        <Check aria-hidden className='h-3 w-3 text-emerald-600' />
                      ) : (
                        <Copy aria-hidden className='h-3 w-3' />
                      )}
                      {copied === e.field ? 'Copied' : 'Copy'}
                    </button>
                  )}
                  {back && (
                    <button
                      type='button'
                      onClick={() => onPutBack(e.field)}
                      className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-nvr-cyan hover:bg-muted'
                    >
                      <Undo2 aria-hidden className='h-3 w-3' /> Put back
                    </button>
                  )}
                  <button
                    type='button'
                    onClick={() => onDiscard(e.field)}
                    className={cn(
                      'ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-slate-500 hover:bg-muted dark:text-slate-400'
                    )}
                  >
                    <X aria-hidden className='h-3 w-3' /> Let go
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

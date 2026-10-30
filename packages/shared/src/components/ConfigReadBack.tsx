import { AlertTriangle, Info, Loader2 } from 'lucide-react'
import { createContext, useContext } from 'react'
import type { FieldSource } from '../lib/config-sentences'
import { cn } from '../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/**
 * The quiet read-back line under a builder (#11): what the configuration
 * above it says, in sentences from lib/config-sentences.ts. Renders nothing
 * when there is no sentence (an unknown shape gets none, never a wrong one).
 */
export function ConfigReadBack({
  sentences,
  className,
  kind
}: {
  sentences: string | string[] | null | undefined
  className?: string
  /** data-config-readback value, for tests and probes. */
  kind?: string
}) {
  const list = (Array.isArray(sentences) ? sentences : sentences ? [sentences] : []).filter(Boolean)
  if (!list.length) return null
  return (
    <p
      data-config-readback={kind ?? ''}
      className={cn('text-[12px] leading-snug text-slate-500 dark:text-slate-400', className)}
    >
      {list.join(' ')}
    </p>
  )
}

/**
 * Change impact before saving (#13): the sentences from
 * describeFieldChangeImpact and a Save anyway / Cancel pair, inline (no modal).
 */
export function ChangeImpactStrip({
  sentences,
  loading,
  saving,
  onConfirm,
  onCancel,
  confirmLabel = 'Save anyway',
  className
}: {
  sentences: string[]
  loading?: boolean
  saving?: boolean
  onConfirm: () => void
  onCancel: () => void
  confirmLabel?: string
  className?: string
}) {
  return (
    <div
      role='alert'
      data-change-impact=''
      className={cn(
        'space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[12px] text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100',
        className
      )}
    >
      {loading ? (
        <p className='flex items-center gap-1.5'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
          Checking what this change touches…
        </p>
      ) : (
        <div className='flex gap-2'>
          <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <div className='space-y-0.5'>
            {sentences.map((s) => (
              <p key={s}>{s}</p>
            ))}
          </div>
        </div>
      )}
      <div className='flex gap-2'>
        <button
          type='button'
          data-change-impact-confirm=''
          disabled={loading || saving}
          onClick={onConfirm}
          className='rounded-md bg-nvr-cyan px-2.5 py-1 text-[12px] font-medium text-white hover:bg-nvr-cyan/90 disabled:opacity-40'
        >
          {saving ? 'Saving…' : confirmLabel}
        </button>
        <button
          type='button'
          data-change-impact-cancel=''
          onClick={onCancel}
          className='rounded-md px-2.5 py-1 text-[12px] text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900/40'
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/** The panel body for "where does this come from?" (#10). */
export function FieldSourceBody({ source }: { source: FieldSource }) {
  return (
    <div data-field-source-body='' className='space-y-1.5 text-[12px] leading-snug'>
      <p className='font-medium text-slate-900 dark:text-foreground'>{source.sentence}</p>
      {source.notes.map((n) => (
        <p key={n} className='text-slate-500 dark:text-slate-400'>
          {n}
        </p>
      ))}
      {source.inputs.length > 0 && (
        <p className='text-slate-500 dark:text-slate-400'>
          Reads:{' '}
          <span className='text-slate-700 dark:text-slate-300'>{source.inputs.join(', ')}</span>
        </p>
      )}
    </div>
  )
}

/** A small ⓘ beside a field label that opens the field's source in words. */
export function FieldSourceInfo({ source, label }: { source: FieldSource; label: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-field-source=''
          aria-label={`Where ${label} comes from`}
          data-tip='Where this value comes from'
          className='inline-flex h-4 w-4 items-center justify-center rounded text-slate-400 hover:bg-muted hover:text-slate-600 dark:hover:text-slate-200'
        >
          <Info className='h-3.5 w-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[300px] p-3'>
        <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
          Where {label} comes from
        </p>
        <FieldSourceBody source={source} />
      </PopoverContent>
    </Popover>
  )
}

/** field → its source, provided by the record form; FieldRow reads it. */
export const FieldSourcesContext = createContext<Record<string, FieldSource> | null>(null)
export const useFieldSource = (field: string): FieldSource | null =>
  useContext(FieldSourcesContext)?.[field] ?? null

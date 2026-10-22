import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

/**
 * Form pieces the chaos Settings (#2862) and Monkey (#2829) tabs share: a titled section, a
 * label/help + control row, a number box where empty means "no limit", the approved-faults
 * checklist and the save bar that appears while the form differs from what is stored.
 */

export function Section({
  title,
  help,
  aside,
  children
}: {
  title: string
  help?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-border/60'>
        <div className='min-w-0'>
          <h3 className='text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
            {title}
          </h3>
          {help && (
            <p className='mt-0.5 max-w-[75ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              {help}
            </p>
          )}
        </div>
        {aside}
      </header>
      <div className='divide-y divide-slate-100 dark:divide-border/60'>{children}</div>
    </section>
  )
}

export function Row({
  label,
  help,
  htmlFor,
  children
}: {
  label: string
  help?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className='flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-6'>
      <div className='min-w-0 sm:w-[260px] sm:shrink-0'>
        <label
          htmlFor={htmlFor}
          className='block text-[12.5px] font-medium text-slate-800 dark:text-foreground'
        >
          {label}
        </label>
        {help && (
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>{help}</p>
        )}
      </div>
      <div className='min-w-0 flex-1'>{children}</div>
    </div>
  )
}

export const inputCls =
  'h-8 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] tabular-nums text-slate-900 placeholder:text-slate-500 focus-visible:border-nvr-cyan focus-visible:outline-none disabled:opacity-60 dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'

/** A number box: empty = null ("No limit" or the given placeholder). */
export function NumberBox({
  id,
  value,
  onChange,
  unit,
  min,
  max,
  placeholder = 'No limit',
  disabled
}: {
  id?: string
  value: number | null
  onChange: (v: number | null) => void
  unit?: string
  min?: number
  max?: number
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div className='flex items-center gap-2'>
      <input
        id={id}
        type='number'
        inputMode='numeric'
        min={min}
        max={max}
        value={value ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value.trim()
          const n = Number(raw)
          onChange(raw === '' || !Number.isFinite(n) ? null : n)
        }}
        className={cn(inputCls, 'w-32')}
      />
      {unit && (
        <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>{unit}</span>
      )}
    </div>
  )
}

const DANGER_LABEL: Record<string, string> = {
  low: 'Low blast',
  medium: 'Medium blast',
  high: 'High blast'
}

export function FaultChecklist({
  candidates,
  value,
  onChange,
  disabled
}: {
  candidates: Array<{ key: string; label: string; danger: string }>
  value: string[]
  onChange: (keys: string[]) => void
  disabled?: boolean
}) {
  const known = new Set(candidates.map((c) => c.key))
  const extra = value.filter((k) => !known.has(k))
  return (
    <ul className='grid gap-1 sm:grid-cols-2'>
      {[...candidates, ...extra.map((k) => ({ key: k, label: k, danger: '' }))].map((c) => {
        const on = value.includes(c.key)
        const id = `fault-${c.key}`
        return (
          <li key={c.key}>
            <label
              htmlFor={id}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-muted',
                disabled && 'cursor-default hover:bg-transparent dark:hover:bg-transparent'
              )}
            >
              <Checkbox
                id={id}
                checked={on}
                disabled={disabled}
                onCheckedChange={(v) =>
                  onChange(v ? [...value, c.key] : value.filter((k) => k !== c.key))
                }
              />
              <span className='min-w-0 truncate text-[12.5px] text-slate-800 dark:text-foreground'>
                {c.label}
              </span>
              {c.danger ? (
                <span
                  className={cn(
                    'shrink-0 text-[11px]',
                    c.danger === 'high'
                      ? 'text-red-700 dark:text-red-300'
                      : c.danger === 'medium'
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-slate-500 dark:text-muted-foreground'
                  )}
                >
                  {DANGER_LABEL[c.danger] ?? c.danger}
                </span>
              ) : (
                <span className='shrink-0 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                  preset
                </span>
              )}
            </label>
          </li>
        )
      })}
    </ul>
  )
}

/** Sticky at the bottom of the scrolling pane while there is something to save. */
export function SaveBar({
  dirty,
  saving,
  error,
  onSave,
  onDiscard
}: {
  dirty: boolean
  saving: boolean
  error: string | null
  onSave: () => void
  onDiscard: () => void
}) {
  if (!dirty && !error) return null
  return (
    <div className='sticky bottom-0 z-10 -mx-4 mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200 bg-white px-4 py-2.5 sm:-mx-6 sm:px-6 dark:border-border dark:bg-card'>
      <p
        role={error ? 'alert' : 'status'}
        className={cn(
          'min-w-0 flex-1 text-[12.5px]',
          error ? 'text-red-700 dark:text-red-300' : 'text-slate-600 dark:text-muted-foreground'
        )}
      >
        {error ?? 'Unsaved changes'}
      </p>
      <button
        type='button'
        onClick={onDiscard}
        disabled={saving}
        className='h-8 rounded-md px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-muted-foreground dark:hover:bg-muted'
      >
        Discard
      </button>
      <button
        type='button'
        onClick={onSave}
        disabled={saving || !dirty}
        className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-medium text-nvr-navy hover:bg-[#00b8e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:opacity-50 dark:focus-visible:ring-offset-background'
      >
        {saving && <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden />}
        Save changes
      </button>
    </div>
  )
}

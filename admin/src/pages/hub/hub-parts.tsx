import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { HUB_MASK, type HubStatusState, STATUS_COPY, STATUS_DOT, STATUS_TONE } from './hub-api'

/** Pieces the Apps hub screens share: status chips, section cards, labelled fields. */

export function StatusChip({
  state,
  label,
  tip,
  compact
}: {
  state: HubStatusState | 'checking'
  /** Overrides the status copy (e.g. an environment key in the list's chips). */
  label?: string
  tip?: string
  compact?: boolean
}) {
  const text = label ?? (state === 'checking' ? 'Checking…' : STATUS_COPY[state])
  return (
    <span
      data-tip={tip}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border font-medium',
        compact ? 'px-1.5 py-px text-[10px]' : 'px-2 py-0.5 text-[11px]',
        STATUS_TONE[state]
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[state])} />
      <span className='truncate'>{text}</span>
    </span>
  )
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
    >
      <header className='flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-4 py-3 dark:border-border'>
        <div className='min-w-0 flex-1'>
          <h3 className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            {title}
          </h3>
          {description && (
            <p className='m-0 mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              {description}
            </p>
          )}
        </div>
        {actions && <div className='flex flex-wrap items-center gap-2'>{actions}</div>}
      </header>
      {children}
    </section>
  )
}

export function Field({
  id,
  label,
  hint,
  error,
  children
}: {
  id: string
  label: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
}) {
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={id} className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
        {label}
      </Label>
      {children}
      {error ? (
        <p className='m-0 text-[11px] text-red-600 dark:text-red-400'>{error}</p>
      ) : hint ? (
        <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
      ) : null}
    </div>
  )
}

/**
 * A secret the API shows only as '••••••'. Left as is, the stored value stays; cleared, it is
 * removed; typed over, it is replaced. Never filled from the browser's saved passwords.
 */
export function SecretInput({
  id,
  value,
  onChange,
  stored,
  placeholder
}: {
  id: string
  value: string
  onChange: (v: string) => void
  /** Whether a value is stored now (the field starts at the mask). */
  stored: boolean
  placeholder?: string
}) {
  return (
    <Input
      id={id}
      type='password'
      autoComplete='new-password'
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => {
        if (stored && value === HUB_MASK) e.currentTarget.select()
      }}
      placeholder={placeholder}
      className='h-8 font-mono text-[13px]'
    />
  )
}

export const smallButton =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'

export const ghostButton = cn(
  smallButton,
  'text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-muted'
)

export const dangerGhost = cn(
  smallButton,
  'text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40'
)

export const dangerArmed =
  'bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:text-white dark:hover:bg-red-700'

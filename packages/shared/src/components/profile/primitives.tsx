import type { ReactNode } from 'react'
import { Children, useEffect, useState } from 'react'
import { useNavigation } from '../../context'
import { cn } from '../../lib/utils'
import { UserAvatar } from '../UserAvatar'

/**
 * The people page's vocabulary — one card frame, one input, one switch, one
 * two-step destructive button, one label/value cell, one person chip. Both
 * the own-profile cards (ProfileView) and someone-else's page (PersonProfile)
 * draw from here so the two never drift.
 */

export function SectionCard({
  icon,
  title,
  hint,
  children,
  actions,
  tone = 'default',
  className,
  testId
}: {
  icon: ReactNode
  title: string
  hint?: string
  children: ReactNode
  actions?: ReactNode
  /** `danger` frames the card amber — offboarding, merge, force reload. */
  tone?: 'default' | 'danger'
  className?: string
  testId?: string
}) {
  return (
    <section
      data-profile-card={testId}
      className={cn(
        'rounded-lg border bg-white dark:bg-card',
        tone === 'danger'
          ? 'border-amber-200 dark:border-amber-500/30'
          : 'border-slate-200 dark:border-border',
        className
      )}
    >
      <header className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <span
          className={cn(
            'shrink-0',
            tone === 'danger' ? 'text-amber-500' : 'text-nvr-navy dark:text-nvr-cyan'
          )}
        >
          {icon}
        </span>
        <h3 className='shrink-0 whitespace-nowrap text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          {title}
        </h3>
        {hint && (
          <p
            className='hidden min-w-0 truncate text-[11px] text-slate-500 dark:text-slate-400 sm:block'
            title={hint}
          >
            {hint}
          </p>
        )}
        <span className='ml-auto shrink-0'>{actions}</span>
      </header>
      <div className='p-4'>{children}</div>
    </section>
  )
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  hint,
  inputClassName
}: {
  label: string
  value: string
  onChange?: (v: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
  hint?: string
  inputClassName?: string
}) {
  return (
    <label className='block'>
      <span className='mb-1 flex items-baseline justify-between text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
        {label}
        {hint && (
          <span className='normal-case tracking-normal text-slate-400 dark:text-slate-500'>
            {hint}
          </span>
        )}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-700 outline-none transition-colors focus:border-nvr-cyan focus-visible:ring-2 focus-visible:ring-nvr-cyan/25 dark:border-border dark:bg-background dark:text-slate-200',
          disabled &&
            'cursor-not-allowed bg-slate-50 text-slate-400 dark:bg-muted/40 dark:text-slate-500',
          inputClassName
        )}
      />
    </label>
  )
}

/** One switch vocabulary for the whole page. */
export function Toggle({
  on,
  onChange,
  label,
  tone = 'cyan'
}: {
  on: boolean
  onChange: () => void
  label: string
  tone?: 'cyan' | 'amber'
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={cn(
        'relative h-[18px] w-8 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40',
        on ? (tone === 'amber' ? 'bg-amber-400' : 'bg-nvr-cyan') : 'bg-slate-200 dark:bg-muted'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-[left] duration-150',
          on ? 'left-[15px]' : 'left-0.5'
        )}
      />
    </button>
  )
}

/** Two-step destructive button: first click arms, second confirms; disarms after 3s. */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Confirm?',
  className,
  armedClassName,
  title,
  disabled
}: {
  onConfirm: () => void
  children: ReactNode
  confirmLabel?: ReactNode
  className?: string
  armedClassName?: string
  title?: string
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(t)
  }, [armed])
  return (
    <button
      type='button'
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
      className={cn(className, armed && armedClassName)}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}

export function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <p className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>{label}</p>
      <div className='mt-0.5 text-[12.5px] text-slate-700 dark:text-slate-200'>{children}</div>
    </div>
  )
}

/** The 1px-divider grid Meta cells sit in. */
export function MetaGrid({ children, cols = 3 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  // Pad the last row with blank white cells (to a multiple of both column
  // counts) so an odd number of facts never leaves a grey hole at the end.
  const n = Children.toArray(children).filter(Boolean).length
  const period = cols === 3 ? 6 : cols
  const fill = (period - (n % period)) % period
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border',
        cols === 3 && 'sm:grid-cols-3',
        cols === 4 && 'sm:grid-cols-4'
      )}
    >
      {children}
      {Array.from({ length: fill }, (_, i) => (
        <div key={`fill-${i}`} className='bg-white dark:bg-card' aria-hidden />
      ))}
    </div>
  )
}

export const PILL_TONES = {
  neutral: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300',
  brand: 'bg-[#00ceff1a] text-nvr-navy dark:text-nvr-cyan',
  amber: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  red: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400'
} as const

export function Pill({
  tone = 'neutral',
  children,
  title,
  testId
}: {
  tone?: keyof typeof PILL_TONES
  children: ReactNode
  title?: string
  testId?: string
}) {
  return (
    <span
      data-profile-pill={testId}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-px text-[10.5px] font-semibold',
        PILL_TONES[tone]
      )}
    >
      {children}
    </span>
  )
}

export function personInitials(p: {
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  email?: string | null
}): string {
  const fromNames = `${p.first_name?.[0] ?? ''}${p.last_name?.[0] ?? ''}`.trim()
  if (fromNames) return fromNames.toUpperCase()
  const words = (p.name ?? '').split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
  return (words[0]?.[0] ?? p.email?.[0] ?? '?').toUpperCase()
}

/** Where a person's page lives in THIS host — null when the host has none. */
export function usePersonUrl(): (id: string) => string | null {
  const nav = useNavigation()
  return (id: string) => (nav.userUrl ? nav.userUrl(id) : `/users/${id}`)
}

/** A person, as a small avatar + name that opens their page when the host has one. */
export function PersonChip({
  person,
  meta,
  size = 'sm'
}: {
  person: { id: string; name: string; email?: string | null; is_out_of_office?: boolean }
  meta?: ReactNode
  size?: 'sm' | 'md'
}) {
  const nav = useNavigation()
  const urlOf = usePersonUrl()
  const href = urlOf(person.id)
  const dim = size === 'md' ? 'h-7 w-7 text-[11px]' : 'h-5 w-5 text-[9px]'
  const body = (
    <>
      <UserAvatar
        userId={person.id}
        alt={person.name}
        className={cn('shrink-0 rounded-full', dim)}
        fallback={
          <span
            className={cn(
              'flex shrink-0 select-none items-center justify-center rounded-full bg-[#c7f0fb] font-semibold text-[#04516b] dark:bg-nvr-cyan/15 dark:text-nvr-cyan',
              dim
            )}
          >
            {personInitials(person)}
          </span>
        }
      />
      <span className='min-w-0'>
        <span className='block truncate text-[12.5px] font-medium text-slate-700 group-hover/person:text-nvr-navy dark:text-slate-200 dark:group-hover/person:text-nvr-cyan'>
          {person.name}
          {person.is_out_of_office && (
            <span className='ml-1.5 text-[10.5px] font-semibold text-amber-600 dark:text-amber-400'>
              out
            </span>
          )}
        </span>
        {meta && <span className='block truncate text-[11px] text-slate-400'>{meta}</span>}
      </span>
    </>
  )
  const cls = 'group/person inline-flex max-w-full items-center gap-2 rounded-md text-left'
  if (!href) return <span className={cls}>{body}</span>
  return (
    <a
      href={href}
      data-person-link={person.id}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        nav.navigate(href)
      }}
      className={cn(cls, 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      {body}
    </a>
  )
}

/** The quiet "nothing here" line a card shows instead of disappearing. */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className='text-[12px] text-slate-500 dark:text-slate-400'>{children}</p>
}

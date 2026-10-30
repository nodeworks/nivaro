import { userErrorMessage } from '@nivaro/shared'
import { ArrowRight, RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'

/**
 * Shared pieces for the Overview sections: a plain titled section, the error line with Retry,
 * and the empty line that always names a next step. Calm on purpose — the accent colour is kept
 * for the one action a line offers.
 */

export interface SectionProps {
  /** Hide the section's own heading (the host renders one). */
  hideTitle?: boolean
}

export function Section({
  id,
  title,
  hideTitle,
  more,
  children,
  className
}: {
  id: string
  title: string
  hideTitle?: boolean
  more?: { label: string; to: string }
  children: ReactNode
  className?: string
}) {
  const headingId = `overview-${id}-title`
  return (
    <section
      aria-labelledby={hideTitle ? undefined : headingId}
      aria-label={hideTitle ? title : undefined}
      data-overview-section={id}
      className={cn('min-w-0', className)}
    >
      {!hideTitle && (
        <div className='mb-2 flex items-baseline justify-between gap-3'>
          <h2
            id={headingId}
            className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'
          >
            {title}
          </h2>
          {more && (
            <Link
              to={more.to}
              className='shrink-0 text-[12px] text-slate-500 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-100'
            >
              {more.label}
            </Link>
          )}
        </div>
      )}
      {children}
    </section>
  )
}

/** A bordered surface for list sections (white / card in dark). */
export function Surface({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
    >
      {children}
    </div>
  )
}

export function SectionError({
  error,
  what,
  onRetry
}: {
  error: unknown
  what: string
  onRetry: () => void
}) {
  return (
    <div
      role='alert'
      className='flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-[12.5px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
    >
      <span className='min-w-0 flex-1'>
        Couldn't load {what}. {userErrorMessage(error, '')}
      </span>
      <button
        type='button'
        onClick={onRetry}
        className='inline-flex items-center gap-1 text-[12px] font-medium text-slate-700 hover:underline dark:text-slate-200'
      >
        <RotateCw className='h-3.5 w-3.5' aria-hidden />
        Try again
      </button>
    </div>
  )
}

export function SectionEmpty({
  children,
  next
}: {
  children: ReactNode
  next?: { label: string; to: string }
}) {
  return (
    <p className='rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[12.5px] text-slate-500 dark:border-border dark:text-slate-400'>
      {children}
      {next && (
        <>
          {' '}
          <Link
            to={next.to}
            className='font-medium text-slate-700 hover:underline dark:text-slate-200'
          >
            {next.label}
          </Link>
        </>
      )}
    </p>
  )
}

/** The one action a line offers: "Review →". */
export function ActionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className='inline-flex shrink-0 items-center gap-1 rounded text-[12px] font-medium text-nvr-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-nvr-cyan'
    >
      {children}
      <ArrowRight className='h-3 w-3' aria-hidden />
    </Link>
  )
}

/** "2h ago" from an ISO time; null-safe. */
export function ago(iso: string | null | undefined): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  const days = Math.floor(hrs / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** The viewer's own calendar day + offset, for counts like "due today". */
export function localDay(now = new Date()): { today: string; tz: number } {
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    tz: now.getTimezoneOffset()
  }
}

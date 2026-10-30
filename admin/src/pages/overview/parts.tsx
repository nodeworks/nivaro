import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Small shared pieces of the Overview: a section frame (title + optional action, one surface),
 * skeleton bones on the --nvr-skeleton token, and an empty state that always offers a next step.
 */

export function Bone({ className }: { className?: string }) {
  return <Skeleton className={cn('bg-[hsl(var(--nvr-skeleton))]', className)} />
}

export function Section({
  id,
  title,
  action,
  children,
  className,
  bodyClassName,
  plain
}: {
  id: string
  title: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  /** No surface: the content draws its own (the stat line, quick actions). */
  plain?: boolean
}) {
  const headingId = `overview-${id}-title`
  return (
    <section aria-labelledby={headingId} className={cn('min-w-0', className)} data-overview={id}>
      <div className='mb-2 flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1.5'>
        <h2 id={headingId} className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          {title}
        </h2>
        {action}
      </div>
      {plain ? (
        children
      ) : (
        <div
          className={cn(
            'overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
            bodyClassName
          )}
        >
          {children}
        </div>
      )}
    </section>
  )
}

export function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className='rounded text-[12px] font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-300 dark:hover:text-white'
    >
      {children}
    </Link>
  )
}

export function EmptyNote({
  children,
  action,
  className
}: {
  children: ReactNode
  action?: { label: string; to?: string; onClick?: () => void }
  className?: string
}) {
  return (
    <div className={cn('px-4 py-5 text-[12.5px] text-slate-600 dark:text-slate-300', className)}>
      <p>{children}</p>
      {action &&
        (action.to ? (
          <Link
            to={action.to}
            className='mt-2 inline-flex rounded text-[12.5px] font-medium text-slate-900 underline underline-offset-2 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-white'
          >
            {action.label}
          </Link>
        ) : (
          <button
            type='button'
            onClick={action.onClick}
            className='mt-2 inline-flex rounded text-[12.5px] font-medium text-slate-900 underline underline-offset-2 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-white'
          >
            {action.label}
          </button>
        ))}
    </div>
  )
}

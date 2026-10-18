import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A row of label / value figures in the inspector's own look. */
export function Figs({
  items,
  cols = 3
}: {
  items: Array<[string, ReactNode, boolean?]>
  cols?: 2 | 3
}) {
  return (
    <dl className={cn('grid gap-x-3 gap-y-2', cols === 2 ? 'grid-cols-2' : 'grid-cols-3')}>
      {items.map(([k, v, bad]) => (
        <div key={k} className='min-w-0'>
          <dt className='truncate text-[11.5px] text-[var(--tm-muted)]'>{k}</dt>
          <dd
            className={cn(
              'truncate text-[13.5px] font-semibold tabular-nums',
              bad && 'text-[var(--tm-error-ink)]'
            )}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** One sentence under a panel's figures, tinted by level. */
export function LevelLine({
  level,
  children
}: {
  level: 'ok' | 'warn' | 'error'
  children: ReactNode
}) {
  return (
    <p
      className={cn(
        'text-[12px]',
        level === 'error'
          ? 'font-medium text-[var(--tm-error-ink)]'
          : level === 'warn'
            ? 'font-medium text-[var(--tm-update)]'
            : 'text-[var(--tm-fg-2)]'
      )}
    >
      {children}
    </p>
  )
}

export const HINT = 'text-[11.5px] text-[var(--tm-muted)]'

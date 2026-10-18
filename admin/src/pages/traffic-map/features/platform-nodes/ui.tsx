import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export { Figs } from '../shared'

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

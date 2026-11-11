import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-px text-[10.5px] font-medium',
        className
      )}
    >
      {children}
    </span>
  )
}

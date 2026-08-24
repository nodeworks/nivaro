import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Designed empty state (#322): what this surface is, why it's empty, and the
 * one right action. Replaces bare "No results" strings on the major surfaces.
 */
export function EmptyState({
  icon: Icon,
  title,
  detail,
  action
}: {
  icon?: LucideIcon
  title: string
  detail?: string
  action?: ReactNode
}) {
  return (
    <div className='nvr-rise-in flex flex-col items-center justify-center gap-2 px-6 py-12 text-center'>
      {Icon && (
        <div className='flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-muted'>
          <Icon className='h-5 w-5 text-slate-400 dark:text-muted-foreground' />
        </div>
      )}
      <p className='text-[13.5px] font-medium text-slate-700 dark:text-foreground'>{title}</p>
      {detail && (
        <p className='max-w-[420px] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          {detail}
        </p>
      )}
      {action && <div className='mt-1'>{action}</div>}
    </div>
  )
}

import type { ReactNode } from 'react'

/** One titled block of the issue detail panel (white card on the slate canvas). */
export function Section({
  title,
  action,
  children,
  ...rest
}: {
  title: ReactNode
  action?: ReactNode
  children: ReactNode
} & Record<`data-${string}`, string | undefined>) {
  return (
    <section
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      {...rest}
    >
      <header className='flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 dark:border-border/60'>
        <h3 className='flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
          {title}
        </h3>
        {action}
      </header>
      <div className='px-4 py-3'>{children}</div>
    </section>
  )
}

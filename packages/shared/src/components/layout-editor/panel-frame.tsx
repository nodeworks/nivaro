import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { effectText } from './panel-style'

// The right-hand panel's frame, shared by the inspector and Form settings: a
// fixed header (what is selected, then tabs or search) over a scrolling body.

export function PanelHeader({
  eyebrow,
  title,
  sub,
  children
}: {
  /** What kind of thing and where: "Field · Basic Information". */
  eyebrow?: ReactNode
  title: ReactNode
  /** Secondary line: what it is in words, then its key. */
  sub?: ReactNode
  /** Tabs. */
  children?: ReactNode
}) {
  return (
    <div
      data-panel-header=''
      className='shrink-0 border-b border-slate-200 px-4 pb-3 pt-3.5 dark:border-border'
    >
      {eyebrow && (
        <p data-panel-eyebrow='' className={cn(effectText, 'truncate')}>
          {eyebrow}
        </p>
      )}
      <h2 className='truncate text-[14px] font-semibold leading-6 text-slate-900 dark:text-foreground'>
        {title}
      </h2>
      {sub && <div className={cn(effectText, 'truncate')}>{sub}</div>}
      {children && <div className='mt-3'>{children}</div>}
    </div>
  )
}

export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-panel-body=''
      className={cn('min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-8 pt-4', className)}
    >
      {children}
    </div>
  )
}

export function PanelTabs<T extends string>({
  tabs,
  active,
  onChange
}: {
  tabs: Array<{ key: T; label: string }>
  active: T
  onChange: (key: T) => void
}) {
  return (
    <div role='tablist' className='-mx-1 flex flex-wrap gap-0.5'>
      {tabs.map((t) => (
        <button
          key={t.key}
          type='button'
          role='tab'
          aria-selected={active === t.key}
          data-inspector-tab={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'h-7 rounded-md px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
            active === t.key
              ? 'bg-slate-100 font-medium text-slate-900 dark:bg-muted dark:text-foreground'
              : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900 dark:text-muted-foreground dark:hover:bg-muted/60 dark:hover:text-foreground'
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

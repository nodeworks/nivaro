import { type KeyboardEvent, type ReactNode, useRef } from 'react'
import { cn } from '../../lib/utils'
import { useOverflowTip } from '../TipLayer'
import { effectText } from './panel-style'

// The right-hand panel's frame, shared by the inspector and Form settings: a
// fixed header (what is selected, then tabs or search) over a scrolling body.

const textOf = (n: ReactNode) => (typeof n === 'string' || typeof n === 'number' ? String(n) : null)

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
  // Long names are cut to one line; the whole name shows on hover.
  const eyebrowRef = useOverflowTip<HTMLParagraphElement>(textOf(eyebrow))
  const titleRef = useOverflowTip<HTMLHeadingElement>(textOf(title))
  return (
    <div
      data-panel-header=''
      className='shrink-0 border-b border-slate-200 px-4 pb-3 pt-3.5 dark:border-border'
    >
      {eyebrow && (
        <p ref={eyebrowRef} data-panel-eyebrow='' className={cn(effectText, 'truncate')}>
          {eyebrow}
        </p>
      )}
      <h2
        ref={titleRef}
        className='truncate text-[14px] font-semibold leading-6 text-slate-900 dark:text-foreground'
      >
        {title}
      </h2>
      {sub && <div className={cn(effectText, 'truncate')}>{sub}</div>}
      {children && <div className='mt-3'>{children}</div>}
    </div>
  )
}

export function PanelBody({
  children,
  className,
  tabpanel
}: {
  children: ReactNode
  className?: string
  /** The body of a tabbed panel: its id and the tab that labels it. */
  tabpanel?: { id: string; labelledBy: string }
}) {
  return (
    <div
      data-panel-body=''
      {...(tabpanel
        ? { role: 'tabpanel', id: tabpanel.id, 'aria-labelledby': tabpanel.labelledBy }
        : {})}
      className={cn('min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-8 pt-4', className)}
    >
      {children}
    </div>
  )
}

export const tabId = (base: string, key: string) => `${base}-tab-${key}`
export const tabPanelId = (base: string) => `${base}-panel`

/**
 * Tabs with the keyboard of a tablist: only the selected tab is in the Tab
 * order; Left / Right move between tabs (and select), Home / End jump.
 */
export function PanelTabs<T extends string>({
  tabs,
  active,
  onChange,
  idBase,
  label
}: {
  tabs: Array<{ key: T; label: string }>
  active: T
  onChange: (key: T) => void
  /** Prefix for the tab and panel ids (useId). */
  idBase: string
  label: string
}) {
  const list = useRef<HTMLDivElement | null>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === active)
    const to =
      e.key === 'ArrowRight'
        ? (i + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : -1
    if (to < 0) return
    e.preventDefault()
    onChange(tabs[to].key)
    list.current?.ownerDocument.getElementById(tabId(idBase, tabs[to].key))?.focus()
  }
  return (
    <div
      ref={list}
      role='tablist'
      aria-label={label}
      onKeyDown={onKeyDown}
      className='-mx-1 flex flex-wrap gap-0.5'
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          id={tabId(idBase, t.key)}
          type='button'
          role='tab'
          aria-selected={active === t.key}
          aria-controls={tabPanelId(idBase)}
          tabIndex={active === t.key ? 0 : -1}
          data-inspector-tab={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'h-7 rounded-md px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
            active === t.key
              ? 'bg-slate-100 font-medium text-slate-900 dark:bg-muted dark:text-foreground'
              : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:hover:bg-muted/60 dark:hover:text-foreground'
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

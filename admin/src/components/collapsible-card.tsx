import { useOverflowTip } from '@nivaro/shared'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useId, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Collapsible full-width cards (Environments: Runbooks, Stack drift). Several cards stack above
 * the page's master-detail area, so a card with nothing to say folds to one summary line and
 * gives the height back to the list below.
 *
 * Open by default exactly when the card needs attention (`attention`). A viewer's own toggle is
 * remembered per browser, but only for the state it was made in: collapsing a card while it
 * needs attention keeps it collapsed until the state changes, and a calm card that later needs
 * attention opens again on its own.
 */

const PREFIX = 'nivaro-card-open:'

interface Stored {
  open: boolean
  attention: boolean
}

function readStored(key: string): Stored | null {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<Stored>
    return typeof v.open === 'boolean' && typeof v.attention === 'boolean'
      ? { open: v.open, attention: v.attention }
      : null
  } catch {
    return null
  }
}

/** Pure: whether the card shows open — the remembered choice for this state, else `attention`. */
export function resolveCardOpen(stored: Stored | null, attention: boolean): boolean {
  return stored && stored.attention === attention ? stored.open : attention
}

export function useCardOpen(key: string, attention: boolean): [boolean, (open: boolean) => void] {
  const [stored, setStored] = useState<Stored | null>(() => readStored(key))
  const setOpen = useCallback(
    (open: boolean) => {
      const next = { open, attention }
      setStored(next)
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(next))
      } catch {
        /* private mode / blocked storage: the choice lasts until reload */
      }
    },
    [key, attention]
  )
  return [resolveCardOpen(stored, attention), setOpen]
}

export type SummaryTone = 'muted' | 'ok' | 'warn' | 'bad'

const TONE: Record<SummaryTone, string> = {
  muted: 'text-slate-500 dark:text-muted-foreground',
  ok: 'text-slate-500 dark:text-muted-foreground',
  warn: 'text-amber-700 dark:text-amber-300',
  bad: 'text-red-700 dark:text-red-400'
}

const DOT: Partial<Record<SummaryTone, string>> = {
  ok: 'bg-emerald-500 dark:bg-emerald-400',
  warn: 'bg-amber-500 dark:bg-amber-400',
  bad: 'bg-red-500 dark:bg-red-400'
}

/**
 * The card's header row: a toggle (chevron, title, `· summary`) and the actions on the right.
 * The body (description and content) is the caller's, rendered only while `open`.
 */
export function CollapsibleCard({
  title,
  summary,
  tone = 'muted',
  open,
  onOpenChange,
  actions,
  children,
  className,
  ...data
}: {
  title: string
  summary: string
  tone?: SummaryTone
  open: boolean
  onOpenChange: (open: boolean) => void
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
} & { [k: `data-${string}`]: string | boolean | undefined }) {
  const bodyId = useId()
  const summaryRef = useOverflowTip<HTMLSpanElement>(summary)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section
      {...data}
      data-card-open={open ? 'true' : 'false'}
      className={cn(
        'shrink-0 border-b border-slate-200 bg-white px-6 dark:border-border dark:bg-card',
        open ? 'py-4' : 'py-2.5',
        className
      )}
    >
      <div className='flex items-center justify-between gap-3'>
        <button
          type='button'
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onOpenChange(!open)}
          data-card-toggle
          className='-mx-1.5 flex min-w-0 max-w-full flex-1 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <Chevron className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground' />
          <h2 className='shrink-0 text-[13.5px] font-semibold text-slate-900 dark:text-foreground'>
            {title}
          </h2>
          {DOT[tone] && (
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[tone])} aria-hidden />
          )}
          <span
            ref={summaryRef}
            className={cn('min-w-0 truncate text-[11.5px]', TONE[tone])}
            data-card-summary
          >
            {summary}
          </span>
        </button>
        {actions && <div className='flex shrink-0 items-center gap-2'>{actions}</div>}
      </div>
      {open && <div id={bodyId}>{children}</div>}
    </section>
  )
}

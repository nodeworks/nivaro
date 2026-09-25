import { ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * The stat band never runs past two rows (Rob, 2026-09-24). When the dense
 * format still would, the tail of the tiles moves behind this chip and
 * opens as a list — outside the band, so the tiles take their LIST format
 * (lib/header-strip.ts `data-header-list`). "+3 empty" when nothing hidden
 * has a value, so nobody hunts for a figure; the tip names the fields.
 * `data-header-more` lets the measurer skip the chip when it counts cells
 * and read its width when it packs rows (`headerFoldedCells`).
 */
export function HeaderOverflowChip({
  count,
  allEmpty,
  labels,
  children
}: {
  count: number
  allEmpty: boolean
  labels: string[]
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-header-more
          data-copy-skip
          data-open={open ? 'true' : undefined}
          className={cn(
            'flex min-h-[34px] flex-none items-center gap-1 self-stretch pr-3 pl-4 text-[11px] font-semibold tabular-nums text-slate-500 shadow-[-1px_1px_0_0_#e2e8f0] transition-colors duration-[120ms] hover:text-slate-900 dark:text-slate-500 dark:shadow-[-1px_1px_0_0_hsl(var(--border))] dark:hover:text-slate-100',
            open && 'text-slate-900 dark:text-slate-100'
          )}
          data-tip={open ? undefined : `${labels.join(' · ')}${allEmpty ? ' — all empty' : ''}`}
        >
          +{count} {allEmpty ? 'empty' : 'more'}
          <ChevronDown
            className='h-3 w-3 transition-transform duration-[120ms] data-[open=true]:rotate-180'
            data-open={open ? 'true' : undefined}
            aria-hidden='true'
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        sideOffset={4}
        className='w-[320px] max-w-[calc(100vw-32px)] rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-border dark:bg-card'
      >
        <div className='flex flex-col' data-header-list>
          {children}
        </div>
      </PopoverContent>
    </Popover>
  )
}

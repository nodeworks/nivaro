import { Check, ChevronDown, PenLine, Sigma } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { TOTAL_FNS, type TotalFn } from './column-totals'

/**
 * A list column header's menu (2026-11-13): "Set <column> on N selected
 * rows…" — the bulk bar's Update field opened on this column — and the
 * column's totals row figure (Σ: off, Sum, Average, Min, Max, Count).
 * Renders nothing when the column offers neither. Clicks never reach the
 * header (which sorts).
 */
export function ColumnHeaderMenu({
  label,
  selectedCount,
  onSetSelected,
  setUnavailable,
  totals
}: {
  label: string
  /** Selected rows; 0 = the entry explains how to select. */
  selectedCount: number
  /** Absent = this column cannot be set in bulk (calculated, a path, …). */
  onSetSelected?: () => void
  /** Why bulk set is off for this list (the bulk action is switched off, no checkboxes). */
  setUnavailable?: string | null
  /**
   * Absent = the column has no totals (not a number column). `only` limits the functions
   * (a calculated sum offers Sum alone); `unavailable` = a number column the list cannot
   * total: the section shows why instead of choices, so nothing is offered and then dropped.
   */
  totals?: {
    fn: TotalFn | null
    onChange: (fn: TotalFn | null) => void
    only?: TotalFn[]
    unavailable?: string
    note?: string
  }
}) {
  const [open, setOpen] = useState(false)
  if (!onSetSelected && !totals) return null
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  const active = !!totals?.fn
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          onClick={stop}
          onKeyDown={stop}
          aria-label={`${label} column menu`}
          data-cbv-col-menu
          data-tip='Column menu'
          className={cn(
            'ml-1 inline-flex h-4 w-4 items-center justify-center rounded align-middle transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            open || active
              ? 'text-[#00a5cc] opacity-100'
              : 'text-slate-400 opacity-0 hover:text-slate-600 group-hover/hcell:opacity-100 dark:text-slate-500 dark:hover:text-slate-300'
          )}
        >
          {active ? <Sigma className='h-3 w-3' /> : <ChevronDown className='h-3 w-3' />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        sideOffset={6}
        className='w-64 p-1 normal-case tracking-normal'
        onClick={stop}
        onKeyDown={stop}
        // Focus stays where the next step puts it (the bar's Update field panel).
        onCloseAutoFocus={(e) => e.preventDefault()}
        data-cbv-col-menu-panel
      >
        {onSetSelected && (
          <div className={cn(totals && 'border-b border-border pb-1')}>
            <button
              type='button'
              disabled={selectedCount === 0 || !!setUnavailable}
              onClick={() => {
                setOpen(false)
                // After this menu has closed: the bar's panel opens next, and must not
                // see the focus this menu hands back as a click outside it.
                setTimeout(onSetSelected, 0)
              }}
              data-cbv-col-set
              className='flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent'
            >
              <PenLine className='mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground' />
              <span className='min-w-0'>
                <span
                  className={cn(
                    'block',
                    (selectedCount === 0 || setUnavailable) && 'text-muted-foreground'
                  )}
                >
                  Set {label} on{' '}
                  {selectedCount > 0
                    ? `${selectedCount.toLocaleString()} selected row${selectedCount === 1 ? '' : 's'}`
                    : 'selected rows'}
                  …
                </span>
                {(setUnavailable || selectedCount === 0) && (
                  <span className='block text-[11px] leading-4 text-muted-foreground'>
                    {setUnavailable ?? 'Tick the rows to change first.'}
                  </span>
                )}
              </span>
            </button>
          </div>
        )}
        {totals && (
          <fieldset className={cn('m-0 min-w-0 border-0 p-0', onSetSelected && 'pt-1')}>
            <legend className='px-2 pb-0.5 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground'>
              Σ Totals row
            </legend>
            {totals.unavailable ? (
              <p
                data-cbv-col-total-unavailable
                data-tip={totals.unavailable}
                className='cursor-help px-2 py-1 text-[12px] leading-snug text-muted-foreground underline decoration-dotted underline-offset-2'
              >
                No total for this column
              </p>
            ) : null}
            {totals.note && !totals.unavailable ? (
              <p
                data-cbv-col-total-note
                className='px-2 pb-1 text-[11.5px] leading-snug text-muted-foreground'
              >
                {totals.note}
              </p>
            ) : null}
            {(totals.unavailable
              ? []
              : [
                  { fn: null, label: 'Off' } as { fn: TotalFn | null; label: string },
                  ...TOTAL_FNS.filter((t) => !totals.only || totals.only.includes(t.fn))
                ]
            ).map((t) => {
              const on = (totals.fn ?? null) === t.fn
              return (
                <button
                  key={t.fn ?? 'off'}
                  type='button'
                  aria-pressed={on}
                  data-cbv-col-total={t.fn ?? 'off'}
                  onClick={() => {
                    totals.onChange(t.fn)
                    setOpen(false)
                  }}
                  className='flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[12.5px] text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none'
                >
                  <Check className={cn('h-3.5 w-3.5 text-[#00a5cc]', !on && 'invisible')} />
                  {t.label}
                </button>
              )
            })}
          </fieldset>
        )}
      </PopoverContent>
    </Popover>
  )
}

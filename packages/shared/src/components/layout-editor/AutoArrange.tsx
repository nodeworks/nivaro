import { Rows3 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { LayoutBundle, LayoutOp } from '../../lib/layout-ops'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Switch } from '../ui/switch'
import { type ArrangedZone, planAutoArrange } from './auto-arrange'
import { plural } from './field-zones'
import type { ApplyOptions } from './useLayoutDraft'

// Auto-arrange (#2604): a button that opens a popover beside it with what the
// packing would change (rows, gaps, moved and widened fields), then applies
// it as one undoable step. Whole form from the top bar; one section from the
// section's inspector.

const triggerCls =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'

function zoneLine(z: ArrangedZone): string {
  const parts: string[] = []
  if (z.rowsAfter !== z.rowsBefore) parts.push(`${z.rowsBefore} rows → ${z.rowsAfter}`)
  if (z.gapsBefore > z.gapsAfter) parts.push(`${plural(z.gapsBefore - z.gapsAfter, 'gap')} closed`)
  if (z.moved) parts.push(`${plural(z.moved, 'field')} ${z.moved === 1 ? 'moves' : 'move'}`)
  if (z.widened.length) parts.push(`${plural(z.widened.length, 'field')} widened`)
  return parts.join(' · ')
}

export function AutoArrangeButton({
  bundle,
  apply,
  zone,
  zoneLabel,
  className
}: {
  bundle: LayoutBundle
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  /** One section (group key, null = Ungrouped); absent = the whole form. */
  zone?: string | null
  /** The section's name, for the button and the undo step. */
  zoneLabel?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [widen, setWiden] = useState(true)
  const plan = useMemo(
    () => (open ? planAutoArrange(bundle, { zone, widen }) : null),
    [open, bundle, zone, widen]
  )
  const whole = zone === undefined
  const label = whole ? 'Auto-arrange the form' : `Auto-arrange ${zoneLabel ?? 'this section'}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-auto-arrange={whole ? 'form' : 'section'}
          className={cn(triggerCls, className)}
          data-tip='Pack fields into tidy rows by width and close the gaps'
        >
          <Rows3 className='h-3.5 w-3.5 shrink-0' />
          {whole ? 'Auto-arrange' : 'Auto-arrange fields'}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[340px] p-3' data-auto-arrange-plan=''>
        <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>{label}</p>
        <p className='mt-0.5 text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
          Fills each row of the 12-column grid, pulling a later field up when it fits. Undo puts
          everything back.
        </p>
        <div className='mt-3 flex items-center justify-between gap-3 text-[12.5px] text-slate-700 dark:text-foreground'>
          Widen fields to fill rows
          <Switch
            checked={widen}
            onCheckedChange={setWiden}
            aria-label='Widen fields to fill rows'
            className='h-[18px] w-8 border-0 data-[state=checked]:bg-nvr-cyan data-[state=unchecked]:bg-slate-300 dark:data-[state=unchecked]:bg-slate-600 [&>span]:mx-0.5 [&>span]:h-3.5 [&>span]:w-3.5 [&>span]:bg-white [&>span]:shadow-sm [&>span]:data-[state=checked]:translate-x-3.5'
          />
        </div>
        <div className='mt-3 border-t border-slate-100 pt-2.5 dark:border-border'>
          {plan && plan.zones.length > 0 ? (
            <ul className='space-y-1.5' aria-label='What changes'>
              {plan.zones.map((z) => (
                <li key={z.key ?? ''} className='text-[12.5px] leading-snug'>
                  <span className='font-medium text-slate-800 dark:text-foreground'>{z.label}</span>
                  <span className='block text-slate-500 dark:text-muted-foreground'>
                    {zoneLine(z)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              {plan && plan.checked === 0
                ? 'There are no fields to arrange here.'
                : 'Every row is already tidy.'}
            </p>
          )}
        </div>
        <div className='mt-3 flex justify-end gap-2'>
          <button
            type='button'
            onClick={() => setOpen(false)}
            className='h-7 rounded-md px-2.5 text-[12px] font-medium text-slate-600 hover:bg-muted dark:text-muted-foreground'
          >
            Cancel
          </button>
          <button
            type='button'
            data-auto-arrange-apply=''
            disabled={!plan || plan.ops.length === 0}
            onClick={() => {
              if (!plan?.ops.length) return
              apply(plan.ops, { label })
              setOpen(false)
            }}
            className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40'
          >
            Arrange
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

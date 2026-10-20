import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * An item action's `choose` step (ctx.itemActions.register({ choose })) —
 * "which file to send" and the like. The registry lists `choose` without its
 * options; hosts fetch GET /item-actions/:id/choices when the button is
 * pressed and show this list only when there are two or more.
 */

export interface ItemActionChooseMeta {
  key: string
  label: string
  body?: string | null
}

export interface ItemActionChoiceOption {
  value: string
  label: string
  hint?: string
}

/** What the press should do with the fetched options: no pick, an
 *  automatic pick (exactly one), or ask (two or more). */
export function itemActionChoiceStep(
  options: ItemActionChoiceOption[]
): { ask: false; value: string | null } | { ask: true } {
  if (options.length === 0) return { ask: false, value: null }
  if (options.length === 1) return { ask: false, value: options[0].value }
  return { ask: true }
}

export function ItemActionChoiceList({
  choose,
  options,
  value,
  onChange
}: {
  choose: ItemActionChooseMeta
  options: ItemActionChoiceOption[]
  value: string | null
  onChange: (value: string) => void
}) {
  return (
    <div className='mt-3' data-item-action-choices={choose.key}>
      <p className='mb-1 text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
        {choose.label}
      </p>
      {choose.body && (
        <p className='mb-2 text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
          {choose.body}
        </p>
      )}
      <fieldset
        aria-label={choose.label}
        className='m-0 max-h-64 min-w-0 overflow-y-auto overscroll-contain rounded-md border border-slate-200 p-0 dark:border-border'
      >
        {options.map((o) => {
          const on = o.value === value
          return (
            <button
              key={o.value}
              type='button'
              aria-pressed={on}
              onClick={() => onChange(o.value)}
              className={cn(
                'flex w-full items-start gap-2 border-b border-slate-100 px-2.5 py-2 text-left last:border-b-0 dark:border-border',
                on ? 'bg-accent' : 'hover:bg-muted'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                  on
                    ? 'border-nvr-cyan bg-nvr-cyan text-white'
                    : 'border-slate-300 dark:border-border'
                )}
              >
                {on && <Check className='h-2.5 w-2.5' />}
              </span>
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-[12.5px] text-slate-800 dark:text-foreground'>
                  {o.label}
                </span>
                {o.hint && (
                  <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {o.hint}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </fieldset>
    </div>
  )
}

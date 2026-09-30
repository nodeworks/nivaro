import { Check, ChevronDown, Plug, X } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { INTEGRATIONS_FILTER_OPTIONS } from './IntegrationDots'

/**
 * #630 — the "how are this row's integration partners doing" pill for a
 * toolbar. Picks one of INTEGRATIONS_FILTER_OPTIONS (the same bucket names the
 * collection browser's Integrations column filter uses and the queue read
 * model understands — `filters.integrations`), or clears it. Purely a control;
 * the host owns the value.
 */
export function IntegrationsFilterPill({
  value,
  onChange,
  label = 'Integrations'
}: {
  value: string | string[] | undefined
  onChange: (next: string | null) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const current = Array.isArray(value) ? value[0] : value
  const picked = INTEGRATIONS_FILTER_OPTIONS.find((o) => o.value === current) ?? null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        data-queue-integrations-filter={picked?.value ?? ''}
        className={cn(
          'flex h-8 items-center rounded-full border text-[12px] font-medium transition-colors',
          picked
            ? 'border-nvr-cyan/40 bg-[#f2fdff] text-nvr-navy dark:border-nvr-cyan/40 dark:bg-[#20303a] dark:text-nvr-cyan'
            : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-border dark:bg-card dark:text-slate-300'
        )}
      >
        <PopoverTrigger asChild>
          <button
            type='button'
            aria-pressed={!!picked}
            title='Only records whose integration partners are in this state'
            className='flex h-full items-center gap-1.5 pl-2.5 pr-2'
          >
            <Plug className='h-3.5 w-3.5' />
            {picked ? `${label}: ${picked.label}` : label}
            {!picked && <ChevronDown className='h-3 w-3 opacity-60' />}
          </button>
        </PopoverTrigger>
        {picked && (
          <button
            type='button'
            aria-label={`Clear the ${label} filter`}
            data-queue-integrations-clear
            onClick={() => onChange(null)}
            className='mr-1.5 rounded-full p-0.5 hover:bg-nvr-cyan/15'
          >
            <X className='h-3 w-3' />
          </button>
        )}
      </div>
      <PopoverContent align='start' side='bottom' sideOffset={6} className='w-[240px] p-1'>
        <p className='px-2 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400'>
          Integration partners
        </p>
        {INTEGRATIONS_FILTER_OPTIONS.map((o) => {
          const active = o.value === picked?.value
          return (
            <button
              key={o.value}
              type='button'
              data-queue-integrations-option={o.value}
              onClick={() => {
                onChange(active ? null : o.value)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]',
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-slate-700 hover:bg-muted dark:text-slate-200'
              )}
            >
              <Check className={cn('h-3.5 w-3.5 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
              {o.label}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

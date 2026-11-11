import { Check, ChevronDown, ChevronRight, ChevronsUpDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Chip } from './chip'
import { Drillable, useDrill } from './drill'
import type { DrillRef } from './format'

/** A collapsible block of the report. Empty ones stay quiet and unopenable. */
export function Section({
  id,
  title,
  gist,
  empty,
  defaultOpen,
  children
}: {
  id: string
  title: string
  /** One line of the headline numbers, visible while collapsed. */
  gist?: ReactNode
  empty?: boolean
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(!!defaultOpen && !empty)
  return (
    <section
      data-ops-section={id}
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <button
        type='button'
        disabled={empty}
        aria-expanded={empty ? undefined : open}
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left enabled:hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
      >
        {empty ? (
          <span className='w-3.5' />
        ) : open ? (
          <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
        )}
        <span
          className={cn(
            'text-[12.5px] font-semibold',
            empty
              ? 'text-slate-400 dark:text-muted-foreground'
              : 'text-slate-800 dark:text-foreground'
          )}
        >
          {title}
        </span>
        <span className='min-w-0 flex-1 truncate text-right text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {empty ? 'Nothing recorded' : gist}
        </span>
      </button>
      {open && !empty && (
        <div className='space-y-3 border-t border-slate-100 px-3 py-3 dark:border-border'>
          {children}
        </div>
      )}
    </section>
  )
}

export function SubTitle({ children }: { children: ReactNode }) {
  return (
    <h4 className='mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
      {children}
    </h4>
  )
}

export interface Col<T> {
  h: string
  cell: (row: T) => ReactNode
  num?: boolean
  className?: string
}

/** Compact table for digest rows. Hidden entirely when there are no rows. */
export function MiniTable<T>({
  title,
  rows,
  cols,
  limit = 15,
  drill
}: {
  title?: string
  rows: T[]
  cols: Col<T>[]
  limit?: number
  /** Makes each row open the rows behind it. */
  drill?: (row: T) => DrillRef | null
}) {
  const panel = useDrill()
  if (!rows.length) return null
  const shown = rows.slice(0, limit)
  return (
    <div>
      {title && <SubTitle>{title}</SubTitle>}
      <div className='overflow-x-auto'>
        <table className='w-full text-[12px]'>
          <thead>
            <tr className='border-b border-slate-200 text-left text-[10.5px] uppercase tracking-wide text-slate-500 dark:border-border dark:text-muted-foreground'>
              {cols.map((c) => (
                <th
                  key={c.h}
                  className={cn('py-1 pr-3 font-medium last:pr-0', c.num && 'text-right')}
                >
                  {c.h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: digest rows have no id
                key={i}
                {...drillRowProps(panel, drill?.(r) ?? null)}
                className={cn(
                  'border-b border-slate-100 last:border-0 dark:border-border/60',
                  panel &&
                    drill?.(r) &&
                    'cursor-pointer hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50'
                )}
              >
                {cols.map((c) => (
                  <td
                    key={c.h}
                    className={cn(
                      'py-1 pr-3 align-top text-slate-700 last:pr-0 dark:text-foreground',
                      c.num && 'text-right tabular-nums',
                      c.className
                    )}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <p className='mt-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
          and {rows.length - limit} more
        </p>
      )}
    </div>
  )
}

function drillRowProps(panel: ReturnType<typeof useDrill>, ref: DrillRef | null) {
  if (!panel || !ref) return {}
  const go = () => panel.open({ metric: ref.metric, key: ref.key, label: ref.label })
  return {
    tabIndex: 0,
    'data-ops-drill': ref.metric,
    onClick: go,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        go()
      }
    }
  }
}

export function Stat({
  label,
  value,
  tone,
  drill
}: {
  label: string
  value: ReactNode
  tone?: 'bad'
  drill?: DrillRef | null
}) {
  return (
    <Drillable
      target={drill ?? null}
      className='min-w-[84px] rounded-md px-1 py-0.5 -mx-1 -my-0.5 hover:bg-muted'
    >
      <div>
        <div
          className={cn(
            'text-[15px] font-semibold tabular-nums',
            tone === 'bad'
              ? 'text-red-600 dark:text-red-400'
              : 'text-slate-900 dark:text-foreground'
          )}
        >
          {value}
        </div>
        <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</div>
      </div>
    </Drillable>
  )
}

/** Searchable single pick (Popover + Command). Never a native select. */
export function Pick({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder,
  className
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
  ariaLabel: string
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const sel = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            'h-8 justify-between gap-2 rounded-md border-slate-200 bg-white px-2.5 text-[12.5px] font-normal dark:border-border dark:bg-background',
            className
          )}
        >
          <span className={cn('truncate', !sel && 'text-muted-foreground')}>
            {sel?.label ?? placeholder ?? 'Select…'}
          </span>
          <ChevronsUpDown className='h-3 w-3 shrink-0 opacity-50' aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.value}
                value={o.label}
                onSelect={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className='text-[12px]'
              >
                <Check
                  className={cn('mr-2 h-3 w-3', o.value === value ? 'opacity-100' : 'opacity-0')}
                />
                {o.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { Chip }

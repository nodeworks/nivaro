import { ArrowDownRight, ArrowUpRight, Check, ChevronsUpDown, X } from 'lucide-react'
import { createContext, type ReactNode, useContext, useState } from 'react'
import { cn } from '../../lib/utils'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { DaCell, DaOutcome } from './types'
import { fmtInt } from './url'

/** Opens the rows behind a number (the view puts it in the URL). */
export type OpenDrill = (cell: DaCell, label: string, opts?: { sort?: 'ttr' }) => void
export const DrillContext = createContext<OpenDrill>(() => {})

/**
 * A number that opens the rows behind it. Zero has nothing behind it and stays
 * plain text; everything else is a button whose label says what opens.
 */
export function Num({
  cell,
  label,
  children,
  className,
  tip,
  sort
}: {
  cell: DaCell | null | undefined
  /** The drill's title: what these rows are ("Failed emails · Workflow moved"). */
  label: string
  children?: ReactNode
  className?: string
  tip?: string
  /** Open the rows slowest-read first (time-to-read figures). */
  sort?: 'ttr'
}) {
  const open = useContext(DrillContext)
  const content = children ?? fmtInt(cell?.n ?? 0)
  if (!cell || cell.n === 0)
    return (
      <span
        className={cn('tabular-nums', className, 'text-slate-400 dark:text-muted-foreground/70')}
      >
        {content}
      </span>
    )
  return (
    <button
      type='button'
      data-da-num={cell.n}
      data-tip={tip ?? `Show the ${fmtInt(cell.n)} ${cell.n === 1 ? 'row' : 'rows'} behind this`}
      onClick={(e) => {
        e.stopPropagation()
        open(cell, label, sort ? { sort } : undefined)
      }}
      className={cn(
        'rounded-sm tabular-nums decoration-slate-300 decoration-dotted underline-offset-[3px] hover:underline hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:decoration-muted-foreground/40',
        className
      )}
    >
      {content}
    </button>
  )
}

export function Panel({
  title,
  hint,
  actions,
  children,
  className,
  id
}: {
  title: string
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section
      data-da-panel={id}
      aria-label={title}
      className={cn(
        'min-w-0 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
    >
      <header className='flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <div className='min-w-0 flex-1'>
          <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h3>
          {hint && (
            <p className='mt-0.5 text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
              {hint}
            </p>
          )}
        </div>
        {actions}
      </header>
      {children}
    </section>
  )
}

/** Change against the previous period: the figure, and the previous rows on click. */
export function Delta({
  cur,
  prev,
  label,
  goodWhen = 'neutral',
  periodLabel
}: {
  cur: number
  prev: DaCell
  label: string
  /** Which direction reads as good: colour only, never the only signal. */
  goodWhen?: 'up' | 'down' | 'neutral'
  periodLabel: string
}) {
  const open = useContext(DrillContext)
  if (prev.n === 0 && cur === 0) return null
  const change = prev.n === 0 ? null : (cur - prev.n) / prev.n
  const up = cur > prev.n
  const flat = cur === prev.n
  const tone =
    flat || goodWhen === 'neutral'
      ? 'text-slate-500 dark:text-muted-foreground'
      : (up && goodWhen === 'up') || (!up && goodWhen === 'down')
        ? 'text-green-700 dark:text-[#9fbf8a]'
        : 'text-red-700 dark:text-[#e08383]'
  const Icon = up ? ArrowUpRight : ArrowDownRight
  const text =
    change == null ? 'new' : flat ? 'no change' : `${Math.abs(Math.round(change * 100))}%`
  return (
    <button
      type='button'
      data-da-delta=''
      data-tip={`${fmtInt(prev.n)} in the ${periodLabel} — show them`}
      disabled={prev.n === 0}
      onClick={() => open(prev, `${label} · previous period`)}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-sm text-[11px] font-medium tabular-nums enabled:hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        tone
      )}
    >
      {!flat && change != null && <Icon className='h-3 w-3' aria-hidden />}
      {text}
      <span className='font-normal text-slate-500 dark:text-muted-foreground'>
        &nbsp;vs {fmtInt(prev.n)}
      </span>
    </button>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  prefix
}: {
  value: T
  options: Array<{ value: T; label: string; tip?: string }>
  onChange: (v: T) => void
  ariaLabel: string
  prefix?: string
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar toggle group, not a form fieldset
    <div
      role='group'
      aria-label={ariaLabel}
      className='inline-flex shrink-0 items-center rounded-md border border-slate-200 bg-white p-0.5 dark:border-border dark:bg-card'
    >
      {prefix && (
        <span className='px-2 text-[12px] text-slate-500 dark:text-muted-foreground'>{prefix}</span>
      )}
      {options.map((o) => (
        <button
          key={String(o.value)}
          type='button'
          aria-pressed={value === o.value}
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
            value === o.value
              ? 'bg-slate-900 text-white dark:bg-nvr-cyan dark:text-[#172940]'
              : 'text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A searchable single-choice filter (Popover + Command; never a native select). */
export function FilterPicker({
  label,
  value,
  options,
  onChange,
  allLabel
}: {
  label: string
  value: string | null
  options: Array<{ value: string; label: string; count?: number }>
  onChange: (v: string | null) => void
  allLabel: string
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <div className='inline-flex shrink-0 items-center'>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            data-da-filter={label}
            aria-label={`${label}: ${current?.label ?? value ?? allLabel}`}
            className={cn(
              'inline-flex h-8 max-w-[220px] items-center gap-1.5 border px-2.5 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
              value
                ? 'rounded-l-md border-nvr-cyan/60 bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                : 'rounded-md border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
            )}
          >
            <span className='text-slate-500 dark:text-muted-foreground'>{label}</span>
            <span className='min-w-0 truncate font-medium'>
              {value ? (current?.label ?? value) : allLabel}
            </span>
            <ChevronsUpDown className='h-3 w-3 shrink-0 opacity-50' aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-[260px] p-0' align='start'>
          <Command>
            <CommandInput
              placeholder={`Find a ${label.toLowerCase()}…`}
              className='h-9 text-[12.5px]'
            />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              <CommandItem
                value={`__all__ ${allLabel}`}
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className='text-[12.5px]'
              >
                <Check className={cn('mr-2 h-3.5 w-3.5', value ? 'opacity-0' : 'opacity-100')} />
                {allLabel}
              </CommandItem>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3.5 w-3.5',
                      value === o.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className='min-w-0 flex-1 truncate'>{o.label}</span>
                  {o.count != null && (
                    <span className='ml-2 text-[11px] tabular-nums text-slate-400'>
                      {fmtInt(o.count)}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && (
        <button
          type='button'
          aria-label={`Clear the ${label.toLowerCase()} filter`}
          data-tip='Clear'
          onClick={() => onChange(null)}
          className='inline-flex h-8 items-center rounded-r-md border border-l-0 border-nvr-cyan/60 bg-nvr-cyan/10 px-1.5 text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:text-foreground'
        >
          <X className='h-3 w-3' />
        </button>
      )}
    </div>
  )
}

const OUTCOME_TONE: Record<string, string> = {
  delivered:
    'border-green-200 bg-green-50 text-green-800 dark:border-[#9fbf8a]/30 dark:bg-[#9fbf8a]/10 dark:text-[#b9d3a6]',
  failed:
    'border-red-200 bg-red-50 text-red-800 dark:border-[#e08383]/30 dark:bg-[#e08383]/10 dark:text-[#eaa3a3]',
  deferred:
    'border-sky-200 bg-sky-50 text-sky-800 dark:border-[#8fa6c9]/30 dark:bg-[#8fa6c9]/10 dark:text-[#b3c4dd]',
  dropped:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-[#d4936a]/30 dark:bg-[#d4936a]/10 dark:text-[#e2b192]',
  suppressed:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-[#d4936a]/30 dark:bg-[#d4936a]/10 dark:text-[#e2b192]',
  test: 'border-violet-200 bg-violet-50 text-violet-800 dark:border-border dark:bg-muted dark:text-muted-foreground'
}
const NEUTRAL_TONE =
  'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted dark:text-muted-foreground'

export function OutcomeChip({
  outcome,
  children
}: {
  outcome: DaOutcome | string
  children: ReactNode
}) {
  return (
    <span
      data-da-outcome={outcome}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-px text-[10.5px] font-medium',
        OUTCOME_TONE[outcome] ?? NEUTRAL_TONE
      )}
    >
      {children}
    </span>
  )
}

/** A thin share bar behind a count (scanability, not decoration). */
export function ShareBar({
  value,
  max,
  tone = 'accent'
}: {
  value: number
  max: number
  tone?: 'accent' | 'bad'
}) {
  const w = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0
  return (
    <span
      className='block h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
      aria-hidden
    >
      <span
        className={cn(
          'block h-full rounded-full',
          tone === 'bad' ? 'bg-red-500/70 dark:bg-[#e08383]/70' : 'bg-nvr-cyan/70'
        )}
        style={{ width: `${w}%` }}
      />
    </span>
  )
}

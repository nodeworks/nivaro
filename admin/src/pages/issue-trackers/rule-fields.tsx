import { Check, ChevronsUpDown, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { CountWindow } from './api'
import { DURATION_UNITS, type DurationUnit, splitDuration } from './rule-sentence'

/**
 * Small editors the rule builder is made of. Every one commits on change —
 * they also live inside popovers, where no blur ever fires.
 */

export function FieldRow({
  label,
  hint,
  htmlFor,
  children,
  className
}: {
  label: ReactNode
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label
        htmlFor={htmlFor}
        className='text-[11.5px] font-medium text-slate-700 dark:text-slate-200'
      >
        {label}
      </Label>
      {children}
      {hint && (
        <p className='max-w-[60ch] text-[11px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
      )}
    </div>
  )
}

/**
 * A whole-number box. The text stays as typed; a valid number is written at
 * once, an emptied box writes `undefined` only when `optional` (else nothing).
 */
export function NumberBox({
  value,
  onChange,
  min = 0,
  max,
  optional,
  id,
  ariaLabel,
  className,
  placeholder
}: {
  value: number | undefined
  onChange: (n: number | undefined) => void
  min?: number
  max?: number
  optional?: boolean
  id?: string
  ariaLabel?: string
  className?: string
  placeholder?: string
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  // a value set from outside (another editor, a discard) replaces what the box shows
  useEffect(() => {
    setText((t) => {
      if (value === undefined) return optional ? '' : t
      return t.trim() !== '' && Number(t) === value ? t : String(value)
    })
  }, [value, optional])
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      type='number'
      inputMode='numeric'
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        if (raw.trim() === '') {
          if (optional) onChange(undefined)
          return
        }
        const n = Math.floor(Number(raw))
        if (!Number.isFinite(n) || n < min || (max !== undefined && n > max)) return
        onChange(n)
      }}
      className={cn('h-8 w-20 text-[12px] tabular-nums', className)}
    />
  )
}

/** An amount + unit (minutes / hours / days), written as minutes. */
export function DurationBox({
  minutes,
  onChange,
  min = 1,
  ariaLabel
}: {
  minutes: number
  onChange: (minutes: number) => void
  min?: number
  ariaLabel: string
}) {
  const split = splitDuration(minutes)
  const [unit, setUnit] = useState<DurationUnit>(split.unit)
  useEffect(() => setUnit(splitDuration(minutes).unit), [minutes])
  const factor = DURATION_UNITS.find((u) => u.key === unit)?.factor ?? 1
  const amount = Math.max(1, Math.round(minutes / factor))
  return (
    <span className='inline-flex items-center gap-1.5'>
      <NumberBox
        value={amount}
        min={1}
        ariaLabel={ariaLabel}
        onChange={(n) => n !== undefined && onChange(Math.max(min, n * factor))}
        className='w-16'
      />
      <ChoiceButtons
        ariaLabel={`${ariaLabel} unit`}
        value={[unit]}
        single
        options={DURATION_UNITS.map((u) => ({ value: u.key, label: u.label }))}
        onChange={(v) => {
          const next = (v[0] ?? 'minutes') as DurationUnit
          const f = DURATION_UNITS.find((u) => u.key === next)?.factor ?? 1
          setUnit(next)
          onChange(Math.max(min, amount * f))
        }}
      />
    </span>
  )
}

/** "N within <duration>", or off. */
export function CountWindowBox({
  value,
  onChange,
  noun,
  ariaLabel
}: {
  value: CountWindow | undefined
  onChange: (v: CountWindow | undefined) => void
  noun: string
  ariaLabel: string
}) {
  const id = useId()
  return (
    <div className='flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-slate-700 dark:text-slate-200'>
      <Checkbox
        id={id}
        checked={!!value}
        onCheckedChange={(c) => onChange(c === true ? { n: 10, window_minutes: 60 } : undefined)}
        className='h-3.5 w-3.5 border-slate-300 data-[state=checked]:border-nvr-cyan data-[state=checked]:bg-nvr-cyan data-[state=checked]:text-white dark:border-border [&_svg]:h-3 [&_svg]:w-3'
      />
      <Label htmlFor={id} className='cursor-pointer text-[12px] font-normal'>
        {ariaLabel}
      </Label>
      {value && (
        <>
          <NumberBox
            value={value.n}
            min={1}
            ariaLabel={`${ariaLabel}: how many ${noun}`}
            onChange={(n) => n !== undefined && onChange({ ...value, n })}
            className='w-20'
          />
          <span>{noun} within</span>
          <DurationBox
            minutes={value.window_minutes}
            min={5}
            ariaLabel={`${ariaLabel}: window`}
            onChange={(m) => onChange({ ...value, window_minutes: Math.min(43200, m) })}
          />
        </>
      )}
    </div>
  )
}

/** Toggle buttons over a fixed list (multi by default; `single` = exactly one). */
export function ChoiceButtons({
  value,
  options,
  onChange,
  ariaLabel,
  single
}: {
  value: string[]
  options: Array<{ value: string; label: string }>
  onChange: (v: string[]) => void
  ariaLabel: string
  single?: boolean
}) {
  const on = (v: string) => value.some((x) => x.toLowerCase() === v.toLowerCase())
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a fieldset form
    <div role='group' aria-label={ariaLabel} className='inline-flex flex-wrap gap-1'>
      {options.map((o) => (
        <button
          key={o.value}
          type='button'
          aria-pressed={on(o.value)}
          onClick={() =>
            onChange(
              single
                ? [o.value]
                : on(o.value)
                  ? value.filter((x) => x.toLowerCase() !== o.value.toLowerCase())
                  : [...value, o.value]
            )
          }
          className={cn(
            'h-7 rounded-md border px-2 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
            on(o.value)
              ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted/50'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Free text values as removable chips; Enter or a comma adds what was typed. */
export function TagInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
  numeric
}: {
  value: string[]
  onChange: (v: string[]) => void
  ariaLabel: string
  placeholder?: string
  numeric?: boolean
}) {
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !numeric || /^\d+$/.test(s))
    const next = [...value]
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p)
    if (next.length !== value.length) onChange(next)
    setText('')
  }
  return (
    <div className='flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1 focus-within:ring-2 focus-within:ring-nvr-cyan/40'>
      {value.map((v) => (
        <span
          key={v}
          className='inline-flex max-w-full items-center gap-1 rounded bg-slate-100 py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-slate-700 dark:bg-muted dark:text-slate-200'
        >
          <span className='truncate'>{v}</span>
          <button
            type='button'
            aria-label={`Remove ${v}`}
            onClick={() => onChange(value.filter((x) => x !== v))}
            className='rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-muted-foreground/20 dark:hover:text-slate-100'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ))}
      <input
        aria-label={ariaLabel}
        value={text}
        placeholder={value.length ? '' : placeholder}
        inputMode={numeric ? 'numeric' : undefined}
        onChange={(e) => {
          const v = e.target.value
          if (v.includes(',')) add(v)
          else setText(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(text)
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
        }}
        className='h-6 min-w-[8ch] flex-1 bg-transparent px-1 text-[12px] outline-none placeholder:text-slate-400'
      />
      {text.trim() && (
        <button
          type='button'
          onClick={() => add(text)}
          className='rounded px-1.5 text-[11px] font-medium text-nvr-navy hover:bg-nvr-cyan/10 dark:text-nvr-cyan'
        >
          Add
        </button>
      )}
    </div>
  )
}

/** A searchable pick-list (Combobox) for one value or several. */
export function PickList<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder,
  multi,
  emptyText = 'Nothing found.',
  onSearch,
  loading
}: {
  options: Array<{ value: T; label: string; hint?: string }>
  value: T[]
  onChange: (v: T[]) => void
  ariaLabel: string
  placeholder: string
  multi?: boolean
  emptyText?: string
  /** Server-side search: the typed text (the list is then not filtered here). */
  onSearch?: (q: string) => void
  loading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const labelOf = (v: T) => options.find((o) => o.value === v)?.label ?? String(v)
  const summary = value.length ? value.map(labelOf).join(', ') : placeholder
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={ariaLabel}
          className='flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-[12px] hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted/40'
        >
          <span
            className={cn('truncate', !value.length && 'text-slate-400 dark:text-muted-foreground')}
          >
            {summary}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] min-w-[240px] p-0' align='start'>
        <Command shouldFilter={!onSearch}>
          <CommandInput
            placeholder='Search…'
            onValueChange={onSearch}
            className='h-8 text-[12px]'
          />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-slate-500'>
              {loading ? 'Searching…' : emptyText}
            </CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const on = value.includes(o.value)
                return (
                  <CommandItem
                    key={String(o.value)}
                    value={`${o.label} ${o.hint ?? ''} ${o.value}`}
                    onSelect={() => {
                      if (multi)
                        onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])
                      else {
                        onChange(on ? [] : [o.value])
                        setOpen(false)
                      }
                    }}
                    className='text-[12px]'
                  >
                    <Check className={cn('mr-1.5 h-3.5 w-3.5', on ? 'opacity-100' : 'opacity-0')} />
                    <span className='truncate'>{o.label}</span>
                    {o.hint && (
                      <span className='ml-auto truncate pl-2 text-[11px] text-slate-400'>
                        {o.hint}
                      </span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

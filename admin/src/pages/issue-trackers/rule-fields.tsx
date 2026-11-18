import { X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { CountWindow } from './api'
import { DURATION_UNITS, type DurationUnit, splitDuration } from './rule-sentence'
import { Segmented } from './SyncCards'

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
        className='block text-[11.5px] font-medium text-slate-700 dark:text-slate-200'
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
    <span className='inline-flex flex-wrap items-center gap-1.5'>
      <NumberBox
        value={amount}
        min={1}
        ariaLabel={ariaLabel}
        onChange={(n) => n !== undefined && onChange(Math.max(min, n * factor))}
        className='w-16'
      />
      <Segmented<DurationUnit>
        ariaLabel={`${ariaLabel} unit`}
        value={unit}
        options={DURATION_UNITS.map((u) => ({ value: u.key, label: u.label }))}
        onChange={(next) => {
          const f = DURATION_UNITS.find((u) => u.key === next)?.factor ?? 1
          setUnit(next)
          onChange(Math.max(min, amount * f))
        }}
      />
    </span>
  )
}

/**
 * One line of a condition grid (`ConditionGrid`): the name on the left, what it takes on the
 * right, so a stack of them reads down like a list of sentences. With `onCheckedChange` the name
 * is a checkbox and the controls show only while it is ticked; without it the name labels
 * `htmlFor` (an optional box that is empty when not used).
 */
export function ConditionRow({
  label,
  checked,
  onCheckedChange,
  htmlFor,
  children
}: {
  label: string
  checked?: boolean
  onCheckedChange?: (on: boolean) => void
  htmlFor?: string
  children?: ReactNode
}) {
  const id = useId()
  const toggle = onCheckedChange != null
  return (
    <>
      <div className='flex h-8 items-center gap-2'>
        {toggle ? (
          <Checkbox
            id={id}
            checked={!!checked}
            onCheckedChange={(c) => onCheckedChange(c === true)}
            className='h-3.5 w-3.5 border-slate-300 data-[state=checked]:border-nvr-cyan data-[state=checked]:bg-nvr-cyan data-[state=checked]:text-white dark:border-border [&_svg]:h-3 [&_svg]:w-3'
          />
        ) : (
          <span aria-hidden className='w-3.5 shrink-0' />
        )}
        <Label
          htmlFor={toggle ? id : htmlFor}
          className={cn(
            'cursor-pointer whitespace-nowrap text-[12px] font-normal',
            toggle && !checked
              ? 'text-slate-500 dark:text-muted-foreground'
              : 'text-slate-800 dark:text-slate-100'
          )}
        >
          {label}
        </Label>
      </div>
      {/* Phone: under its name, lined up with the name's text; an off row shows nothing here. */}
      <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 pl-[1.375rem] max-sm:empty:hidden sm:min-h-8 sm:pl-0'>
        {toggle && !checked ? null : children}
      </div>
    </>
  )
}

/** The grid `ConditionRow`s line up in. */
export function ConditionGrid({ children }: { children: ReactNode }) {
  return (
    <div className='grid items-start gap-x-4 gap-y-1.5 text-[12px] text-slate-700 sm:grid-cols-[auto_minmax(0,1fr)] dark:text-slate-200'>
      {children}
    </div>
  )
}

/** "N <noun> within <duration>", or off — a `ConditionRow`. */
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
  return (
    <ConditionRow
      label={ariaLabel}
      checked={!!value}
      onCheckedChange={(on) => onChange(on ? { n: 10, window_minutes: 60 } : undefined)}
    >
      {value && (
        <>
          <NumberBox
            value={value.n}
            min={1}
            ariaLabel={`${ariaLabel}: how many ${noun}`}
            onChange={(n) => n !== undefined && onChange({ ...value, n })}
            className='w-16'
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
    </ConditionRow>
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
  numeric,
  className
}: {
  value: string[]
  onChange: (v: string[]) => void
  ariaLabel: string
  placeholder?: string
  numeric?: boolean
  /** Width: by default up to 28rem — sized to a few values, not to the page. */
  className?: string
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
    <div
      className={cn(
        'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1 focus-within:ring-2 focus-within:ring-nvr-cyan/40',
        className ?? 'max-w-md'
      )}
    >
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

/** A searchable pick-list (Combobox) for one value or several — the shared one. */
export { PickList } from '@nivaro/shared'

import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from './select'

// Thin value/onChange wrapper over the Radix ui/select so plain string-state
// call sites can drop native <select> without adopting the compound API.
// Radix forbids '' item values, so empty options ride an internal sentinel.

const EMPTY = '__empty__'

export interface SimpleSelectOption {
  value: string
  label: string
  /** Options with the same group show under one heading, groups in first-seen order. */
  group?: string
}

type Section = { group: string | null; options: SimpleSelectOption[] }

/** Ungrouped options stay at the top; each group keeps the order its first option had. */
function sectionsOf(options: SimpleSelectOption[]): Section[] {
  const out: Section[] = []
  for (const o of options) {
    const g = o.group ?? null
    const s = out.find((x) => x.group === g)
    if (s) s.options.push(o)
    else out.push({ group: g, options: [o] })
  }
  return out.sort((a, b) => (a.group === null ? -1 : b.group === null ? 1 : 0))
}

export function SimpleSelect({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  contentClassName,
  disabled,
  triggerProps
}: {
  value: string
  onChange: (v: string) => void
  options: SimpleSelectOption[]
  ariaLabel?: string
  className?: string
  contentClassName?: string
  disabled?: boolean
  triggerProps?: Record<string, string>
}) {
  const item = (o: SimpleSelectOption) => (
    <SelectItem key={o.value || EMPTY} value={o.value === '' ? EMPTY : o.value}>
      {o.label}
    </SelectItem>
  )
  return (
    <Select
      value={value === '' ? EMPTY : value}
      onValueChange={(v) => onChange(v === EMPTY ? '' : v)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel} className={className} {...triggerProps}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.some((o) => o.group)
          ? sectionsOf(options).map((sec, i) => (
              <SelectGroup key={sec.group ?? EMPTY}>
                {i > 0 && <SelectSeparator />}
                {sec.group && <SelectLabel>{sec.group}</SelectLabel>}
                {sec.options.map(item)}
              </SelectGroup>
            ))
          : options.map(item)}
      </SelectContent>
    </Select>
  )
}

/** Compact variant for table filter rows — h-6, tiny text, minimal padding. */
export function SimpleSelectXs(props: Parameters<typeof SimpleSelect>[0]) {
  return (
    <SimpleSelect
      {...props}
      className={cn(
        'h-6 w-auto gap-0.5 rounded border-slate-200 bg-white px-1 py-0 text-[11px] font-normal normal-case tracking-normal dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 [&>svg]:h-3 [&>svg]:w-3',
        props.className
      )}
    />
  )
}

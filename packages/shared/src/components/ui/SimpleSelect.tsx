import { cn } from '../../lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

// Thin value/onChange wrapper over the Radix ui/select so plain string-state
// call sites can drop native <select> without adopting the compound API.
// Radix forbids '' item values, so empty options ride an internal sentinel.

const EMPTY = '__empty__'

export interface SimpleSelectOption {
  value: string
  label: string
}

export function SimpleSelect({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  contentClassName
}: {
  value: string
  onChange: (v: string) => void
  options: SimpleSelectOption[]
  ariaLabel?: string
  className?: string
  contentClassName?: string
}) {
  return (
    <Select
      value={value === '' ? EMPTY : value}
      onValueChange={(v) => onChange(v === EMPTY ? '' : v)}
    >
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((o) => (
          <SelectItem key={o.value || EMPTY} value={o.value === '' ? EMPTY : o.value}>
            {o.label}
          </SelectItem>
        ))}
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

import { Check, ChevronsUpDown, X } from 'lucide-react'
import { createContext, isValidElement, type ReactNode, useContext, useState } from 'react'
import { cn } from '../../../lib/utils'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { effectText, inputBase, labelText, segOption, segTrack } from '../panel-style'
import { settingDef } from './settings-registry'

/**
 * The building blocks every Form settings section uses: one `Setting` row per
 * registry key (label + effect sentence + control, stamped `data-setting`), and
 * small controls — a switch, a segmented choice and a searchable pick list —
 * that work without native <select>.
 */

/** Keys the search box and layout type leave visible; null = every key. */
export const VisibleSettingsContext = createContext<Set<string> | null>(null)

export function useSettingVisible(key: string): boolean {
  const visible = useContext(VisibleSettingsContext)
  return !visible || visible.has(key)
}

export const inputCls = inputBase

export const smallBtn =
  'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'

export const quietText = effectText

/**
 * One setting: its label and the sentence saying what it does, the control on the
 * right (`control`) or underneath (`children`). Renders nothing while the search
 * box or the layout type hides it.
 */
export function Setting({
  k,
  control,
  children,
  note,
  htmlFor
}: {
  k: string
  control?: ReactNode
  children?: ReactNode
  note?: ReactNode
  htmlFor?: string
}) {
  const visible = useSettingVisible(k)
  const def = settingDef(k)
  if (!visible || !def) return null
  // Only a switch sits on the label line; every other control goes under the
  // label at full width, as in the inspector.
  const inline = isValidElement(control) && control.type === Toggle
  return (
    <div data-setting={k} className='space-y-1.5'>
      <div className='flex min-h-5 items-center justify-between gap-3'>
        <label htmlFor={htmlFor} className={cn(labelText, 'min-w-0')}>
          {def.label}
        </label>
        {inline && <div className='flex shrink-0 items-center'>{control}</div>}
      </div>
      {control && !inline && <div>{control}</div>}
      {children}
      <p className={quietText}>{def.effect}</p>
      {note && <div className={quietText}>{note}</div>}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-nvr-cyan' : 'bg-slate-300 dark:bg-slate-600'
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-[16px]' : 'translate-x-[2px]'
        )}
      />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (next: T) => void
  ariaLabel: string
  disabled?: boolean
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className={cn('m-0 min-w-0 border-0', segTrack(options.length))}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type='button'
          aria-pressed={value === o.value}
          disabled={disabled}
          onClick={() => value !== o.value && onChange(o.value)}
          className={segOption(value === o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  )
}

export interface PickOption {
  value: string
  label: string
  /** Secondary text (the key, a type) shown quietly after the label. */
  hint?: string
}

/**
 * A searchable list in a popover anchored to its button. Commits on pick. The
 * list is a Command (cmdk): typing filters, arrow keys move, Enter picks.
 */
export function PickList({
  value,
  options,
  onChange,
  placeholder = 'Pick…',
  clearLabel,
  ariaLabel,
  disabled,
  className,
  emptyText = 'Nothing to pick'
}: {
  value: string | null
  options: PickOption[]
  onChange: (next: string | null) => void
  placeholder?: string
  /** Offer a "none" entry with this label. */
  clearLabel?: string
  ariaLabel: string
  disabled?: boolean
  className?: string
  emptyText?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  const pick = (v: string | null) => {
    onChange(v)
    setOpen(false)
  }
  const item =
    'gap-1.5 px-2 py-1 text-[12px] text-slate-700 data-[selected=true]:bg-muted dark:text-foreground'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={ariaLabel}
          disabled={disabled}
          data-pick-list={ariaLabel}
          className={cn(
            inputBase,
            'flex min-w-[140px] items-center justify-between gap-1.5 text-left hover:border-slate-300',
            className
          )}
        >
          <span
            className={cn(
              'truncate',
              selected ? 'text-slate-800 dark:text-foreground' : 'text-slate-500'
            )}
          >
            {selected?.label ?? (value ? value : (clearLabel ?? placeholder))}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-500' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-64 p-0' align='end'>
        <Command>
          <CommandInput
            placeholder='Search…'
            aria-label={`Search ${ariaLabel}`}
            className='h-8 text-[12px]'
          />
          <CommandList className='max-h-60' aria-label={ariaLabel}>
            <CommandEmpty className='px-2 py-1.5 text-[12px] text-slate-500 dark:text-slate-400'>
              {emptyText}
            </CommandEmpty>
            {clearLabel && (
              <CommandItem
                value='—none—'
                keywords={[clearLabel]}
                onSelect={() => pick(null)}
                className={cn(item, 'text-slate-500 dark:text-slate-400')}
              >
                <Check className={cn('h-3 w-3', value ? 'opacity-0' : 'opacity-100')} />
                <span>{clearLabel}</span>
              </CommandItem>
            )}
            {options.map((o) => (
              <CommandItem
                key={o.value}
                // The value keeps entries apart; label and hint are what is searched.
                value={o.value}
                keywords={[o.label, o.hint ?? '']}
                data-option={o.value}
                onSelect={() => pick(o.value)}
                className={cn(item, o.value === value && 'bg-accent')}
              >
                <Check
                  className={cn(
                    'h-3 w-3 shrink-0',
                    o.value === value ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className='min-w-0 flex-1 truncate'>{o.label}</span>
                {o.hint && (
                  <span className='shrink-0 font-mono text-[11px] text-slate-500 dark:text-slate-400'>
                    {o.hint}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A removable name chip (roles, fields). */
export function Chip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className='inline-flex max-w-full items-center gap-1 rounded bg-nvr-cyan/10 px-1.5 py-0.5 text-[12px] font-medium text-nvr-navy dark:text-nvr-cyan'>
      <span className='truncate'>{label}</span>
      {onRemove && (
        <button
          type='button'
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className='shrink-0 opacity-70 hover:opacity-100'
        >
          <X className='h-3 w-3' />
        </button>
      )}
    </span>
  )
}

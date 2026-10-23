import { Check } from 'lucide-react'
import {
  type ComponentPropsWithoutRef,
  createContext,
  forwardRef,
  type ReactNode,
  useContext,
  useState
} from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { PathNames } from './labels'

// ─── Field-map context: what every row may need, without prop drilling ──────

export interface LookupInfo {
  key: string
  /** The collection the lookup reads, when the template says. */
  collection?: string
}

export interface FieldMapEnv {
  collection: string
  lookups: LookupInfo[]
  secretNames: string[]
  partner: string
  /** Where the API's Body secrets card lives (null when unknown). */
  secretsHref: string | null
  /** Collection display names for path labels (null until loaded / outside the editor). */
  names?: PathNames | null
}

export const FieldMapEnvContext = createContext<FieldMapEnv>({
  collection: '',
  lookups: [],
  secretNames: [],
  partner: 'the partner',
  secretsHref: null
})

export function useFieldMapEnv(): FieldMapEnv {
  return useContext(FieldMapEnvContext)
}

/** Where a value sits: the nearest list's item alias and its rows' collection. */
export interface ItemScope {
  alias: string
  collection?: string
}

// ─── Popover shell ───────────────────────────────────────────────────────────

/**
 * Every field-map popover: portals to body (Radix), marked so the map's
 * undo shortcut still works inside it, flat surface + the one floating shadow.
 */
export const FmPopoverContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof PopoverContent>
>(({ className, children, ...props }, ref) => (
  <PopoverContent
    ref={ref}
    align='start'
    collisionPadding={12}
    data-field-map-popover=''
    className={cn(
      'w-[360px] max-w-[calc(100vw-24px)] rounded-lg border-slate-200 bg-white p-0 text-[12.5px] text-slate-700 shadow-[0_4px_16px_rgba(0,0,0,0.10),0_1px_4px_rgba(0,0,0,0.06)] dark:border-border dark:bg-popover dark:text-slate-200',
      className
    )}
    {...props}
  >
    {children}
  </PopoverContent>
))
FmPopoverContent.displayName = 'FmPopoverContent'

// ─── Inputs ──────────────────────────────────────────────────────────────────

export const fmInput =
  'h-7 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] text-slate-900 placeholder:text-slate-500 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-slate-400'

/** Commits on every keystroke (popover inputs never wait for blur). */
export function TextField({
  value,
  onChange,
  mono,
  className,
  ...rest
}: Omit<ComponentPropsWithoutRef<'input'>, 'value' | 'onChange'> & {
  value: string
  onChange: (v: string) => void
  mono?: boolean
}) {
  return (
    <input
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      autoComplete='off'
      className={cn(fmInput, mono && 'font-mono text-[12px]', className)}
    />
  )
}

/** A number box that keeps half-typed text ("-", "") until it parses. */
export function NumberField({
  value,
  onChange,
  className,
  placeholder,
  ariaLabel,
  min
}: {
  value: number | undefined
  onChange: (v: number | undefined) => void
  className?: string
  placeholder?: string
  ariaLabel?: string
  min?: number
}) {
  const [text, setText] = useState(value == null ? '' : String(value))
  const [seen, setSeen] = useState(value)
  // An outside change (undo, another control) replaces the text; our own echo does not.
  if (value !== seen) {
    setSeen(value)
    const ours = value == null ? text.trim() === '' : text.trim() !== '' && Number(text) === value
    if (!ours) setText(value == null ? '' : String(value))
  }
  return (
    <input
      inputMode='decimal'
      aria-label={ariaLabel}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        if (t.trim() === '') onChange(undefined)
        else if (Number.isFinite(Number(t))) {
          const n = Number(t)
          onChange(min != null && n < min ? min : n)
        }
      }}
      className={cn(fmInput, 'font-mono text-[12px] tabular-nums', className)}
    />
  )
}

export function FmLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'mb-1 block text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground',
        className
      )}
    >
      {children}
    </span>
  )
}

/** A labelled control: `<FmField label='Length'><NumberField … /></FmField>`. */
export function FmField({
  label,
  children,
  className
}: {
  label: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control arrives as children
    <label className={cn('block', className)}>
      <FmLabel>{label}</FmLabel>
      {children}
    </label>
  )
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground',
        className
      )}
    >
      {children}
    </p>
  )
}

// ─── Option menu (Combobox — never a native select) ─────────────────────────

export interface MenuOption<T extends string> {
  value: T
  label: string
  hint?: string
  disabled?: boolean
  tip?: string
}

export function OptionMenu<T extends string>({
  value,
  options,
  onSelect,
  children,
  search,
  width = 'w-[240px]',
  disabled,
  ariaLabel,
  triggerClassName,
  tip
}: {
  value?: T | null
  options: MenuOption<T>[]
  onSelect: (v: T) => void
  children: ReactNode
  search?: string
  width?: string
  disabled?: boolean
  ariaLabel?: string
  triggerClassName?: string
  tip?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The tip sits on a wrapper: a disabled button gets no pointer events. */}
      <span className='inline-flex shrink-0' data-tip={tip}>
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type='button'
            aria-label={ariaLabel}
            disabled={disabled}
            className={triggerClassName}
          >
            {children}
          </button>
        </PopoverTrigger>
      </span>
      <FmPopoverContent className={cn('p-0', width)}>
        <Command>
          {search && <CommandInput placeholder={search} className='h-9 text-[12.5px]' />}
          <CommandList className='max-h-[280px]'>
            {search && (
              <CommandEmpty className='py-4 text-center text-[12px]'>No match</CommandEmpty>
            )}
            <CommandGroup className='p-1'>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={`${o.label} ${o.value}`}
                  disabled={o.disabled}
                  onSelect={() => {
                    onSelect(o.value)
                    setOpen(false)
                  }}
                  className='flex items-start gap-2 rounded px-2 py-1.5 text-[12.5px] aria-selected:bg-accent'
                  data-tip={o.tip}
                >
                  <Check
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0 text-nvr-cyan',
                      o.value === value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className='min-w-0'>
                    <span className='block text-slate-800 dark:text-foreground'>{o.label}</span>
                    {o.hint && (
                      <span className='block text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                        {o.hint}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </FmPopoverContent>
    </Popover>
  )
}

/** Quiet inline control (type, include, rules): text-sized, border only on hover/focus. */
export const quietButton =
  'inline-flex h-6 max-w-full items-center gap-1 rounded px-1.5 text-[12px] text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:text-slate-500 disabled:hover:bg-transparent disabled:hover:text-slate-500 dark:text-muted-foreground dark:disabled:hover:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'

export const smallAction =
  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-300 dark:hover:bg-muted dark:hover:text-foreground'

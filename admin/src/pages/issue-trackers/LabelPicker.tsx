import { Check, ChevronsUpDown, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
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
import { cleanLabel, type GitlabLabel, isNewLabel } from './api'

/**
 * GitLab label picker fed by the project's labels. A name the project does not
 * have can be typed; it is marked "new" because GitLab creates it the first
 * time Nivaro uses it. `multi` holds a list, otherwise one label (or none).
 */
type Props = {
  labels: GitlabLabel[] | undefined
  /** Labels could not be listed (no project yet, GitLab unreachable): typing still works. */
  unavailable?: string | null
  placeholder?: string
  ariaLabel: string
  disabled?: boolean
  className?: string
} & (
  | { multi: true; value: string[]; onChange: (v: string[]) => void }
  | { multi?: false; value: string | undefined; onChange: (v: string | undefined) => void }
)

const SHOWN = 60

function Swatch({ color }: { color?: string }) {
  return (
    <span
      aria-hidden
      className='h-2.5 w-2.5 shrink-0 rounded-full border border-black/10 dark:border-white/15'
      style={{ backgroundColor: color || 'transparent' }}
    />
  )
}

export function NewTag() {
  return (
    <span
      data-tip='Not in GitLab yet. GitLab creates it the first time Nivaro uses it.'
      className='rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
    >
      will be created in GitLab
    </span>
  )
}

export function LabelPicker(props: Props) {
  const { labels, unavailable, placeholder, ariaLabel, disabled, className } = props
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const selected = props.multi ? props.value : props.value ? [props.value] : []
  const colorOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of labels ?? []) m.set(l.name.toLowerCase(), l.color)
    return m
  }, [labels])

  const typed = cleanLabel(search)
  const q = typed.toLowerCase()
  const matches = (labels ?? []).filter((l) => !q || l.name.toLowerCase().includes(q))
  const exact =
    !!typed &&
    ((labels ?? []).some((l) => l.name.toLowerCase() === q) ||
      selected.some((s) => s.toLowerCase() === q))

  const has = (name: string) => selected.some((s) => s.toLowerCase() === name.toLowerCase())

  const pick = (name: string) => {
    if (props.multi) {
      props.onChange(
        has(name)
          ? props.value.filter((s) => s.toLowerCase() !== name.toLowerCase())
          : [...props.value, name]
      )
    } else {
      props.onChange(has(name) ? undefined : name)
      setOpen(false)
    }
    setSearch('')
  }

  const remove = (name: string) => {
    if (props.multi) props.onChange(props.value.filter((s) => s !== name))
    else props.onChange(undefined)
  }

  return (
    <div className={cn('min-w-0', className)}>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setSearch('')
        }}
      >
        {props.multi ? (
          <div
            className={cn(
              'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1',
              disabled && 'opacity-50'
            )}
          >
            {selected.map((name) => (
              <span
                key={name}
                className='inline-flex max-w-full items-center gap-1 rounded border border-slate-200 bg-slate-50 py-px pl-1.5 pr-0.5 text-[11.5px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'
              >
                <Swatch color={colorOf.get(name.toLowerCase())} />
                <span className='truncate'>{name}</span>
                {isNewLabel(name, labels) && <NewTag />}
                {!disabled && (
                  <button
                    type='button'
                    aria-label={`Remove ${name}`}
                    onClick={() => remove(name)}
                    className='rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted dark:hover:text-slate-100'
                  >
                    <X className='h-3 w-3' />
                  </button>
                )}
              </span>
            ))}
            <PopoverTrigger asChild>
              <button
                type='button'
                role='combobox'
                aria-expanded={open}
                aria-label={ariaLabel}
                disabled={disabled}
                className='inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:cursor-not-allowed dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
              >
                <Plus className='h-3 w-3' />
                {selected.length ? 'Add' : (placeholder ?? 'Add label')}
              </button>
            </PopoverTrigger>
          </div>
        ) : (
          <PopoverTrigger asChild>
            <button
              type='button'
              role='combobox'
              aria-expanded={open}
              aria-label={ariaLabel}
              disabled={disabled}
              className='flex h-8 w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 text-left text-[12px] transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-muted/50'
            >
              {props.value ? (
                <span className='flex min-w-0 flex-1 items-center gap-1.5'>
                  <Swatch color={colorOf.get(props.value.toLowerCase())} />
                  <span className='truncate text-slate-800 dark:text-slate-100'>{props.value}</span>
                  {isNewLabel(props.value, labels) && <NewTag />}
                </span>
              ) : (
                <span className='flex-1 text-muted-foreground'>{placeholder ?? 'No label'}</span>
              )}
              <ChevronsUpDown className='h-3 w-3 shrink-0 opacity-50' />
            </button>
          </PopoverTrigger>
        )}
        <PopoverContent className='w-[300px] p-0' align='start'>
          <Command shouldFilter={false}>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder='Find or type a label…'
              className='h-8 text-[12px]'
            />
            <CommandList>
              {unavailable && (
                <p className='border-b border-slate-100 px-3 py-2 text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                  {unavailable}
                </p>
              )}
              <CommandEmpty className='px-3 py-4 text-center text-[12px] text-muted-foreground'>
                {labels?.length ? 'No label matches.' : 'Type a label name.'}
              </CommandEmpty>
              {!props.multi && props.value && !typed && (
                <CommandGroup>
                  <CommandItem value='__none__' onSelect={() => remove(props.value as string)}>
                    <X className='h-3.5 w-3.5 text-slate-400' />
                    <span className='text-[12px] text-muted-foreground'>No label</span>
                  </CommandItem>
                </CommandGroup>
              )}
              {typed && !exact && (
                <CommandGroup>
                  <CommandItem value={`__new__${typed}`} onSelect={() => pick(typed)}>
                    <Plus className='h-3.5 w-3.5 text-nvr-cyan' />
                    <span className='truncate text-[12px]'>Use “{typed}”</span>
                    {isNewLabel(typed, labels) && <NewTag />}
                  </CommandItem>
                </CommandGroup>
              )}
              {matches.length > 0 && (
                <CommandGroup>
                  {matches.slice(0, SHOWN).map((l) => (
                    <CommandItem key={l.name} value={l.name} onSelect={() => pick(l.name)}>
                      <Swatch color={l.color} />
                      <span className='flex-1 truncate text-[12px]'>{l.name}</span>
                      <Check
                        className={cn(
                          'h-3.5 w-3.5 text-nvr-cyan',
                          has(l.name) ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  ))}
                  {matches.length > SHOWN && (
                    <p className='px-3 py-1.5 text-[11px] text-muted-foreground'>
                      {matches.length - SHOWN} more — keep typing to narrow.
                    </p>
                  )}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

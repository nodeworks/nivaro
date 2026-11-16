import { Check, ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../lib/utils'
import { UserAvatar } from '../UserAvatar'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { initialsOf } from './support-list'

export interface PickChoice {
  value: string
  label: string
  /** A person: shows their avatar. */
  person?: boolean
  /** Muted text after the label ("11 open"). */
  hint?: string
}

/** A small initials disc with the person's photo when they have one. */
export function PersonDisc({
  id,
  name,
  size = 20
}: {
  id: string | null | undefined
  name: string | null | undefined
  size?: number
}) {
  const style = { width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)) }
  return (
    <UserAvatar
      userId={id}
      style={style}
      className='shrink-0 rounded-full object-cover'
      alt=''
      fallback={
        <span
          aria-hidden
          style={style}
          className='inline-flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-700 dark:bg-white/15 dark:text-slate-100'
        >
          {initialsOf(name)}
        </span>
      }
    />
  )
}

/**
 * A searchable pick of fixed choices (Anyone / Me / Unassigned) and people. The trigger is the
 * caller's (a filter chip, a bulk-bar button); the list commits on select.
 */
export function PersonPick({
  value,
  fixed,
  people,
  onPick,
  trigger,
  ariaLabel,
  placeholder = 'Find a person',
  align = 'start'
}: {
  value: string
  fixed: PickChoice[]
  people: PickChoice[]
  onPick: (value: string, label: string) => void
  trigger: ReactNode
  ariaLabel: string
  placeholder?: string
  align?: 'start' | 'end' | 'center'
}) {
  const [open, setOpen] = useState(false)
  const row = (c: PickChoice) => (
    <CommandItem
      key={c.value || '__any'}
      value={`${c.label} ${c.value}`}
      onSelect={() => {
        onPick(c.value, c.label)
        setOpen(false)
      }}
      className='gap-2 text-[12.5px]'
    >
      {c.person ? <PersonDisc id={c.value} name={c.label} size={18} /> : null}
      <span className='min-w-0 flex-1 truncate'>{c.label}</span>
      {c.hint ? (
        <span className='shrink-0 text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {c.hint}
        </span>
      ) : null}
      <Check
        className={cn('h-3.5 w-3.5 shrink-0', value === c.value ? 'opacity-100' : 'opacity-0')}
      />
    </CommandItem>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild aria-label={ariaLabel}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent align={align} className='w-64 p-0'>
        <Command>
          <CommandInput placeholder={placeholder} className='h-9 text-[12.5px]' />
          <CommandList className='max-h-72'>
            <CommandEmpty className='py-4 text-center text-[12px] text-slate-500'>
              Nobody by that name
            </CommandEmpty>
            {fixed.length ? <CommandGroup>{fixed.map(row)}</CommandGroup> : null}
            {fixed.length && people.length ? <CommandSeparator /> : null}
            {people.length ? <CommandGroup heading='People'>{people.map(row)}</CommandGroup> : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** The look of a toolbar control that opens a list (matches the SimpleSelect triggers). */
export const PICK_TRIGGER =
  'inline-flex h-8 max-w-[14rem] items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-700 hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200 dark:hover:border-slate-500'

export function PickCaret() {
  return <ChevronDown className='h-3.5 w-3.5 shrink-0 opacity-60' />
}

import { useQuery } from '@tanstack/react-query'
import { Check, Headphones, UserPlus } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { huddleCalls } from './huddle-calls'

/**
 * People who could be added to a room's huddle (#2844, #2860): the search is
 * answered by the server, which lists only people who can see THAT room —
 * the picker never learns of anyone else.
 */

export interface HuddlePerson {
  id: string
  name: string
  title: string | null
  in_huddle: boolean
}

export function useHuddlePeople(room: string | null, q: string, enabled = true) {
  const client = useNivaroClient()
  const [debounced, setDebounced] = useState(q)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 180)
    return () => clearTimeout(t)
  }, [q])
  return useQuery({
    queryKey: ['nvr-huddle-people', room, debounced],
    queryFn: () =>
      client
        .request<{ data: HuddlePerson[] }>(
          get('/chat/huddle/people', { room: room as string, q: debounced })
        )
        .then((r) => r.data),
    enabled: enabled && !!room,
    staleTime: 20_000,
    placeholderData: (prev) => prev
  })
}

const rowClass =
  'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-slate-700 aria-selected:bg-muted dark:text-slate-200'

/**
 * The searchable list itself — the invite popover and the schedule form share
 * it. `selected` marks rows; `onPick` runs on a click.
 */
export function HuddlePeopleList({
  room,
  selected,
  onPick,
  renderAvatar,
  placeholder = 'Search people…',
  excludeInHuddle
}: {
  room: string
  selected: ReadonlySet<string>
  onPick: (p: HuddlePerson) => void
  renderAvatar: (id: string, name: string | null) => ReactNode
  placeholder?: string
  /** People already in the huddle read as "here" and cannot be picked. */
  excludeInHuddle?: boolean
}) {
  const [q, setQ] = useState('')
  const { data, isLoading, isError } = useHuddlePeople(room, q)
  return (
    <Command shouldFilter={false} className='bg-transparent'>
      <CommandInput
        value={q}
        onValueChange={setQ}
        placeholder={placeholder}
        className='h-8 text-[12.5px]'
      />
      <CommandList className='max-h-[220px]'>
        {isLoading && !data && (
          <div className='space-y-1.5 p-2' aria-busy='true'>
            {[0, 1, 2].map((i) => (
              <div key={i} className='h-7 animate-pulse rounded-md bg-slate-100 dark:bg-white/5' />
            ))}
          </div>
        )}
        {isError && (
          <p className='px-2 py-3 text-[11.5px] text-red-600 dark:text-red-300'>
            Could not load people. Try again in a moment.
          </p>
        )}
        {data && data.length === 0 && (
          <CommandEmpty className='py-4 text-[11.5px] text-slate-500 dark:text-slate-400'>
            {q ? 'Nobody with that name can see this room.' : 'Nobody else can see this room.'}
          </CommandEmpty>
        )}
        {data && data.length > 0 && (
          <CommandGroup>
            {data.map((p) => {
              const here = !!excludeInHuddle && p.in_huddle
              const on = selected.has(p.id.toUpperCase())
              return (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  disabled={here}
                  onSelect={() => !here && onPick(p)}
                  className={cn(rowClass, here && 'opacity-50')}
                  data-huddle-person-row={p.id}
                >
                  <span style={{ lineHeight: 0 }}>{renderAvatar(p.id, p.name)}</span>
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate'>{p.name}</span>
                    {p.title && (
                      <span className='block truncate text-[11px] text-slate-500 dark:text-slate-400'>
                        {p.title}
                      </span>
                    )}
                  </span>
                  {here ? (
                    <span className='flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400'>
                      <Headphones className='h-3 w-3 text-nvr-cyan' strokeWidth={2} /> here
                    </span>
                  ) : on ? (
                    <Check
                      className='h-3.5 w-3.5 text-nvr-cyan'
                      strokeWidth={2.25}
                      aria-label='Selected'
                    />
                  ) : null}
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  )
}

/** The "Add people" button in the stage: pick someone, they are rung (#2844). */
export function HuddleInviteButton({
  room,
  renderAvatar,
  className
}: {
  room: string
  renderAvatar: (id: string, name: string | null) => ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-300 dark:hover:bg-white/10',
            open && 'bg-slate-200/70 dark:bg-white/10',
            className
          )}
          aria-label='Add people to the huddle'
          data-tip='Add people — they get a call'
          data-huddle-invite
        >
          <UserPlus className='h-3.5 w-3.5' strokeWidth={2} />
          Add people
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[280px] p-1' data-huddle-invite-picker>
        <HuddlePeopleList
          room={room}
          selected={new Set()}
          excludeInHuddle
          renderAvatar={renderAvatar}
          placeholder='Who should join?'
          onPick={(p) => {
            huddleCalls.invite(room, [p.id])
            toast(`Ringing ${p.name}`, { description: 'They get a call and a notification.' })
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

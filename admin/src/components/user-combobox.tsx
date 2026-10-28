import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, type User } from '@/lib/api'
import { cn } from '@/lib/utils'

function userLabel(u: User): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name ? `${name} · ${u.email}` : u.email
}

/**
 * Combobox (Popover + Command) for selecting a single user. Fetches
 * GET /users?limit=200 and shows name + email. Never a native <select>.
 * `searchServer` asks GET /users?search= as the admin types instead — for
 * pickers that must reach everyone, not only the first 200.
 */
export function UserCombobox({
  value,
  onChange,
  disabled,
  excludeId,
  placeholder = 'Select user…',
  noneLabel = 'No delegate',
  searchServer = false,
  hideNone = false,
  className
}: {
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
  excludeId?: string
  placeholder?: string
  /** The "clear selection" list item's label — the delegate-picker default
   *  reads oddly for any other caller (e.g. an external API's owner), so
   *  this is the whole component's own escape hatch rather than a copy. */
  noneLabel?: string
  /** Search the server as people type (every user), instead of the first 200. */
  searchServer?: boolean
  /** Leave out the "clear selection" item. */
  hideNone?: boolean
  /** Trigger button classes (size). */
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  // The picked person, kept for its label: a server search only lists matches.
  const [picked, setPicked] = useState<User | null>(null)

  const { data: users } = useQuery<User[]>({
    queryKey: ['users', 'combobox'],
    queryFn: () => api.get<{ data: User[] }>('/users?limit=200').then((r) => r.data.data),
    enabled: !searchServer
  })
  const { data: found, isFetching } = useQuery<User[]>({
    queryKey: ['users', 'combobox-search', term.trim()],
    queryFn: () =>
      api
        .get<{ data: User[] }>('/users', { params: { search: term.trim(), limit: 20 } })
        .then((r) => r.data.data),
    enabled: searchServer && open && term.trim().length >= 2,
    staleTime: 30_000
  })

  const options = ((searchServer ? found : users) ?? []).filter((u) => u.id !== excludeId)
  const selected =
    options.find((o) => o.id === value) ?? (picked && picked.id === value ? picked : undefined)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className={cn('h-9 w-full justify-between px-3 text-[13px] font-normal', className)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? userLabel(selected) : placeholder}
          </span>
          <ChevronsUpDown className='ml-1 h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-0' align='start'>
        <Command shouldFilter={!searchServer}>
          <CommandInput
            placeholder='Search users…'
            className='h-9 text-[13px]'
            {...(searchServer ? { value: term, onValueChange: setTerm } : {})}
          />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              {!searchServer
                ? 'No users found'
                : term.trim().length < 2
                  ? 'Type two letters of a name or email'
                  : isFetching
                    ? 'Searching…'
                    : 'No users found'}
            </CommandEmpty>
            <CommandGroup>
              {!hideNone && (
                <CommandItem
                  value='__none__'
                  onSelect={() => {
                    onChange(null)
                    setOpen(false)
                  }}
                  className='text-[13px]'
                >
                  <Check className={cn('mr-2 h-3.5 w-3.5', !value ? 'opacity-100' : 'opacity-0')} />
                  <span className='text-muted-foreground'>{noneLabel}</span>
                </CommandItem>
              )}
              {options.map((u) => (
                <CommandItem
                  key={u.id}
                  value={
                    searchServer ? u.id : `${u.first_name ?? ''} ${u.last_name ?? ''} ${u.email}`
                  }
                  onSelect={() => {
                    setPicked(u.id === value ? null : u)
                    onChange(u.id === value ? null : u.id)
                    setOpen(false)
                  }}
                  className='text-[13px]'
                >
                  <Check
                    className={cn('mr-2 h-3.5 w-3.5', value === u.id ? 'opacity-100' : 'opacity-0')}
                  />
                  {userLabel(u)}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

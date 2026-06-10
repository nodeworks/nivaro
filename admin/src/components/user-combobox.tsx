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
 */
export function UserCombobox({
  value,
  onChange,
  disabled,
  excludeId,
  placeholder = 'Select user…'
}: {
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
  excludeId?: string
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)

  const { data: users } = useQuery<User[]>({
    queryKey: ['users', 'combobox'],
    queryFn: () => api.get<{ data: User[] }>('/users?limit=200').then((r) => r.data.data)
  })

  const options = (users ?? []).filter((u) => u.id !== excludeId)
  const selected = options.find((o) => o.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className='h-9 w-full justify-between px-3 text-[13px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? userLabel(selected) : placeholder}
          </span>
          <ChevronsUpDown className='ml-1 h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search users…' className='h-9 text-[13px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No users found
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value='__none__'
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className='text-[13px]'
              >
                <Check className={cn('mr-2 h-3.5 w-3.5', !value ? 'opacity-100' : 'opacity-0')} />
                <span className='text-muted-foreground'>No delegate</span>
              </CommandItem>
              {options.map((u) => (
                <CommandItem
                  key={u.id}
                  value={`${u.first_name ?? ''} ${u.last_name ?? ''} ${u.email}`}
                  onSelect={() => {
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

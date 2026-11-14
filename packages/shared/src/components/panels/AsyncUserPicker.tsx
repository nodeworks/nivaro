import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Loader2, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { userCardQuery } from '../../lib/user-cards'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** Searchable person picker (the pipeline Owners "Add owner" form, the
 *  record's View as person bar). `value` is a user id, '' for none. */
export function AsyncUserPicker({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  type User = { id: string; first_name: string | null; last_name: string | null; email: string }
  const { data, isLoading } = useQuery<User[]>({
    queryKey: ['users', 'async-search', debouncedQuery],
    queryFn: () =>
      client
        .request<{ data: User[]; total: number }>(
          get('/users', {
            limit: 50,
            sort: 'first_name',
            ...(debouncedQuery ? { search: debouncedQuery } : {})
          })
        )
        .then((r) => r.data),
    enabled: open,
    staleTime: 30_000
  })
  // The directory card (any signed-in person), never GET /users/:id — that
  // is admin-only and left a non-admin looking at the picked person's raw id.
  const { data: selectedUser } = useQuery<User | null>({
    ...userCardQuery<User>(client, value),
    enabled: !!value,
    staleTime: 5 * 60_000
  })
  const users = data ?? []
  // The search row it was picked from answers at once; the card after.
  const picked = selectedUser ?? users.find((u) => u.id === value) ?? null
  const selectedLabel = picked
    ? [picked.first_name, picked.last_name].filter(Boolean).join(' ').trim() || picked.email
    : value
      ? 'Selected person'
      : null
  const nameOf = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(' ').trim()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className='relative flex h-8 w-full'>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex h-full w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[13px] text-slate-700 hover:border-slate-300'
          >
            <span className={`flex-1 truncate ${selectedLabel ? '' : 'text-slate-400'}`}>
              {selectedLabel ?? 'Select a user…'}
            </span>
            <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          </button>
        </PopoverTrigger>
        {value && (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
            className='absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
          >
            <X className='h-3 w-3' />
          </button>
        )}
      </div>
      <PopoverContent align='start' className='w-72 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search users…'
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40'
            />
          </div>
        </div>
        <div className='max-h-56 overflow-y-auto py-1'>
          {isLoading ? (
            <div className='flex items-center gap-2 px-3 py-2 text-[12px] text-slate-400'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
              Loading…
            </div>
          ) : users.length === 0 ? (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          ) : (
            users.map((u) => {
              const name = nameOf(u)
              const label = name ? `${name} (${u.email})` : u.email
              const selected = u.id === value
              return (
                <button
                  key={u.id}
                  type='button'
                  onClick={() => {
                    onChange(u.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 ${selected ? 'font-medium text-slate-800' : 'text-slate-600'}`}
                >
                  <Check
                    className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-nvr-cyan' : 'opacity-0'}`}
                  />
                  {label}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

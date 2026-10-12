import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Hash, Loader2, Send, UserPlus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
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
import { api } from '@/lib/api'

/**
 * Share an Ask AI conversation with people (#1809) and post it to a chat
 * room (#1851). Both only hand over ACCESS to the thread: whoever opens it
 * reads each answer only when it re-runs to the same result with their own
 * permissions, and their own follow-ups run as them.
 */

export interface ShareRow {
  id: number
  user: { id: string; name: string } | null
  room: string | null
  created_at: string
}

const errorOf = (err: unknown) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed'

export function ShareMenu({
  conversationId,
  shares,
  detailKey
}: {
  conversationId: string
  shares: ShareRow[]
  detailKey: readonly unknown[]
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const { data: people = [], isFetching } = useQuery({
    queryKey: ['ask-share-people', search],
    queryFn: () =>
      api
        .get<{
          data: Array<{ id: string; first_name?: string; last_name?: string; email: string }>
        }>('/users', { params: { search: search || undefined, people: 1, limit: 20 } })
        .then((r) => r.data.data),
    enabled: open
  })
  const sharedIds = new Set(shares.map((s) => s.user?.id.toUpperCase()).filter(Boolean))
  const add = useMutation({
    mutationFn: (userId: string) =>
      api.post(`/ai/conversations/${conversationId}/shares`, { user_ids: [userId] }),
    onSuccess: () => {
      toast.success('Shared — they can read it and ask follow-ups with their own access')
      void qc.invalidateQueries({ queryKey: detailKey })
    },
    onError: (err) => toast.error(errorOf(err))
  })
  const remove = useMutation({
    mutationFn: (shareId: number) =>
      api.delete(`/ai/conversations/${conversationId}/shares/${shareId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: detailKey })
  })
  const people_shares = shares.filter((s) => s.user)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size='sm' variant='ghost' data-ask-share>
          <UserPlus className='mr-1 h-3.5 w-3.5' />
          Share{people_shares.length ? ` (${people_shares.length})` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-80 p-0'>
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder='Find a colleague…' />
          <CommandList>
            <CommandEmpty>{isFetching ? 'Searching…' : 'Nobody found.'}</CommandEmpty>
            <CommandGroup>
              {people
                .filter((p) => !sharedIds.has(p.id.toUpperCase()))
                .map((p) => {
                  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email
                  return (
                    <CommandItem key={p.id} value={p.id} onSelect={() => add.mutate(p.id)}>
                      <span className='truncate text-[12.5px]'>{name}</span>
                      <span className='ml-auto truncate text-[11px] text-muted-foreground'>
                        {p.email}
                      </span>
                    </CommandItem>
                  )
                })}
            </CommandGroup>
          </CommandList>
        </Command>
        {people_shares.length > 0 && (
          <div className='border-t border-slate-200 p-2 dark:border-border'>
            <p className='px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground'>
              Shared with
            </p>
            {people_shares.map((s) => (
              <div
                key={s.id}
                className='flex items-center gap-2 rounded px-1 py-0.5 hover:bg-muted'
              >
                <span className='min-w-0 flex-1 truncate text-[12.5px]'>{s.user?.name}</span>
                <button
                  type='button'
                  onClick={() => remove.mutate(s.id)}
                  className='rounded p-0.5 text-slate-400 hover:text-red-600'
                  aria-label={`Stop sharing with ${s.user?.name}`}
                >
                  <X className='h-3 w-3' />
                </button>
              </div>
            ))}
          </div>
        )}
        <p className='border-t border-slate-200 px-3 py-2 text-[11px] text-muted-foreground dark:border-border'>
          Each person sees an answer only when it holds nothing outside their own access.
        </p>
      </PopoverContent>
    </Popover>
  )
}

interface RoomRow {
  room: string
  kind: string
  label: string | null
  archived: boolean
}

export function PostToChatMenu({
  conversationId,
  detailKey
}: {
  conversationId: string
  detailKey: readonly unknown[]
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { data: rooms = [], isLoading } = useQuery({
    queryKey: ['ask-post-rooms'],
    queryFn: () => api.get<{ data: RoomRow[] }>('/chat/rooms').then((r) => r.data.data),
    enabled: open
  })
  const post = useMutation({
    mutationFn: (room: string) => api.post(`/ai/conversations/${conversationId}/post`, { room }),
    onSuccess: () => {
      setOpen(false)
      toast.success('Posted — readers see answers re-checked against their own access')
      void qc.invalidateQueries({ queryKey: detailKey })
    },
    onError: (err) => toast.error(errorOf(err))
  })
  const KIND: Record<string, string> = {
    global: 'Channels',
    channel: 'Channels',
    dm: 'Direct messages',
    entity: 'Record rooms'
  }
  const groups = new Map<string, RoomRow[]>()
  for (const r of rooms.filter((x) => !x.archived)) {
    const g = KIND[r.kind] ?? 'Other'
    groups.set(g, [...(groups.get(g) ?? []), r])
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size='sm' variant='ghost' data-ask-post>
          <Send className='mr-1 h-3.5 w-3.5' />
          Post to chat
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 p-0'>
        <Command>
          <CommandInput placeholder='Channel, person or record room…' />
          <CommandList>
            <CommandEmpty>{isLoading ? 'Loading rooms…' : 'No room found.'}</CommandEmpty>
            {[...groups.entries()].map(([g, list]) => (
              <CommandGroup key={g} heading={g}>
                {list.map((r) => (
                  <CommandItem
                    key={r.room}
                    value={`${r.label ?? r.room} ${r.room}`}
                    onSelect={() => post.mutate(r.room)}
                    disabled={post.isPending}
                  >
                    <Hash className='h-3.5 w-3.5 text-slate-400' />
                    <span className='truncate text-[12.5px]'>{r.label ?? r.room}</span>
                    {post.isPending && post.variables === r.room && (
                      <Loader2 className='ml-auto h-3 w-3 animate-spin' />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

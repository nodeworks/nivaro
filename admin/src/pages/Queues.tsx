import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Inbox, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

type SourceType = 'collection' | 'tasks' | 'approvals' | 'owned_by_me'

interface QueueSource {
  id?: number
  type: SourceType
  collection: string | null
  filters: unknown
  state_values: string[] | null
  sort: number
}

interface Queue {
  id: string
  name: string
  description: string | null
  owner: string
  is_shared: boolean
  role_id: string | null
  view_mode: 'table' | 'kanban' | 'both'
  is_active: boolean
}

interface QueueDetailData extends Queue {
  sources: QueueSource[]
}

const SOURCE_TYPE_OPTIONS: { value: SourceType; label: string }[] = [
  { value: 'owned_by_me', label: 'Owned by me (auto)' },
  { value: 'collection', label: 'Collection' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'approvals', label: 'Approvals' }
]

// ─── Combobox helper (mirrors Hierarchies.tsx FieldCombobox) ──────────────────

function FieldCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className='h-8 w-full justify-between px-2 text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── List item ──────────────────────────────────────────────────────────────

function QueueListItem({
  queue,
  selected,
  onSelect
}: {
  queue: Queue
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type='button'
        onClick={onSelect}
        className={cn(
          'block w-full px-4 py-3 text-left transition-colors',
          selected
            ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/[0.07]'
            : 'hover:bg-slate-50 dark:hover:bg-muted/50'
        )}
      >
        <div className='flex items-center gap-2'>
          <Inbox className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <span
            className={cn(
              'flex-1 truncate text-[13px] font-medium',
              selected ? 'text-nvr-navy dark:text-nvr-cyan' : 'text-slate-700 dark:text-slate-300'
            )}
          >
            {queue.name}
          </span>
          {queue.is_shared && (
            <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-muted'>
              Shared
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

// ─── Source row editor ──────────────────────────────────────────────────────

function SourceRow({
  source,
  collectionOptions,
  onChange,
  onRemove,
  canEdit
}: {
  source: QueueSource
  collectionOptions: { value: string; label: string }[]
  onChange: (next: QueueSource) => void
  onRemove: () => void
  canEdit: boolean
}) {
  return (
    <div className='flex items-start gap-2 rounded-md border border-slate-200 p-2 dark:border-border'>
      <div className='w-44 shrink-0'>
        <FieldCombobox
          value={source.type}
          onChange={(v) =>
            onChange({
              ...source,
              type: v as SourceType,
              collection: v === 'collection' ? source.collection : null
            })
          }
          options={SOURCE_TYPE_OPTIONS}
          disabled={!canEdit}
        />
      </div>
      {source.type === 'collection' && (
        <div className='flex-1'>
          <FieldCombobox
            value={source.collection ?? ''}
            onChange={(v) => onChange({ ...source, collection: v || null })}
            options={collectionOptions}
            placeholder='Select collection…'
            disabled={!canEdit}
          />
        </div>
      )}
      {canEdit && (
        <Button
          variant='ghost'
          size='sm'
          className='h-8 w-8 shrink-0 p-0 text-slate-400 hover:text-red-500'
          onClick={onRemove}
        >
          <Trash2 className='h-3.5 w-3.5' />
        </Button>
      )}
    </div>
  )
}

// ─── Builder panel ──────────────────────────────────────────────────────────

function QueueBuilder({ queueId, onDeleted }: { queueId: string; onDeleted: () => void }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.is_admin ?? false

  const { data: queue } = useQuery<QueueDetailData>({
    queryKey: ['queue', queueId],
    queryFn: () => api.get(`/queues/${queueId}`).then((r) => r.data.data)
  })
  const { data: collections = [] } = useQuery<Array<{ collection: string }>>({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data)
  })

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isShared, setIsShared] = useState(false)
  const [sources, setSources] = useState<QueueSource[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  if (queue && loadedFor !== queue.id) {
    setName(queue.name)
    setDescription(queue.description ?? '')
    setIsShared(queue.is_shared)
    setSources(queue.sources)
    setLoadedFor(queue.id)
  }

  const collectionOptions = collections.map((c) => ({ value: c.collection, label: c.collection }))

  const saveMetaMut = useMutation({
    mutationFn: () => api.patch(`/queues/${queueId}`, { name, description, is_shared: isShared }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queues'] })
      qc.invalidateQueries({ queryKey: ['queue', queueId] })
      toast.success('Queue saved')
    },
    onError: () => toast.error('Failed to save queue')
  })

  const saveSourcesMut = useMutation({
    mutationFn: () =>
      api.patch(`/queues/${queueId}/sources`, {
        sources: sources.map((s, i) => ({ ...s, sort: i }))
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue', queueId] })
      toast.success('Sources saved')
    },
    onError: () =>
      toast.error('Failed to save sources — check each source has a collection selected')
  })

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/queues/${queueId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queues'] })
      toast.success('Queue deleted')
      onDeleted()
    },
    onError: () => toast.error('Failed to delete queue')
  })

  if (!queue) return <div className='p-6 text-[13px] text-slate-400'>Loading…</div>

  const canEdit = isAdmin || queue.owner === user?.id

  return (
    <div className='mx-auto max-w-2xl space-y-6 p-6'>
      <div className='flex items-center justify-between'>
        <h2 className='text-[15px] font-semibold text-slate-800 dark:text-slate-100'>Edit Queue</h2>
        <Link to={`/queues/${queueId}`}>
          <Button variant='outline' size='sm'>
            Open Worklist →
          </Button>
        </Link>
      </div>

      {!canEdit && (
        <p className='text-[11px] text-slate-400'>You do not own this queue — read only</p>
      )}

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500'>Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className='h-9 text-[13px]'
          disabled={!canEdit}
        />
      </div>

      <div className='space-y-1'>
        <Label className='text-[11px] text-slate-500'>Description</Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className='text-[13px]'
          rows={2}
          disabled={!canEdit}
        />
      </div>

      <div className='flex items-center gap-2'>
        <Checkbox
          checked={isShared}
          onCheckedChange={(v) => setIsShared(!!v)}
          id='is-shared'
          disabled={!canEdit}
        />
        <Label htmlFor='is-shared' className='text-[12px] text-slate-600'>
          Shared with everyone
        </Label>
      </div>

      {canEdit && (
        <Button size='sm' onClick={() => saveMetaMut.mutate()} disabled={saveMetaMut.isPending}>
          Save Details
        </Button>
      )}

      <div className='border-t border-slate-100 pt-4 dark:border-border'>
        <div className='mb-2 flex items-center justify-between'>
          <Label className='text-[11px] text-slate-500'>Sources</Label>
          {canEdit && (
            <Button
              variant='outline'
              size='sm'
              className='h-7 gap-1 text-[11px]'
              onClick={() =>
                setSources([
                  ...sources,
                  {
                    type: 'collection',
                    collection: null,
                    filters: null,
                    state_values: null,
                    sort: sources.length
                  }
                ])
              }
            >
              <Plus className='h-3 w-3' /> Add source
            </Button>
          )}
        </div>
        <div className='space-y-2'>
          {sources.map((s, i) => (
            <SourceRow
              key={s.id ?? `new-${i}`}
              source={s}
              collectionOptions={collectionOptions}
              onChange={(next) => setSources(sources.map((x, xi) => (xi === i ? next : x)))}
              onRemove={() => setSources(sources.filter((_, xi) => xi !== i))}
              canEdit={canEdit}
            />
          ))}
        </div>
        {canEdit && (
          <Button
            size='sm'
            className='mt-3'
            onClick={() => saveSourcesMut.mutate()}
            disabled={saveSourcesMut.isPending}
          >
            Save Sources
          </Button>
        )}
      </div>

      {canEdit && (
        <div className='border-t border-slate-100 pt-4 dark:border-border'>
          <Button
            variant='destructive'
            size='sm'
            onClick={() => deleteMut.mutate()}
            disabled={deleteMut.isPending}
          >
            Delete Queue
          </Button>
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function QueuesPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data: queues = [], isLoading } = useQuery<Queue[]>({
    queryKey: ['queues'],
    queryFn: () => api.get('/queues').then((r) => r.data.data)
  })

  const createMut = useMutation({
    mutationFn: () => api.post('/queues', { name: 'New Queue' }).then((r) => r.data.data as Queue),
    onSuccess: (queue) => {
      qc.invalidateQueries({ queryKey: ['queues'] })
      setSelectedId(queue.id)
      toast.success('Queue created')
    },
    onError: () => toast.error('Failed to create queue')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
            Queues
          </h1>
          <Button size='sm' onClick={() => createMut.mutate()}>
            <Plus className='mr-1.5 h-3.5 w-3.5' /> New Queue
          </Button>
        </div>
      </div>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='flex w-[272px] shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading ? (
            <div className='p-4 text-[12px] text-slate-400'>Loading…</div>
          ) : (
            <ul>
              {queues.map((q) => (
                <QueueListItem
                  key={q.id}
                  queue={q}
                  selected={q.id === selectedId}
                  onSelect={() => setSelectedId(q.id)}
                />
              ))}
            </ul>
          )}
        </aside>
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {selectedId ? (
            <QueueBuilder queueId={selectedId} onDeleted={() => setSelectedId(null)} />
          ) : (
            <div className='flex h-full items-center justify-center text-[13px] text-slate-400'>
              Select a queue or create a new one
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

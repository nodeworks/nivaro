import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  CheckSquare,
  ChevronsUpDown,
  ExternalLink,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Users
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { renderDisplayTemplate } from '@/lib/relations'
import { cn, formatDate } from '@/lib/utils'

interface CollectionMeta {
  collection: string
  name?: string | null
  display_name?: string | null
  display_template?: string | null
}

type Status = 'open' | 'in_progress' | 'done' | 'cancelled'
type Priority = 'low' | 'normal' | 'urgent'

interface Task {
  id: number
  kind?: string | null
  collection: string | null
  item: string | null
  item_label?: string | null
  title: string
  description: string | null
  assignee: string | null
  assignee_name: string | null
  team_id?: number | null
  team_name?: string | null
  due_date: string | null
  status: Status
  priority?: Priority
  created_by: string
  created_by_name: string | null
  completed_at: string | null
  completed_by_name?: string | null
  created_at: string
}

interface Person {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

const STATUS_META: Record<Status, { label: string; className: string }> = {
  open: {
    label: 'Open',
    className: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20'
  },
  in_progress: {
    label: 'In progress',
    className: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20'
  },
  done: {
    label: 'Done',
    className: 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20'
  },
  cancelled: { label: 'Cancelled', className: 'text-muted-foreground' }
}

const personName = (p: Person) =>
  [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || p.id
const collectionLabel = (c: CollectionMeta) => c.display_name || c.name || c.collection
const todayIso = () => new Date().toISOString().slice(0, 10)

/** Search-as-you-type picker over the server (never a truncated list). */
function SearchPicker<T>({
  placeholder,
  value,
  valueLabel,
  search,
  render,
  onPick,
  disabled,
  testId
}: {
  placeholder: string
  value: string | null
  valueLabel: string | null
  search: (q: string) => Promise<T[]>
  render: (row: T) => { id: string; label: string; sub?: string | null }
  onPick: (row: T | null) => void
  disabled?: boolean
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const { data = [], isFetching } = useQuery({
    queryKey: ['tasks-picker', testId, debounced],
    queryFn: () => search(debounced),
    enabled: open
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          disabled={disabled}
          className='w-full justify-between font-normal'
          data-tasks-picker={testId}
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value ? (valueLabel ?? value) : placeholder}
          </span>
          <ChevronsUpDown className='ml-1 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[340px] p-0' align='start'>
        <Command shouldFilter={false}>
          <CommandInput placeholder='Type to search…' value={q} onValueChange={setQ} />
          <CommandList>
            <CommandEmpty>{isFetching ? 'Searching…' : 'Nothing matches'}</CommandEmpty>
            <CommandGroup>
              {data.map((row) => {
                const r = render(row)
                return (
                  <CommandItem
                    key={r.id}
                    value={r.id}
                    onSelect={() => {
                      onPick(row)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn('mr-2 h-4 w-4', value === r.id ? 'opacity-100' : 'opacity-0')}
                    />
                    <span className='min-w-0 flex-1 truncate'>{r.label}</span>
                    {r.sub && (
                      <span className='ml-2 shrink-0 text-xs text-muted-foreground'>{r.sub}</span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function CollectionPicker({
  collections,
  value,
  onChange
}: {
  collections: CollectionMeta[]
  value: string
  onChange: (c: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = collections.find((c) => c.collection === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          className='w-full justify-between font-normal'
          data-tasks-picker='collection'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? collectionLabel(selected) : 'Choose a collection…'}
          </span>
          <ChevronsUpDown className='ml-1 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[300px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' />
          <CommandList>
            <CommandEmpty>No collection</CommandEmpty>
            <CommandGroup>
              {collections.map((c) => (
                <CommandItem
                  key={c.collection}
                  value={`${collectionLabel(c)} ${c.collection}`}
                  onSelect={() => {
                    onChange(c.collection)
                    setOpen(false)
                  }}
                >
                  {collectionLabel(c)}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

interface FormState {
  collection: string
  item: string | null
  itemLabel: string | null
  title: string
  description: string
  assignee: string | null
  assigneeLabel: string | null
  due_date: string
  priority: Priority
}

const EMPTY: FormState = {
  collection: '',
  item: null,
  itemLabel: null,
  title: '',
  description: '',
  assignee: null,
  assigneeLabel: null,
  due_date: '',
  priority: 'normal'
}

function TaskForm({
  collections,
  onSave,
  onCancel,
  saving
}: {
  collections: CollectionMeta[]
  onSave: (f: FormState) => void
  onCancel: () => void
  saving: boolean
}) {
  const [f, setF] = useState<FormState>(EMPTY)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }))
  const meta = collections.find((c) => c.collection === f.collection)
  const valid = !!f.collection && !!f.item && !!f.title.trim() && !!f.assignee

  const searchRecords = async (q: string) => {
    if (!f.collection) return []
    const r = await api.get<{ data: Array<Record<string, unknown>> }>(`/items/${f.collection}`, {
      params: { limit: 20, ...(q ? { search: q } : {}), sort: '-id' }
    })
    return r.data.data
  }
  const recordLabel = (row: Record<string, unknown>) => {
    const t = renderDisplayTemplate(meta?.display_template, row).trim()
    return t || String(row.title ?? row.name ?? row.label ?? `#${String(row.id)}`)
  }
  const searchPeople = async (q: string) => {
    const r = await api.get<{ data: Person[] }>('/users', {
      params: {
        limit: 25,
        people: 1,
        fields: 'id,first_name,last_name,email',
        ...(q ? { search: q } : {})
      }
    })
    return r.data.data
  }

  return (
    <div className='space-y-4'>
      <div className='space-y-1.5'>
        <Label htmlFor='task-title'>Title</Label>
        <Input
          id='task-title'
          value={f.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder='e.g. Enter the REQ IDs'
        />
      </div>
      <div className='grid grid-cols-2 gap-4'>
        <div className='space-y-1.5'>
          <Label>Collection</Label>
          <CollectionPicker
            collections={collections}
            value={f.collection}
            onChange={(c) => setF((p) => ({ ...p, collection: c, item: null, itemLabel: null }))}
          />
        </div>
        <div className='space-y-1.5'>
          <Label>Record</Label>
          <SearchPicker<Record<string, unknown>>
            key={f.collection}
            placeholder={f.collection ? 'Find the record…' : 'Choose a collection first'}
            disabled={!f.collection}
            value={f.item}
            valueLabel={f.itemLabel}
            search={searchRecords}
            render={(row) => ({
              id: String(row.id),
              label: recordLabel(row),
              sub: `#${String(row.id)}`
            })}
            onPick={(row) =>
              setF((p) => ({
                ...p,
                item: row ? String(row.id) : null,
                itemLabel: row ? recordLabel(row) : null
              }))
            }
            testId={`record:${f.collection}`}
          />
        </div>
      </div>
      <div className='grid grid-cols-2 gap-4'>
        <div className='space-y-1.5'>
          <Label>Assignee</Label>
          <SearchPicker<Person>
            placeholder='Find a person…'
            value={f.assignee}
            valueLabel={f.assigneeLabel}
            search={searchPeople}
            render={(p) => ({ id: p.id, label: personName(p), sub: p.email })}
            onPick={(p) =>
              setF((x) => ({
                ...x,
                assignee: p ? p.id : null,
                assigneeLabel: p ? personName(p) : null
              }))
            }
            testId='assignee'
          />
        </div>
        <div className='space-y-1.5'>
          <Label>Priority</Label>
          <Select value={f.priority} onValueChange={(v) => set('priority', v as Priority)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='low'>Low</SelectItem>
              <SelectItem value='normal'>Normal</SelectItem>
              <SelectItem value='urgent'>Urgent</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='task-due'>Due date (optional)</Label>
        <Input
          id='task-due'
          type='date'
          value={f.due_date}
          onChange={(e) => set('due_date', e.target.value)}
        />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='task-desc'>Details (optional)</Label>
        <Textarea
          id='task-desc'
          value={f.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder='Anything the person needs to know'
          rows={3}
        />
      </div>
      <DialogFooter>
        <Button variant='outline' onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => onSave(f)} disabled={saving || !valid}>
          {saving ? 'Saving…' : 'Create task'}
        </Button>
      </DialogFooter>
    </div>
  )
}

type Scope = 'all' | 'me' | 'requested'
type StatusFilter = 'active' | 'done' | 'cancelled' | 'all'
type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'none'

export function TasksPage() {
  const qc = useQueryClient()
  const [scope, setScope] = useState<Scope>('all')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [collection, setCollection] = useState<string>('')
  const [due, setDue] = useState<DueFilter>('any')
  const [priority, setPriority] = useState<'' | Priority>('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Task | null>(null)

  const params = (extra: Record<string, string> = {}) => {
    const p: Record<string, string> = { ...extra }
    if (scope === 'me') p.assignee = 'me'
    if (scope === 'requested') p.created_by = 'me'
    if (collection) p.collection = collection
    if (priority) p.priority = priority
    if (debounced) p.search = debounced
    return p
  }

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ['tasks', 'admin', scope, status, collection, due, priority, debounced],
    queryFn: () =>
      api
        .get<{ data: Task[] }>('/tasks', {
          params: params({
            ...(status !== 'all' ? { status } : {}),
            ...(due !== 'any' ? { due } : {})
          })
        })
        .then((r) => r.data.data)
  })
  // The overdue count the header carries, for the same scope and filters.
  const { data: overdueCount = 0 } = useQuery<number>({
    queryKey: ['tasks', 'admin', 'overdue', scope, collection, priority, debounced],
    queryFn: () =>
      api
        .get<{ data: Task[] }>('/tasks', { params: params({ due: 'overdue', limit: '1000' }) })
        .then((r) => r.data.data.length)
  })

  const { data: collections = [] } = useQuery<CollectionMeta[]>({
    queryKey: ['collections-list-for-tasks'],
    queryFn: () =>
      api
        .get<{ data: CollectionMeta[] }>('/collections')
        .then((r) => r.data.data.filter((c) => !c.collection.startsWith('nivaro_')))
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks'] })
  const errText = (e: unknown, fallback: string) =>
    (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

  const createMut = useMutation({
    mutationFn: (f: FormState) =>
      api.post('/tasks', {
        collection: f.collection,
        item: f.item,
        title: f.title.trim(),
        description: f.description.trim() || null,
        assignee: f.assignee,
        due_date: f.due_date || null,
        priority: f.priority
      }),
    onSuccess: () => {
      invalidate()
      setCreating(false)
      toast.success('Task created')
    },
    onError: (e) => toast.error(errText(e, 'Could not create the task'))
  })
  const completeMut = useMutation({
    mutationFn: (id: number) => api.post(`/tasks/${id}/complete`),
    onSuccess: () => {
      invalidate()
      toast.success('Task completed')
    },
    onError: (e) => toast.error(errText(e, 'Could not complete the task'))
  })
  const reopenMut = useMutation({
    mutationFn: (id: number) => api.patch(`/tasks/${id}`, { status: 'open' }),
    onSuccess: () => {
      invalidate()
      toast.success('Task reopened')
    },
    onError: (e) => toast.error(errText(e, 'Could not reopen the task'))
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/tasks/${id}`),
    onSuccess: () => {
      invalidate()
      setDeleting(null)
      toast.success('Task deleted')
    },
    onError: (e) => toast.error(errText(e, 'Could not delete the task'))
  })

  const today = todayIso()

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='shrink-0 space-y-3 border-b border-border px-6 py-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <CheckSquare className='h-5 w-5 text-muted-foreground' />
            <h1 className='text-lg font-semibold'>Tasks</h1>
            {overdueCount > 0 && (
              <button
                type='button'
                onClick={() => {
                  setDue('overdue')
                  setStatus('active')
                }}
                className='rounded-full bg-red-500/10 px-2 py-0.5 text-[12px] font-semibold text-red-600 hover:bg-red-500/15 dark:text-red-400'
                data-tasks-overdue={overdueCount}
              >
                {overdueCount} overdue
              </button>
            )}
          </div>
          <Button size='sm' onClick={() => setCreating(true)}>
            <Plus className='mr-1.5 h-4 w-4' />
            New task
          </Button>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='relative'>
            <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground' />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Search tasks…'
              className='h-9 w-[220px] pl-8'
              data-tasks-search
            />
          </div>
          <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
            <SelectTrigger className='h-9 w-[160px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All tasks</SelectItem>
              <SelectItem value='me'>Assigned to me</SelectItem>
              <SelectItem value='requested'>Requested by me</SelectItem>
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className='h-9 w-[140px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='active'>Open</SelectItem>
              <SelectItem value='done'>Done</SelectItem>
              <SelectItem value='cancelled'>Cancelled</SelectItem>
              <SelectItem value='all'>Any status</SelectItem>
            </SelectContent>
          </Select>
          <Select value={due} onValueChange={(v) => setDue(v as DueFilter)}>
            <SelectTrigger className='h-9 w-[150px]' data-tasks-due-filter>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='any'>Any due date</SelectItem>
              <SelectItem value='overdue'>Overdue</SelectItem>
              <SelectItem value='today'>Due today</SelectItem>
              <SelectItem value='week'>Due this week</SelectItem>
              <SelectItem value='none'>No due date</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={priority || 'any'}
            onValueChange={(v) => setPriority(v === 'any' ? '' : (v as Priority))}
          >
            <SelectTrigger className='h-9 w-[140px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='any'>Any priority</SelectItem>
              <SelectItem value='urgent'>Urgent</SelectItem>
              <SelectItem value='normal'>Normal</SelectItem>
              <SelectItem value='low'>Low</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={collection || 'any'}
            onValueChange={(v) => setCollection(v === 'any' ? '' : v)}
          >
            <SelectTrigger className='h-9 w-[180px]' data-tasks-collection-filter>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='any'>Any collection</SelectItem>
              {collections.map((c) => (
                <SelectItem key={c.collection} value={c.collection}>
                  {collectionLabel(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className='flex-1 overflow-auto p-6'>
        {isLoading ? (
          <div className='space-y-3'>
            {[1, 2, 3].map((i) => (
              <div key={i} className='h-12 animate-pulse rounded-lg bg-muted' />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <CheckSquare className='mb-3 h-10 w-10 text-muted-foreground' />
            <p className='mb-1 text-sm font-medium'>No tasks match</p>
            <p className='mb-4 text-xs text-muted-foreground'>
              Change the filters, or create a task to ask someone to do something on a record.
            </p>
            <Button size='sm' onClick={() => setCreating(true)}>
              <Plus className='mr-1.5 h-4 w-4' />
              New task
            </Button>
          </div>
        ) : (
          <div className='overflow-hidden rounded-lg border border-border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className='w-28' />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => {
                  const active = task.status === 'open' || task.status === 'in_progress'
                  const overdue =
                    active && !!task.due_date && String(task.due_date).slice(0, 10) < today
                  return (
                    <TableRow key={task.id} data-tasks-row={task.id}>
                      <TableCell className='max-w-[320px]'>
                        <div className='flex items-center gap-1.5'>
                          {task.priority === 'urgent' && (
                            <span className='rounded bg-red-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'>
                              urgent
                            </span>
                          )}
                          {task.kind === 'support' && (
                            <span className='rounded bg-slate-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300'>
                              support
                            </span>
                          )}
                          <span
                            className='truncate font-medium'
                            title={task.description ?? undefined}
                          >
                            {task.title}
                          </span>
                        </div>
                        {task.created_by_name && (
                          <p className='text-xs text-muted-foreground'>
                            Asked by {task.created_by_name}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {task.collection && task.item ? (
                          <Link
                            to={`/collections/${task.collection}/${task.item}`}
                            className='inline-flex items-center gap-1 text-sm text-nvr-cyan hover:underline'
                            data-tasks-record={task.item_label ?? task.item}
                          >
                            {task.item_label ?? `#${task.item}`}
                            <ExternalLink className='h-3 w-3' />
                          </Link>
                        ) : (
                          <span className='text-sm text-muted-foreground'>
                            {task.item_label ?? '—'}
                          </span>
                        )}
                        {task.collection && (
                          <p className='text-xs text-muted-foreground'>
                            {collectionLabel(
                              collections.find((c) => c.collection === task.collection) ?? {
                                collection: task.collection
                              }
                            )}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className='text-sm text-muted-foreground'>
                        {task.assignee_name ??
                          (task.team_name ? (
                            <span className='inline-flex items-center gap-1'>
                              <Users className='h-3.5 w-3.5' />
                              {task.team_name}
                            </span>
                          ) : (
                            '—'
                          ))}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-sm tabular-nums',
                          overdue
                            ? 'font-medium text-red-600 dark:text-red-400'
                            : 'text-muted-foreground'
                        )}
                      >
                        {task.due_date ? formatDate(task.due_date) : '—'}
                        {overdue && <span className='block text-xs'>Overdue</span>}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant='outline'
                          className={`text-[11px] ${STATUS_META[task.status]?.className ?? ''}`}
                        >
                          {STATUS_META[task.status]?.label ?? task.status}
                        </Badge>
                        {task.status === 'done' && task.completed_by_name && (
                          <p className='mt-0.5 text-xs text-muted-foreground'>
                            by {task.completed_by_name}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className='flex items-center justify-end gap-1'>
                          {active ? (
                            <Button
                              variant='ghost'
                              size='icon'
                              className='h-7 w-7 text-green-600 hover:text-green-700'
                              title='Mark complete'
                              onClick={() => completeMut.mutate(task.id)}
                              disabled={completeMut.isPending}
                            >
                              <CheckSquare className='h-3.5 w-3.5' />
                            </Button>
                          ) : (
                            <Button
                              variant='ghost'
                              size='icon'
                              className='h-7 w-7'
                              title='Reopen'
                              onClick={() => reopenMut.mutate(task.id)}
                              disabled={reopenMut.isPending}
                            >
                              <RotateCcw className='h-3.5 w-3.5' />
                            </Button>
                          )}
                          <Button
                            variant='ghost'
                            size='icon'
                            className='h-7 w-7 text-destructive hover:text-destructive'
                            title='Delete'
                            onClick={() => setDeleting(task)}
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className='max-h-[90vh] max-w-lg overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <TaskForm
              collections={collections}
              onSave={(f) => createMut.mutate(f)}
              onCancel={() => setCreating(false)}
              saving={createMut.isPending}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete task</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className='text-sm text-muted-foreground'>
              Delete <span className='font-medium text-foreground'>{deleting?.title}</span>? Its
              history goes with it; this cannot be undone.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDeleting(null)}
              disabled={deleteMut.isPending}
            >
              Cancel
            </Button>
            <Button
              variant='destructive'
              onClick={() => deleting && deleteMut.mutate(deleting.id)}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

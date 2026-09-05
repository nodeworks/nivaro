import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronsUpDown, ClipboardList, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { cn, formatDate, formatRelative } from '../../lib/utils'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'

interface Task {
  id: number
  title: string
  description: string | null
  assignee: string | null
  due_date: string | null
  status: string
  priority?: 'low' | 'normal' | 'urgent'
  created_by: string | null
  completed_at: string | null
}

interface User {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  is_out_of_office?: boolean
  ooo_end?: string | null
  delegate_id?: string | null
}

export interface PendingTask {
  title: string
  assignee: string | null
  due_date: string
  priority?: string
}

function userName(u: User | undefined): string {
  if (!u) return 'Unknown'
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
}

function AssigneeCombobox({
  users,
  value,
  onChange
}: {
  users: User[]
  value: string | null
  onChange: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = users.find((u) => u.id === value)
  const client = useNivaroClient()
  // Picker load hints (#410): open-task counts per person, fetched only once
  // the picker actually opens. Keys come back uppercased.
  const { data: openCounts } = useQuery<Record<string, number>>({
    queryKey: ['task-open-counts', users.map((u) => u.id).join(',')],
    queryFn: () =>
      client
        .request<{ data: Record<string, number> }>(
          get('/tasks/open-counts', { ids: users.map((u) => u.id).join(',') })
        )
        .then((r) => r.data)
        .catch(() => ({})),
    enabled: open && users.length > 0,
    staleTime: 60_000
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between px-2.5 text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? userName(selected) : 'Assign to…'}
          </span>
          <ChevronsUpDown className='ml-1 h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search users…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No users found
            </CommandEmpty>
            <CommandGroup>
              {users.map((u) => (
                <CommandItem
                  key={u.id}
                  value={`${u.first_name ?? ''} ${u.last_name ?? ''} ${u.email}`}
                  onSelect={() => {
                    onChange(u.id === value ? null : u.id)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3.5 w-3.5', value === u.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className='min-w-0 flex-1 truncate'>{userName(u)}</span>
                  {openCounts && (openCounts[u.id.toUpperCase()] ?? 0) > 0 && (
                    <span
                      className='ml-2 shrink-0 rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold tabular-nums text-slate-500 dark:bg-muted dark:text-slate-400'
                      title={`${openCounts[u.id.toUpperCase()]} open task${openCounts[u.id.toUpperCase()] === 1 ? '' : 's'} already assigned`}
                    >
                      {openCounts[u.id.toUpperCase()]}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function TaskPanel({
  collection,
  item,
  title,
  defaultExpanded,
  queuedTasks,
  onQueueTask
}: {
  collection: string
  item: string
  title?: string
  defaultExpanded?: boolean
  queuedTasks?: PendingTask[]
  onQueueTask?: (task: PendingTask) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const syncedFromProp = useRef(false)
  useEffect(() => {
    if (!syncedFromProp.current && defaultExpanded !== undefined) {
      syncedFromProp.current = true
      setExpanded(defaultExpanded)
    }
  }, [defaultExpanded])
  const [adding, setAdding] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newAssignee, setNewAssignee] = useState<string | null>(null)
  const [newDueDate, setNewDueDate] = useState('')
  const [newPriority, setNewPriority] = useState<'low' | 'normal' | 'urgent'>('normal')

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks', collection, item],
    queryFn: () =>
      client.request<{ data: Task[] }>(get('/tasks', { collection, item })).then((r) => r.data),
    enabled: !!collection && !!item && item !== 'new'
  })

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['users', 'combobox'],
    queryFn: () =>
      client.request<{ data: User[] }>(get('/users', { limit: 200 })).then((r) => r.data)
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks', collection, item] })

  const createMut = useMutation({
    mutationFn: () =>
      client.request(
        post('/tasks', {
          collection,
          item,
          title: newTitle.trim(),
          assignee: newAssignee,
          due_date: newDueDate || undefined,
          priority: newPriority
        })
      ),
    onSuccess: () => {
      invalidate()
      setAdding(false)
      setNewTitle('')
      setNewAssignee(null)
      setNewDueDate('')
      setNewPriority('normal')
      toast.success('Task created')
    },
    onError: () => toast.error('Failed to create task')
  })

  const completeMut = useMutation({
    mutationFn: (taskId: number) => client.request(post(`/tasks/${taskId}/complete`, {})),
    onSuccess: () => {
      invalidate()
      toast.success('Task completed')
    },
    onError: () => toast.error('Failed to complete task')
  })

  const deleteMut = useMutation({
    mutationFn: (taskId: number) => client.request(del(`/tasks/${taskId}`)),
    onSuccess: () => {
      invalidate()
      toast.success('Task deleted')
    },
    onError: () => toast.error('Failed to delete task')
  })

  if (!item) return null

  const isNew = item === 'new'
  const openTasks = tasks.filter((t) => t.status !== 'completed')
  const completedTasks = tasks.filter((t) => t.status === 'completed')
  const usersById = new Map(users.map((u) => [u.id, u]))
  const now = Date.now()

  function handleCreate() {
    if (!newTitle.trim()) return
    if (isNew && onQueueTask) {
      onQueueTask({
        title: newTitle.trim(),
        assignee: newAssignee,
        due_date: newDueDate,
        priority: newPriority
      })
      setAdding(false)
      setNewTitle('')
      setNewAssignee(null)
      setNewDueDate('')
    } else {
      createMut.mutate()
    }
  }

  return (
    <div className='overflow-hidden rounded-xl border border-slate-200 bg-white dark:bg-card dark:border-border'>
      <button
        type='button'
        onClick={() => setExpanded((v) => !v)}
        className='flex w-full flex-col px-5 py-3.5 text-left transition-colors hover:bg-slate-50/50 dark:hover:bg-white/[0.02]'
      >
        <span className='flex w-full items-center gap-2.5'>
          <ClipboardList className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <span className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
            {title || 'Tasks'}
          </span>
          {openTasks.length > 0 && (
            <span className='rounded-full bg-slate-100 px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-slate-500 dark:bg-muted dark:text-slate-400'>
              {openTasks.length} open
            </span>
          )}
          <ChevronDown
            className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150${expanded ? ' rotate-180' : ''}`}
          />
        </span>
        {/* Collapsed: newest open task rides the header. */}
        {!expanded && openTasks.length > 0 && (
          <span className='mt-1 w-full truncate pl-6 text-[11.5px] text-slate-400'>
            {openTasks[openTasks.length - 1].title}
            {openTasks[openTasks.length - 1].due_date && (
              <span className='text-slate-400/80'>
                {' '}
                · due{' '}
                {new Date(openTasks[openTasks.length - 1].due_date as string).toLocaleDateString()}
              </span>
            )}
          </span>
        )}
      </button>
      {expanded && isNew && (
        <div className='border-t border-slate-100 dark:border-border/60'>
          <div className='space-y-3 px-5 py-3'>
            {!adding && (
              <button
                type='button'
                onClick={() => setAdding(true)}
                className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-[#00ceff]'
              >
                <Plus className='h-3.5 w-3.5' />
                Add task
              </button>
            )}
            {adding && (
              <div className='space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:bg-slate-900/30 dark:border-border'>
                <div>
                  <Label className='mb-1 block text-[11px]'>Title</Label>
                  <Input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    className='h-8 bg-white text-[12px]'
                    placeholder='What needs to be done?'
                    autoFocus
                  />
                </div>
                <div className='grid grid-cols-2 gap-3'>
                  <div>
                    <Label className='mb-1 block text-[11px]'>Assignee</Label>
                    <AssigneeCombobox users={users} value={newAssignee} onChange={setNewAssignee} />
                    {(() => {
                      // OOO assignment warning (#221): the assignee is out —
                      // say so (with return date + delegate) before the task lands.
                      const a = users.find((u) => u.id === newAssignee)
                      if (!a?.is_out_of_office) return null
                      const delegate = a.delegate_id
                        ? users.find((u) => u.id === a.delegate_id)
                        : null
                      return (
                        <p className='mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700 dark:bg-amber-400/10 dark:text-amber-400'>
                          {[a.first_name, a.last_name].filter(Boolean).join(' ') || a.email} is out
                          of office{a.ooo_end ? ` until ${String(a.ooo_end).slice(0, 10)}` : ''}
                          {delegate
                            ? ` — their delegate is ${[delegate.first_name, delegate.last_name].filter(Boolean).join(' ') || delegate.email}`
                            : ' — open tasks route to their delegate if one is set'}
                          .
                        </p>
                      )
                    })()}
                  </div>
                  <div>
                    <Label className='mb-1 block text-[11px]'>Due date</Label>
                    <Input
                      type='date'
                      value={newDueDate}
                      onChange={(e) => setNewDueDate(e.target.value)}
                      className='h-8 bg-white text-[12px]'
                    />
                  </div>
                  <div>
                    <Label className='mb-1 block text-[11px]'>Priority</Label>
                    <SimpleSelect
                      value={newPriority}
                      onChange={(v) => setNewPriority(v as 'low' | 'normal' | 'urgent')}
                      options={[
                        { value: 'low', label: 'Low' },
                        { value: 'normal', label: 'Normal' },
                        { value: 'urgent', label: 'Urgent' }
                      ]}
                    />
                  </div>
                </div>
                <div className='flex justify-end gap-2'>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-7 text-[12px]'
                    onClick={() => setAdding(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    className='h-7 text-[12px]'
                    disabled={!newTitle.trim()}
                    onClick={handleCreate}
                  >
                    Queue Task
                  </Button>
                </div>
              </div>
            )}
            {(queuedTasks ?? []).length > 0 && (
              <div className='divide-y divide-slate-100 dark:divide-border/60'>
                {(queuedTasks ?? []).map((t, i) => (
                  <div key={i} className='flex items-start gap-2.5 py-2'>
                    <span className='mt-0.5 inline-flex shrink-0 items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'>
                      Pending
                    </span>
                    <div className='min-w-0 flex-1'>
                      <p className='text-[13px] font-medium text-slate-800'>{t.title}</p>
                      <div className='mt-0.5 flex items-center gap-3 text-[11px] text-slate-400'>
                        {t.priority && t.priority !== 'normal' && (
                          <span
                            className={
                              t.priority === 'urgent'
                                ? 'rounded bg-red-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'
                                : 'rounded bg-slate-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'
                            }
                          >
                            {t.priority}
                          </span>
                        )}
                        {t.assignee && <span>{userName(usersById.get(t.assignee))}</span>}
                        {t.due_date && <span>Due {formatDate(t.due_date)}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {(queuedTasks ?? []).length === 0 && !adding && (
              <p className='py-1 text-[12px] text-slate-400'>
                Tasks will be created after the record is saved.
              </p>
            )}
          </div>
        </div>
      )}
      {expanded && !isNew && (
        <div className='border-t border-slate-100 dark:border-border/60'>
          <div className='space-y-3 px-5 py-3'>
            {openTasks.length === 0 && !adding && (
              <p className='py-1 text-[13px] text-slate-400'>No open tasks</p>
            )}
            {openTasks.length > 0 && (
              <div className='divide-y divide-slate-100 dark:divide-border/60'>
                {openTasks.map((t) => {
                  const overdue = t.due_date ? new Date(t.due_date).getTime() < now : false
                  return (
                    <div key={t.id} className='nvr-rise-in flex items-start gap-2.5 py-2'>
                      <Checkbox
                        className='mt-0.5'
                        checked={false}
                        onCheckedChange={() => completeMut.mutate(t.id)}
                        disabled={completeMut.isPending}
                        aria-label={`Complete task: ${t.title}`}
                      />
                      <div className='min-w-0 flex-1'>
                        <p className='text-[13px] font-medium text-slate-800'>{t.title}</p>
                        {t.description && (
                          <p className='mt-0.5 text-[12px] text-slate-500 line-clamp-2'>
                            {t.description}
                          </p>
                        )}
                        <div className='mt-0.5 flex items-center gap-3 text-[11px] text-slate-400'>
                          {t.priority && t.priority !== 'normal' && (
                            <span
                              className={
                                t.priority === 'urgent'
                                  ? 'rounded bg-red-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'
                                  : 'rounded bg-slate-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'
                              }
                            >
                              {t.priority}
                            </span>
                          )}
                          {t.assignee && <span>{userName(usersById.get(t.assignee))}</span>}
                          {t.due_date && (
                            <span className={cn(overdue && 'font-medium text-red-500')}>
                              Due {formatDate(t.due_date)}
                              {overdue && ' (overdue)'}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type='button'
                        onClick={() => deleteMut.mutate(t.id)}
                        disabled={deleteMut.isPending}
                        className='shrink-0 rounded p-1 text-slate-300 transition-colors hover:bg-red-50 hover:text-red-400 disabled:opacity-40'
                      >
                        <X className='h-3.5 w-3.5' />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
            {!adding && (
              <button
                type='button'
                onClick={() => setAdding(true)}
                className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-[#00ceff]'
              >
                <Plus className='h-3.5 w-3.5' />
                Add task
              </button>
            )}
            {adding && (
              <div className='space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:bg-slate-900/30 dark:border-border'>
                <div>
                  <Label className='mb-1 block text-[11px]'>Title</Label>
                  <Input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    className='h-8 bg-white text-[12px]'
                    placeholder='What needs to be done?'
                    autoFocus
                  />
                </div>
                <div className='grid grid-cols-2 gap-3'>
                  <div>
                    <Label className='mb-1 block text-[11px]'>Assignee</Label>
                    <AssigneeCombobox users={users} value={newAssignee} onChange={setNewAssignee} />
                    {(() => {
                      // OOO assignment warning (#221): the assignee is out —
                      // say so (with return date + delegate) before the task lands.
                      const a = users.find((u) => u.id === newAssignee)
                      if (!a?.is_out_of_office) return null
                      const delegate = a.delegate_id
                        ? users.find((u) => u.id === a.delegate_id)
                        : null
                      return (
                        <p className='mt-1 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700 dark:bg-amber-400/10 dark:text-amber-400'>
                          {[a.first_name, a.last_name].filter(Boolean).join(' ') || a.email} is out
                          of office{a.ooo_end ? ` until ${String(a.ooo_end).slice(0, 10)}` : ''}
                          {delegate
                            ? ` — their delegate is ${[delegate.first_name, delegate.last_name].filter(Boolean).join(' ') || delegate.email}`
                            : ' — open tasks route to their delegate if one is set'}
                          .
                        </p>
                      )
                    })()}
                  </div>
                  <div>
                    <Label className='mb-1 block text-[11px]'>Due date</Label>
                    <Input
                      type='date'
                      value={newDueDate}
                      onChange={(e) => setNewDueDate(e.target.value)}
                      className='h-8 bg-white text-[12px]'
                    />
                  </div>
                  <div>
                    <Label className='mb-1 block text-[11px]'>Priority</Label>
                    <SimpleSelect
                      value={newPriority}
                      onChange={(v) => setNewPriority(v as 'low' | 'normal' | 'urgent')}
                      options={[
                        { value: 'low', label: 'Low' },
                        { value: 'normal', label: 'Normal' },
                        { value: 'urgent', label: 'Urgent' }
                      ]}
                    />
                  </div>
                </div>
                <div className='flex justify-end gap-2'>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-7 text-[12px]'
                    onClick={() => setAdding(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type='button'
                    size='sm'
                    className='h-7 text-[12px]'
                    disabled={!newTitle.trim() || !newAssignee || createMut.isPending}
                    onClick={handleCreate}
                  >
                    {createMut.isPending ? 'Creating…' : 'Create Task'}
                  </Button>
                </div>
              </div>
            )}
            {completedTasks.length > 0 && (
              <div>
                <button
                  type='button'
                  onClick={() => setShowCompleted((v) => !v)}
                  className='flex items-center gap-1 text-[12px] text-slate-400 transition-colors hover:text-slate-600'
                >
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 transition-transform',
                      showCompleted && 'rotate-180'
                    )}
                  />
                  Completed ({completedTasks.length})
                </button>
                {showCompleted && (
                  <div className='mt-1 divide-y divide-slate-100'>
                    {completedTasks.map((t) => (
                      <div
                        key={t.id}
                        className='nvr-rise-in flex items-start gap-2.5 py-2 opacity-60 transition-opacity duration-300'
                      >
                        <Checkbox className='mt-0.5' checked disabled aria-label='Completed' />
                        <div className='min-w-0 flex-1'>
                          <p className='text-[13px] text-slate-600 line-through'>{t.title}</p>
                          <div className='mt-0.5 flex items-center gap-3 text-[11px] text-slate-400'>
                            {t.priority && t.priority !== 'normal' && (
                              <span
                                className={
                                  t.priority === 'urgent'
                                    ? 'rounded bg-red-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'
                                    : 'rounded bg-slate-500/10 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'
                                }
                              >
                                {t.priority}
                              </span>
                            )}
                            {t.assignee && <span>{userName(usersById.get(t.assignee))}</span>}
                            {t.completed_at && <span>Done {formatRelative(t.completed_at)}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

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

interface Task {
  id: number
  title: string
  description: string | null
  assignee: string | null
  due_date: string | null
  status: string
  created_by: string | null
  completed_at: string | null
}

interface User {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

export interface PendingTask {
  title: string
  assignee: string | null
  due_date: string
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
                  {userName(u)}
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
          due_date: newDueDate || undefined
        })
      ),
    onSuccess: () => {
      invalidate()
      setAdding(false)
      setNewTitle('')
      setNewAssignee(null)
      setNewDueDate('')
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
      onQueueTask({ title: newTitle.trim(), assignee: newAssignee, due_date: newDueDate })
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
        className='flex w-full items-center gap-2.5 px-5 py-3.5 transition-colors hover:bg-slate-50/50 dark:hover:bg-white/[0.02]'
      >
        <ClipboardList className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        <span className='font-semibold text-sm text-slate-700'>{title || 'Tasks'}</span>
        {!expanded && openTasks.length > 0 && (
          <span className='ml-1 text-[11px] text-slate-400'>{openTasks.length} open</span>
        )}
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150${expanded ? ' rotate-180' : ''}`}
        />
      </button>
      {expanded && isNew && (
        <div className='border-t border-slate-100 dark:border-border/60'>
          <div className='space-y-3 px-5 py-3'>
            {!adding && (
              <button type='button' onClick={() => setAdding(true)} className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-[#00ceff]'>
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
                  </div>
                  <div>
                    <Label className='mb-1 block text-[11px]'>Due date</Label>
                    <Input type='date' value={newDueDate} onChange={(e) => setNewDueDate(e.target.value)} className='h-8 bg-white text-[12px]' />
                  </div>
                </div>
                <div className='flex justify-end gap-2'>
                  <Button type='button' variant='outline' size='sm' className='h-7 text-[12px]' onClick={() => setAdding(false)}>Cancel</Button>
                  <Button type='button' size='sm' className='h-7 text-[12px]' disabled={!newTitle.trim()} onClick={handleCreate}>
                    Queue Task
                  </Button>
                </div>
              </div>
            )}
            {(queuedTasks ?? []).length > 0 && (
              <div className='divide-y divide-slate-100 dark:divide-border/60'>
                {(queuedTasks ?? []).map((t, i) => (
                  <div key={i} className='flex items-start gap-2.5 py-2'>
                    <span className='mt-0.5 inline-flex shrink-0 items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'>Pending</span>
                    <div className='min-w-0 flex-1'>
                      <p className='text-[13px] font-medium text-slate-800'>{t.title}</p>
                      <div className='mt-0.5 flex items-center gap-3 text-[11px] text-slate-400'>
                        {t.assignee && <span>{userName(usersById.get(t.assignee))}</span>}
                        {t.due_date && <span>Due {formatDate(t.due_date)}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {(queuedTasks ?? []).length === 0 && !adding && (
              <p className='py-1 text-[12px] text-slate-400'>Tasks will be created after the record is saved.</p>
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
                    <div key={t.id} className='flex items-start gap-2.5 py-2'>
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
              <button type='button' onClick={() => setAdding(true)} className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-[#00ceff]'>
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
                      <div key={t.id} className='flex items-start gap-2.5 py-2 opacity-60'>
                        <Checkbox className='mt-0.5' checked disabled aria-label='Completed' />
                        <div className='min-w-0 flex-1'>
                          <p className='text-[13px] text-slate-600 line-through'>{t.title}</p>
                          <div className='mt-0.5 flex items-center gap-3 text-[11px] text-slate-400'>
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

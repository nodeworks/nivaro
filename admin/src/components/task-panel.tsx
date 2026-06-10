import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronsUpDown, ClipboardList, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { api, type User } from '@/lib/api'
import { cn, formatDate, formatRelative } from '@/lib/utils'

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

function userName(u: User | undefined): string {
  if (!u) return 'Unknown'
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name || u.email
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

/**
 * Per-record task list. Shows open tasks (with assignee + due date), a checkbox
 * to complete each one, an inline add form, and a collapsed completed section.
 */
export function TaskPanel({ collection, item }: { collection: string; item: string }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newAssignee, setNewAssignee] = useState<string | null>(null)
  const [newDueDate, setNewDueDate] = useState('')

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks', collection, item],
    queryFn: () =>
      api
        .get<{ data: Task[] }>('/tasks', { params: { collection, item } })
        .then((r) => r.data.data),
    enabled: !!collection && !!item && item !== 'new'
  })

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['users', 'combobox'],
    queryFn: () => api.get<{ data: User[] }>('/users?limit=200').then((r) => r.data.data)
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks', collection, item] })

  const createMut = useMutation({
    mutationFn: () =>
      api.post('/tasks', {
        collection,
        item,
        title: newTitle.trim(),
        assignee: newAssignee,
        due_date: newDueDate || undefined
      }),
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
    mutationFn: (taskId: number) => api.post(`/tasks/${taskId}/complete`),
    onSuccess: () => {
      invalidate()
      toast.success('Task completed')
    },
    onError: () => toast.error('Failed to complete task')
  })

  const deleteMut = useMutation({
    mutationFn: (taskId: number) => api.delete(`/tasks/${taskId}`),
    onSuccess: () => {
      invalidate()
      toast.success('Task deleted')
    },
    onError: () => toast.error('Failed to delete task')
  })

  if (!item || item === 'new') return null

  const openTasks = tasks.filter((t) => t.status !== 'completed')
  const completedTasks = tasks.filter((t) => t.status === 'completed')
  const usersById = new Map(users.map((u) => [u.id, u]))
  const now = Date.now()

  return (
    <Card>
      <CardHeader className='pb-2'>
        <div className='flex items-center justify-between'>
          <CardTitle className='text-sm font-medium text-slate-500 flex items-center gap-1.5'>
            <ClipboardList className='h-3.5 w-3.5' />
            Tasks
            {openTasks.length > 0 && (
              <span className='ml-0.5 rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'>
                {openTasks.length}
              </span>
            )}
          </CardTitle>
          {!adding && (
            <Button
              size='sm'
              variant='outline'
              className='h-7 text-[12px]'
              onClick={() => setAdding(true)}
            >
              <Plus className='mr-1 h-3.5 w-3.5' />
              Add task
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        {openTasks.length === 0 && !adding && (
          <p className='py-1 text-[13px] text-slate-400'>No open tasks</p>
        )}

        {openTasks.length > 0 && (
          <div className='divide-y divide-slate-100'>
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
                    aria-label='Delete task'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {adding && (
          <div className='space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3'>
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
                className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan-dark'
                disabled={!newTitle.trim() || !newAssignee || createMut.isPending}
                onClick={() => createMut.mutate()}
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
                className={cn('h-3.5 w-3.5 transition-transform', showCompleted && 'rotate-180')}
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
      </CardContent>
    </Card>
  )
}

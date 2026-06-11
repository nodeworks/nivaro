import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckSquare, ExternalLink, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { formatDate } from '@/lib/utils'

interface CmsUser {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

interface CollectionMeta {
  collection: string
  name?: string | null
}

interface Task {
  id: number
  collection: string
  item: string
  title: string
  description: string | null
  assignee: string
  assignee_name: string | null
  due_date: string | null
  status: 'open' | 'done' | 'cancelled'
  created_by: string
  created_by_name: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

interface TaskFormData {
  collection: string
  item: string
  title: string
  description: string
  assignee: string
  due_date: string
}

const FORM_DEFAULTS: TaskFormData = {
  collection: '',
  item: '',
  title: '',
  description: '',
  assignee: '',
  due_date: ''
}

function userLabel(u: CmsUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name || u.email
}

const STATUS_META: Record<Task['status'], { label: string; className: string }> = {
  open: {
    label: 'Open',
    className: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20'
  },
  done: {
    label: 'Done',
    className: 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20'
  },
  cancelled: {
    label: 'Cancelled',
    className: 'text-muted-foreground'
  }
}

function TaskForm({
  collections,
  users,
  onSave,
  onCancel,
  saving
}: {
  collections: CollectionMeta[]
  users: CmsUser[]
  onSave: (data: TaskFormData) => void
  onCancel: () => void
  saving: boolean
}) {
  const [form, setForm] = useState<TaskFormData>(FORM_DEFAULTS)

  function set<K extends keyof TaskFormData>(key: K, value: TaskFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const isValid =
    form.collection.trim() !== '' &&
    form.item.trim() !== '' &&
    form.title.trim() !== '' &&
    form.assignee.trim() !== ''

  return (
    <div className='space-y-4'>
      <div className='space-y-1.5'>
        <Label htmlFor='task-title'>Title</Label>
        <Input
          id='task-title'
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder='e.g. Review submission'
        />
      </div>

      <div className='grid grid-cols-2 gap-4'>
        <div className='space-y-1.5'>
          <Label htmlFor='task-collection'>Collection</Label>
          <Select value={form.collection} onValueChange={(v) => set('collection', v)}>
            <SelectTrigger id='task-collection'>
              <SelectValue placeholder='Select collection…' />
            </SelectTrigger>
            <SelectContent>
              {collections.map((c) => (
                <SelectItem key={c.collection} value={c.collection}>
                  {c.name || c.collection}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className='space-y-1.5'>
          <Label htmlFor='task-item'>Item ID</Label>
          <Input
            id='task-item'
            value={form.item}
            onChange={(e) => set('item', e.target.value)}
            placeholder='e.g. 42'
          />
        </div>
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='task-assignee'>Assignee</Label>
        <Select value={form.assignee} onValueChange={(v) => set('assignee', v)}>
          <SelectTrigger id='task-assignee'>
            <SelectValue placeholder='Select user…' />
          </SelectTrigger>
          <SelectContent>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {userLabel(u)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='task-due'>Due Date (optional)</Label>
        <Input
          id='task-due'
          type='date'
          value={form.due_date}
          onChange={(e) => set('due_date', e.target.value)}
        />
      </div>

      <div className='space-y-1.5'>
        <Label htmlFor='task-desc'>Description (optional)</Label>
        <Textarea
          id='task-desc'
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder='Additional context…'
          rows={3}
        />
      </div>

      <DialogFooter>
        <Button variant='outline' onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={() => onSave(form)} disabled={saving || !isValid}>
          {saving ? 'Saving…' : 'Create Task'}
        </Button>
      </DialogFooter>
    </div>
  )
}

export function TasksPage() {
  const qc = useQueryClient()

  const [scope, setScope] = useState<'all' | 'me'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'done'>('open')
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Task | null>(null)

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ['tasks', scope, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (scope === 'me') params.set('assignee', 'me')
      if (statusFilter !== 'all') params.set('status', statusFilter)
      const qs = params.toString()
      return api.get<{ data: Task[] }>(`/tasks${qs ? `?${qs}` : ''}`).then((r) => r.data.data)
    }
  })

  const { data: users = [] } = useQuery<CmsUser[]>({
    queryKey: ['users-list-for-tasks'],
    queryFn: () => api.get<{ data: CmsUser[] }>('/users').then((r) => r.data.data)
  })

  const { data: collections = [] } = useQuery<CollectionMeta[]>({
    queryKey: ['collections-list-for-tasks'],
    queryFn: () =>
      api
        .get<{ data: CollectionMeta[] }>('/collections')
        .then((r) => r.data.data.filter((c) => !c.collection.startsWith('nivaro_')))
  })

  const createMut = useMutation({
    mutationFn: (body: TaskFormData) =>
      api.post('/tasks', {
        collection: body.collection,
        item: body.item,
        title: body.title,
        description: body.description || null,
        assignee: body.assignee,
        due_date: body.due_date || null
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      setCreating(false)
      toast.success('Task created')
    },
    onError: () => toast.error('Failed to create task')
  })

  const completeMut = useMutation({
    mutationFn: (id: number) => api.post(`/tasks/${id}/complete`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      toast.success('Task completed')
    },
    onError: () => toast.error('Failed to complete task')
  })

  const reopenMut = useMutation({
    mutationFn: (id: number) => api.patch(`/tasks/${id}`, { status: 'open' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      toast.success('Task reopened')
    },
    onError: () => toast.error('Failed to reopen task')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/tasks/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      setDeleting(null)
      toast.success('Task deleted')
    },
    onError: () => toast.error('Failed to delete task')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='border-b border-border px-6 py-4 flex items-center justify-between shrink-0'>
        <div className='flex items-center gap-2.5'>
          <CheckSquare className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Tasks</h1>
        </div>
        <div className='flex items-center gap-2'>
          <Select value={scope} onValueChange={(v) => setScope(v as 'all' | 'me')}>
            <SelectTrigger className='h-9 w-[140px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All Tasks</SelectItem>
              <SelectItem value='me'>My Tasks</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as 'all' | 'open' | 'done')}
          >
            <SelectTrigger className='h-9 w-[130px]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='open'>Open</SelectItem>
              <SelectItem value='done'>Done</SelectItem>
              <SelectItem value='all'>All Statuses</SelectItem>
            </SelectContent>
          </Select>
          <Button size='sm' onClick={() => setCreating(true)}>
            <Plus className='h-4 w-4 mr-1.5' />
            New Task
          </Button>
        </div>
      </div>

      <div className='flex-1 overflow-auto p-6'>
        {isLoading ? (
          <div className='space-y-3'>
            {[1, 2, 3].map((i) => (
              <div key={i} className='h-12 rounded-lg bg-muted animate-pulse' />
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <CheckSquare className='h-10 w-10 text-muted-foreground mb-3' />
            <p className='text-sm font-medium mb-1'>No tasks found</p>
            <p className='text-xs text-muted-foreground mb-4'>
              Create a task to assign work on a record to a teammate.
            </p>
            <Button size='sm' onClick={() => setCreating(true)}>
              <Plus className='h-4 w-4 mr-1.5' />
              New Task
            </Button>
          </div>
        ) : (
          <div className='rounded-lg border border-border overflow-hidden'>
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
                {tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className='font-medium'>{task.title}</TableCell>
                    <TableCell>
                      <Link
                        to={`/collections/${task.collection}/${task.item}`}
                        className='inline-flex items-center gap-1 text-sm text-nvr-cyan hover:underline'
                      >
                        <code className='text-xs'>
                          {task.collection}/{task.item}
                        </code>
                        <ExternalLink className='h-3 w-3' />
                      </Link>
                    </TableCell>
                    <TableCell className='text-sm text-muted-foreground'>
                      {task.assignee_name ?? '—'}
                    </TableCell>
                    <TableCell className='text-sm text-muted-foreground'>
                      {task.due_date ? formatDate(task.due_date) : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant='outline'
                        className={`text-[11px] ${STATUS_META[task.status].className}`}
                      >
                        {STATUS_META[task.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center gap-1 justify-end'>
                        {task.status === 'open' ? (
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
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className='max-w-lg max-h-[90vh] overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>New Task</DialogTitle>
          </DialogHeader>
          <DialogBody>
          <TaskForm
            collections={collections}
            users={users}
            onSave={(body) => createMut.mutate(body)}
            onCancel={() => setCreating(false)}
            saving={createMut.isPending}
          />
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Task</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className='text-sm text-muted-foreground'>
              Are you sure you want to delete{' '}
              <span className='font-medium text-foreground'>{deleting?.title}</span>? This cannot be
              undone.
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

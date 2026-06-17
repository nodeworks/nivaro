import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import type { SlotRendererProps } from '../LayoutForm'

interface Task {
  id: number
  title: string
  description: string | null
  assignee: string | null
  due_date: string | null
  status: string
  completed_at: string | null
}
interface User {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

function userName(u: User | undefined) {
  if (!u) return 'Unknown'
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}
function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function TasksSlot({
  collection,
  itemId,
  labelOverride,
  defaultExpanded
}: SlotRendererProps) {
  const client = useOptionalNivaroClient()
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<Task[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [adding, setAdding] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newAssignee, setNewAssignee] = useState('')
  const [newDueDate, setNewDueDate] = useState('')
  const [creating, setCreating] = useState(false)
  const mountedRef = useRef(true)
  const syncedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (!syncedRef.current && defaultExpanded !== undefined) {
      syncedRef.current = true
      setOpen(defaultExpanded)
    }
  }, [defaultExpanded])

  const fetchTasks = useCallback(async () => {
    if (!client || !itemId) return
    try {
      const res = await client.request<{ data: Task[] }>(
        get('/tasks', { collection, item: String(itemId) })
      )
      if (mountedRef.current) setTasks(res.data ?? [])
    } catch {
      if (mountedRef.current) setTasks([])
    }
  }, [client, collection, itemId])

  useEffect(() => {
    void fetchTasks()
  }, [fetchTasks])

  useEffect(() => {
    if (!client) return
    client
      .request<{ data: User[] }>(get('/users', { limit: 200 }))
      .then((res) => {
        if (mountedRef.current) setUsers(res.data ?? [])
      })
      .catch(() => {
        /* no-op */
      })
  }, [client])

  async function createTask() {
    if (!client || !newTitle.trim() || !newAssignee || creating) return
    setCreating(true)
    try {
      await client.request(
        post('/tasks', {
          collection,
          item: String(itemId),
          title: newTitle.trim(),
          assignee: newAssignee,
          due_date: newDueDate || undefined
        })
      )
      setAdding(false)
      setNewTitle('')
      setNewAssignee('')
      setNewDueDate('')
      await fetchTasks()
    } catch {
      /* no-op */
    } finally {
      if (mountedRef.current) setCreating(false)
    }
  }

  async function completeTask(id: number) {
    if (!client) return
    try {
      await client.request(post(`/tasks/${id}/complete`))
      await fetchTasks()
    } catch {
      /* no-op */
    }
  }

  async function deleteTask(id: number) {
    if (!client) return
    try {
      await client.request(del(`/tasks/${id}`))
      await fetchTasks()
    } catch {
      /* no-op */
    }
  }

  const openTasks = tasks.filter((t) => t.status !== 'completed')
  const completedTasks = tasks.filter((t) => t.status === 'completed')
  const usersById = new Map(users.map((u) => [u.id, u]))
  const now = Date.now()

  return (
    <div data-nf-slot='__tasks__' data-nf-slot-open={open ? 'true' : 'false'}>
      <button type='button' onClick={() => setOpen((v) => !v)} data-nf-slot-toggle>
        <svg
          data-nf-slot-icon
          width='14'
          height='14'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
        >
          <rect x='9' y='3' width='13' height='13' rx='2' />
          <path d='M5 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1' />
          <polyline points='16 3 12 7 10 5' />
        </svg>
        <span data-nf-slot-label>{labelOverride ?? 'Tasks'}</span>
        {!open && openTasks.length > 0 && <span data-nf-slot-count>{openTasks.length} open</span>}
        <svg
          data-nf-slot-chevron
          width='14'
          height='14'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
          aria-hidden='true'
        >
          <polyline points='6 9 12 15 18 9' />
        </svg>
      </button>

      {open && (
        <div data-nf-slot-content>
          <div data-nf-tasks-toolbar>
            {!adding && (
              <button type='button' data-nf-btn-outline onClick={() => setAdding(true)}>
                + Add task
              </button>
            )}
          </div>

          {/* Add task form */}
          {adding && (
            <div data-nf-task-form>
              <div data-nf-task-form-row>
                <label htmlFor='task-title-input' data-nf-task-label>
                  Title
                </label>
                <input
                  id='task-title-input'
                  type='text'
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder='What needs to be done?'
                  data-nf-task-input
                />
              </div>
              <div data-nf-task-form-grid>
                <div data-nf-task-form-row>
                  <label htmlFor='task-assignee-input' data-nf-task-label>
                    Assignee
                  </label>
                  <select
                    id='task-assignee-input'
                    value={newAssignee}
                    onChange={(e) => setNewAssignee(e.target.value)}
                    data-nf-task-input
                  >
                    <option value=''>Select assignee…</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {userName(u)}
                      </option>
                    ))}
                  </select>
                </div>
                <div data-nf-task-form-row>
                  <label htmlFor='task-due-input' data-nf-task-label>
                    Due date
                  </label>
                  <input
                    id='task-due-input'
                    type='date'
                    value={newDueDate}
                    onChange={(e) => setNewDueDate(e.target.value)}
                    data-nf-task-input
                  />
                </div>
              </div>
              <div data-nf-confirm-actions>
                <button type='button' data-nf-btn-ghost onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button
                  type='button'
                  data-nf-btn-primary
                  disabled={!newTitle.trim() || !newAssignee || creating}
                  onClick={() => void createTask()}
                >
                  {creating ? 'Creating…' : 'Create Task'}
                </button>
              </div>
            </div>
          )}

          {/* Open tasks */}
          {openTasks.length === 0 && !adding && <p data-nf-empty>No open tasks</p>}
          {openTasks.length > 0 && (
            <div data-nf-task-list>
              {openTasks.map((t) => {
                const overdue = t.due_date ? new Date(t.due_date).getTime() < now : false
                return (
                  <div key={t.id} data-nf-task-row>
                    <input
                      type='checkbox'
                      checked={false}
                      onChange={() => void completeTask(t.id)}
                      data-nf-task-checkbox
                      aria-label={`Complete: ${t.title}`}
                    />
                    <div data-nf-task-info>
                      <p data-nf-task-title>{t.title}</p>
                      {t.description && <p data-nf-task-desc>{t.description}</p>}
                      <div data-nf-task-meta>
                        {t.assignee && <span>{userName(usersById.get(t.assignee))}</span>}
                        {t.due_date && (
                          <span data-overdue={overdue ? 'true' : 'false'}>
                            Due {fmtDate(t.due_date)}
                            {overdue ? ' (overdue)' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type='button'
                      data-nf-icon-btn
                      data-nf-icon-btn-danger
                      title='Delete task'
                      onClick={() => void deleteTask(t.id)}
                    >
                      <svg
                        width='14'
                        height='14'
                        viewBox='0 0 24 24'
                        fill='none'
                        stroke='currentColor'
                        strokeWidth='2'
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        aria-hidden='true'
                      >
                        <line x1='18' y1='6' x2='6' y2='18' />
                        <line x1='6' y1='6' x2='18' y2='18' />
                      </svg>
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Completed tasks */}
          {completedTasks.length > 0 && (
            <div data-nf-completed-section>
              <button
                type='button'
                data-nf-history-toggle
                onClick={() => setShowCompleted((v) => !v)}
              >
                <svg
                  width='14'
                  height='14'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  style={{ transform: showCompleted ? 'rotate(90deg)' : undefined }}
                  aria-hidden='true'
                >
                  <polyline points='9 18 15 12 9 6' />
                </svg>
                Completed ({completedTasks.length})
              </button>
              {showCompleted && (
                <div data-nf-task-list data-nf-completed>
                  {completedTasks.map((t) => (
                    <div key={t.id} data-nf-task-row data-nf-task-done>
                      <input
                        type='checkbox'
                        checked
                        disabled
                        data-nf-task-checkbox
                        aria-label='Completed'
                      />
                      <div data-nf-task-info>
                        <p data-nf-task-title>{t.title}</p>
                        <div data-nf-task-meta>
                          {t.assignee && <span>{userName(usersById.get(t.assignee))}</span>}
                          {t.completed_at && <span>Done {relativeTime(t.completed_at)}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

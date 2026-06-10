import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCheck, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

const PAGE_SIZE = 25

type StatusFilter = 'all' | 'inbox' | 'read'

interface NotificationRow {
  id: number
  recipient?: string
  sender?: string | null
  sender_name?: string | null
  subject?: string | null
  title?: string | null
  message: string | null
  status?: string | null
  read?: boolean
  timestamp?: string | null
  created_at?: string | null
  collection: string | null
  item: string | null
}

function isUnread(n: NotificationRow): boolean {
  if (n.status != null) return n.status === 'inbox'
  return !n.read
}

const TABS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'inbox', label: 'Unread' },
  { key: 'read', label: 'Read' }
]

export function NotificationsCenterPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', 'center', status, page],
    queryFn: () =>
      api
        .get<{ data: NotificationRow[]; total: number }>('/notifications', {
          params: { page, limit: PAGE_SIZE, status }
        })
        .then((r) => r.data),
    placeholderData: keepPreviousData
  })

  const notifications = data?.data ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] })

  const markAllMut = useMutation({
    mutationFn: () => api.post('/notifications/mark-all-read'),
    onSuccess: () => {
      invalidate()
      toast.success('All notifications marked as read')
    },
    onError: () => toast.error('Failed to mark all read')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/notifications/${id}`),
    onSuccess: () => {
      invalidate()
      setConfirmDeleteId(null)
      toast.success('Notification deleted')
    },
    onError: () => toast.error('Failed to delete notification')
  })

  const handleRowClick = async (n: NotificationRow) => {
    if (isUnread(n)) {
      try {
        await api.post(`/notifications/${n.id}/read`)
        invalidate()
      } catch {
        /* non-fatal */
      }
    }
    if (n.collection && n.item) {
      navigate(`/collections/${n.collection}/${n.item}`)
    }
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Sticky page header */}
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-background'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='text-xl font-bold text-slate-900 dark:text-slate-100'>Notifications</h1>
            <p className='mt-0.5 text-[13px] text-slate-400'>
              {total} notification{total === 1 ? '' : 's'}
            </p>
          </div>
          <Button
            size='sm'
            variant='outline'
            className='h-8 text-[12px]'
            onClick={() => markAllMut.mutate()}
            disabled={markAllMut.isPending}
          >
            <CheckCheck className='mr-1.5 h-3.5 w-3.5' />
            {markAllMut.isPending ? 'Marking…' : 'Mark all read'}
          </Button>
        </div>
        {/* Filter tabs */}
        <div className='mt-4 flex items-center gap-1'>
          {TABS.map((t) => (
            <button
              key={t.key}
              type='button'
              onClick={() => {
                setStatus(t.key)
                setPage(1)
              }}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                status === t.key
                  ? 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700 dark:hover:bg-slate-800/50'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {/* List */}
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        {isLoading ? (
          <p className='px-8 py-10 text-[13px] text-slate-400'>Loading…</p>
        ) : notifications.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <Bell className='h-10 w-10 text-slate-200 dark:text-slate-700' />
            <p className='mt-3 text-[14px] font-medium text-slate-500'>You're all caught up</p>
            <p className='mt-1 text-[12px] text-slate-400'>
              {status === 'inbox' ? 'No unread notifications.' : 'No notifications here.'}
            </p>
          </div>
        ) : (
          <div className='mx-8 my-6 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
            {notifications.map((n) => {
              const unread = isUnread(n)
              return (
                <div
                  key={n.id}
                  className='group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40'
                >
                  {/* Unread dot — subtle left-edge marker */}
                  <span
                    className={cn(
                      'mt-2 h-2 w-2 shrink-0 rounded-full',
                      unread ? 'bg-nvr-cyan' : 'bg-transparent'
                    )}
                  />
                  <div className='min-w-0 flex-1'>
                    <button
                      type='button'
                      onClick={() => handleRowClick(n)}
                      className='block w-full text-left'
                    >
                      <div className='flex items-baseline gap-2'>
                        <span
                          className={cn(
                            'truncate text-[13px]',
                            unread
                              ? 'font-medium text-slate-900 dark:text-slate-100'
                              : 'font-normal text-slate-600 dark:text-slate-400'
                          )}
                        >
                          {n.subject ?? n.title ?? '—'}
                        </span>
                        <span className='shrink-0 text-[10.5px] text-slate-400'>
                          {formatRelative(n.timestamp ?? n.created_at ?? new Date())}
                        </span>
                      </div>
                      {n.message && (
                        <p className='mt-0.5 line-clamp-2 text-[12px] text-slate-500'>
                          {n.message}
                        </p>
                      )}
                    </button>
                    <div className='mt-1 flex items-center gap-2'>
                      {(n.sender_name || n.sender) && (
                        <span className='text-[11px] text-slate-400'>
                          From {n.sender_name ?? n.sender}
                        </span>
                      )}
                      {n.collection && n.item && (
                        <Link
                          to={`/collections/${n.collection}/${n.item}`}
                          className='inline-flex items-center gap-1 rounded-full bg-nvr-cyan/10 px-2 py-0.5 font-mono text-[10px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                        >
                          {n.collection} #{n.item}
                        </Link>
                      )}
                    </div>
                  </div>
                  {/* Delete with inline confirm */}
                  <div className='shrink-0'>
                    {confirmDeleteId === n.id ? (
                      <div className='flex items-center gap-1.5'>
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-6 px-2 text-[11px]'
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size='sm'
                          className='h-6 bg-red-500 px-2 text-[11px] text-white hover:bg-red-600'
                          disabled={deleteMut.isPending}
                          onClick={() => deleteMut.mutate(n.id)}
                        >
                          {deleteMut.isPending ? 'Deleting…' : 'Delete'}
                        </Button>
                      </div>
                    ) : (
                      <button
                        type='button'
                        onClick={() => setConfirmDeleteId(n.id)}
                        className='rounded p-1.5 text-slate-300 opacity-0 transition-all hover:bg-red-50 hover:text-red-400 group-hover:opacity-100'
                        aria-label='Delete notification'
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Pagination footer */}
        {total > PAGE_SIZE && (
          <div className='mx-8 mb-6 flex items-center justify-between'>
            <p className='text-[12px] text-slate-400'>
              Page {page} of {totalPages}
            </p>
            <div className='flex items-center gap-2'>
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[12px]'
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className='mr-1 h-3.5 w-3.5' />
                Previous
              </Button>
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[12px]'
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
                <ChevronRight className='ml-1 h-3.5 w-3.5' />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

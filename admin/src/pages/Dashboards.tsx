import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutGrid, Plus, Trash2, Users } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
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
import { Skeleton } from '@/components/ui/skeleton'
import { api, type Dashboard } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'

// ─── Create dialog ────────────────────────────────────────────────────────────

function CreateDashboardDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [isShared, setIsShared] = useState(false)

  const create = useMutation({
    mutationFn: (body: { name: string; is_shared: boolean }) =>
      api.post<{ data: Dashboard }>('/dashboards', body).then((r) => r.data.data),
    onSuccess: (dashboard) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] })
      onOpenChange(false)
      setName('')
      setIsShared(false)
      toast.success('Dashboard created')
      navigate(`/dashboards/${dashboard.id}`)
    },
    onError: () => toast.error('Failed to create dashboard')
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    create.mutate({ name: name.trim(), is_shared: isShared })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Dashboard</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogBody>
            <div className='space-y-4'>
              <div className='space-y-1.5'>
                <Label htmlFor='dashboard-name'>
                  Name <span className='text-red-500'>*</span>
                </Label>
                <Input
                  id='dashboard-name'
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder='e.g. Operations Overview'
                  required
                  autoFocus
                />
              </div>
              <div className='flex items-center gap-2'>
                <input
                  type='checkbox'
                  id='dashboard-shared'
                  checked={isShared}
                  onChange={(e) => setIsShared(e.target.checked)}
                  className='h-4 w-4 rounded border-slate-300 text-nvr-cyan accent-nvr-cyan'
                />
                <Label htmlFor='dashboard-shared' className='cursor-pointer font-normal'>
                  Shared — visible to all users
                </Label>
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={create.isPending || !name.trim()}>
              {create.isPending ? 'Creating…' : 'Create Dashboard'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function DashboardsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api.get<{ data: Dashboard[] }>('/dashboards').then((r) => r.data.data)
  })

  const dashboards = data ?? []

  const deleteDashboard = useMutation({
    mutationFn: (id: string) => api.delete(`/dashboards/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] })
      setPendingDelete(null)
      toast.success('Dashboard deleted')
    },
    onError: () => toast.error('Failed to delete dashboard')
  })

  return (
    <>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white dark:border-white/[0.07] dark:bg-[#0d1117] px-8 py-5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100'>
              Dashboards
            </h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 dark:bg-white/[0.08] px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400'>
                {dashboards.length}
              </span>
            )}
          </div>
          <Button size='sm' onClick={() => setShowCreate(true)}>
            <Plus className='mr-1.5 h-3.5 w-3.5' />
            New Dashboard
          </Button>
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────── */}
      <div className='p-8'>
        {isLoading ? (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
            {(['a', 'b', 'c'] as const).map((k) => (
              <div
                key={k}
                className='rounded-xl border border-slate-200 dark:border-white/[0.07] bg-white dark:bg-[#161b22] p-5'
              >
                <Skeleton className='mb-2 h-5 w-32' />
                <Skeleton className='h-4 w-20' />
              </div>
            ))}
          </div>
        ) : dashboards.length === 0 ? (
          <div className='flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 dark:border-white/[0.10] bg-white dark:bg-[#161b22] py-20'>
            <div className='flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 dark:bg-white/[0.06]'>
              <LayoutGrid className='h-8 w-8 text-slate-400' />
            </div>
            <h3 className='mt-4 text-[15px] font-semibold text-slate-700 dark:text-slate-300'>
              No dashboards yet
            </h3>
            <p className='mt-1.5 max-w-xs text-center text-[13px] text-slate-400'>
              Create a dashboard and add KPI widgets to monitor your collections.
            </p>
            <Button className='mt-6' onClick={() => setShowCreate(true)}>
              <Plus className='mr-1.5 h-3.5 w-3.5' /> Create your first dashboard
            </Button>
          </div>
        ) : (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
            {dashboards.map((d) => (
              <button
                key={d.id}
                type='button'
                className='group relative w-full text-left rounded-xl border border-slate-200 dark:border-white/[0.07] bg-white dark:bg-[#161b22] p-5 transition-shadow hover:shadow-md cursor-pointer'
                onClick={() => navigate(`/dashboards/${d.id}`)}
              >
                {/* Delete control */}
                <div className='absolute right-3 top-3 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
                  {pendingDelete === d.id ? (
                    <>
                      <button
                        type='button'
                        className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600'
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteDashboard.mutate(d.id)
                        }}
                      >
                        Confirm
                      </button>
                      <button
                        type='button'
                        className='rounded border px-2 py-0.5 text-[11px] hover:bg-slate-50 dark:hover:bg-white/[0.05]'
                        onClick={(e) => {
                          e.stopPropagation()
                          setPendingDelete(null)
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type='button'
                      className='rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10'
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingDelete(d.id)
                      }}
                      aria-label='Delete dashboard'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  )}
                </div>

                {/* Icon + name */}
                <div className='flex items-start gap-3'>
                  <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nvr-cyan/10'>
                    <LayoutGrid className='h-4.5 w-4.5 text-nvr-cyan' />
                  </div>
                  <div className='min-w-0'>
                    <p className='truncate text-[14px] font-semibold text-slate-800 dark:text-slate-100'>
                      {d.name}
                    </p>
                    <p className='text-[12px] text-slate-400 dark:text-slate-500'>
                      {d.widgets?.length ?? 0} widget{(d.widgets?.length ?? 0) !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>

                {/* Footer */}
                <div
                  className={cn(
                    'mt-4 flex items-center gap-2',
                    d.is_shared ? 'justify-between' : 'justify-end'
                  )}
                >
                  {d.is_shared && (
                    <Badge
                      variant='outline'
                      className='h-5 gap-1 px-1.5 text-[10px] text-slate-500 border-slate-200 dark:border-white/[0.10]'
                    >
                      <Users className='h-3 w-3' />
                      Shared
                    </Badge>
                  )}
                  <span className='text-[11px] text-slate-400'>{formatDate(d.updated_at)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <CreateDashboardDialog open={showCreate} onOpenChange={setShowCreate} />
    </>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BarChart3, Globe, Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'

/**
 * Report Studio — list. Reports are user-composed widget grids over any
 * collection; open one to build or watch it.
 */

export interface ReportDef {
  id: string
  name: string
  icon: string | null
  description: string | null
  owner: string
  is_shared: boolean
  role_id: string | null
  widget_count?: number
  updated_at: string
}

export function ReportStudioPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const { data: reports = [], isLoading } = useQuery({
    queryKey: ['report-defs'],
    queryFn: () => api.get<{ data: ReportDef[] }>('/report-studio/').then((r) => r.data.data)
  })
  // Admin-only usage rollup — non-admins get a silent 403 and no usage column.
  const { data: usage = {} as Record<string, { last_viewed: string; views_30d: number; viewers_30d: number }> } = useQuery({
    queryKey: ['report-usage'],
    queryFn: () =>
      api
        .get<{ data: Record<string, { last_viewed: string; views_30d: number; viewers_30d: number } > }>(
          '/report-studio/usage'
        )
        .then((r) => r.data.data)
        .catch(() => ({}) as Record<string, { last_viewed: string; views_30d: number; viewers_30d: number }>),
    staleTime: 60_000
  })
  const STALE_MS = 90 * 86_400_000

  const create = useMutation({
    mutationFn: () => api.post<{ data: ReportDef }>('/report-studio/', { name }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['report-defs'] })
      navigate(`/report-studio/${r.data.data.id}`)
    },
    onError: () => toast.error('Could not create the report')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <BarChart3 className='h-4 w-4 text-nvr-cyan' />
          <div>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Report Studio
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Compose KPI, chart and table widgets over any collection — subscribe, alert, share.
            </p>
          </div>
          <div className='ml-auto flex items-center gap-2'>
            {creating ? (
              <form
                className='flex items-center gap-2'
                onSubmit={(e) => {
                  e.preventDefault()
                  if (name.trim()) create.mutate()
                }}
              >
                <Input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder='Report name'
                  className='h-8 w-56 text-[13px]'
                />
                <Button size='sm' type='submit' disabled={!name.trim() || create.isPending}>
                  Create
                </Button>
                <Button size='sm' variant='ghost' type='button' onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <Button size='sm' onClick={() => setCreating(true)}>
                <Plus className='mr-1.5 h-3.5 w-3.5' /> New report
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 px-6 py-5 dark:bg-background'>
        {isLoading ? (
          <p className='text-[13px] text-slate-400'>Loading…</p>
        ) : reports.length === 0 ? (
          <div className='max-w-md py-10'>
            <BarChart3 className='h-8 w-8 text-slate-300' />
            <h2 className='mt-4 text-[15px] font-semibold text-slate-800 dark:text-foreground'>
              No reports yet
            </h2>
            <p className='mt-1.5 text-[12.5px] leading-relaxed text-slate-500'>
              A report is a grid of widgets — counts, sums, charts and tables — built over your
              collections. Create one and add your first widget.
            </p>
            <Button size='sm' className='mt-4' onClick={() => setCreating(true)}>
              <Plus className='mr-1.5 h-3.5 w-3.5' /> New report
            </Button>
          </div>
        ) : (
          <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            {reports.map((r, i) => (
              <button
                key={r.id}
                type='button'
                onClick={() => navigate(`/report-studio/${r.id}`)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-muted/40 ${i > 0 ? 'border-t border-slate-100 dark:border-border/50' : ''}`}
              >
                <BarChart3 className='h-4 w-4 shrink-0 text-slate-300' />
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-[13.5px] font-medium text-slate-800 dark:text-foreground'>
                    {r.name}
                  </span>
                  {r.description && (
                    <span className='block truncate text-[11.5px] text-slate-400'>
                      {r.description}
                    </span>
                  )}
                </span>
                {r.is_shared && (
                  <Badge variant='outline' className='h-4 gap-1 px-1.5 text-[10px] text-slate-500'>
                    <Globe className='h-2.5 w-2.5' /> shared
                  </Badge>
                )}
                <span className='shrink-0 text-[11.5px] text-slate-400'>
                  {r.widget_count ?? 0} widget{(r.widget_count ?? 0) === 1 ? '' : 's'}
                </span>
                {(() => {
                  const u = usage[r.id]
                  if (Object.keys(usage).length === 0) return null
                  if (!u || Date.now() - new Date(u.last_viewed).getTime() > STALE_MS) {
                    return (
                      <Badge
                        variant='outline'
                        className='h-4 shrink-0 border-amber-300 px-1.5 text-[10px] text-amber-600 dark:border-amber-500/50 dark:text-amber-400'
                      >
                        {u ? 'unused 90d+' : 'never viewed'}
                      </Badge>
                    )
                  }
                  return (
                    <span className='shrink-0 text-[11px] text-slate-400'>
                      {u.views_30d} view{u.views_30d === 1 ? '' : 's'} · {u.viewers_30d}{' '}
                      {u.viewers_30d === 1 ? 'person' : 'people'} (30d)
                    </span>
                  )
                })()}
                <span className='w-24 shrink-0 text-right text-[11.5px] text-slate-400'>
                  {formatRelative(r.updated_at)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

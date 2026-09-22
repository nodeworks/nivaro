import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type CustomQuery = {
  id: string
  name: string
  slug: string
  access: 'admin' | 'authenticated'
  cache_ttl: number
  enabled: boolean
}

// ─── Main page ────────────────────────────────────────────────────────────────

interface CacheStatRow {
  id: number | null
  name: string
  slug: string
  cache_ttl: number
  enabled: boolean
  runs: number
  hits: number
  misses: number
  bypasses: number
  uncached_runs: number
  hit_rate: number | null
  avg_exec_ms: number | null
  exec_ms_max: number
  saved_ms: number
  last_run_at: string | null
  advice: string | null
}

const ms = (v: number | null | undefined) =>
  v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`

/**
 * What each TTL actually buys (#476): hits × average execution, per query,
 * since this API process started — and the queries that never cache but take
 * seconds, which nothing surfaced before.
 */
function CacheHealthCard() {
  const [open, setOpen] = useState(true)
  const { data } = useQuery({
    queryKey: ['custom-queries', 'cache-stats'],
    queryFn: () =>
      api
        .get<{ data: { since: string; rows: CacheStatRow[]; silent: CacheStatRow[] } }>(
          '/custom-queries/cache-stats'
        )
        .then((r) => r.data.data),
    refetchInterval: 30_000
  })
  const rows = data?.rows ?? []
  const advised = rows.filter((r) => r.advice)
  const totalSaved = rows.reduce((n, r) => n + r.saved_ms, 0)
  if (!data) return null
  return (
    <section
      className='mb-6 rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-cache-health
    >
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-3 px-5 py-3 text-left'
      >
        <span className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          Cache health
        </span>
        <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          since {new Date(data.since).toLocaleString()} · {rows.length} queries ran ·{' '}
          {ms(totalSaved)} of execution spared by caching
          {advised.length ? ` · ${advised.length} worth a look` : ''}
        </span>
        <span className='ml-auto text-[11px] text-slate-400'>{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className='border-t border-slate-100 dark:border-border'>
          {advised.length > 0 && (
            <ul className='space-y-1 border-b border-slate-100 px-5 py-3 dark:border-border'>
              {advised.map((r) => (
                <li
                  key={r.slug}
                  className='text-[12px] text-amber-800 dark:text-amber-300'
                  data-cache-advice={r.slug}
                >
                  <span className='font-medium'>{r.name}</span> — {r.advice}
                </li>
              ))}
            </ul>
          )}
          <table className='w-full text-left text-[12px]'>
            <thead>
              <tr className='border-b border-slate-100 bg-slate-50 text-[11px] text-slate-500 dark:border-border dark:bg-background dark:text-muted-foreground'>
                <th className='px-5 py-2 font-medium'>Query</th>
                <th className='px-3 py-2 text-right font-medium'>TTL</th>
                <th className='px-3 py-2 text-right font-medium'>Runs</th>
                <th className='px-3 py-2 text-right font-medium'>Hit rate</th>
                <th className='px-3 py-2 text-right font-medium'>Avg exec</th>
                <th className='px-3 py-2 text-right font-medium'>Max</th>
                <th className='px-3 py-2 text-right font-medium'>Spared</th>
                <th className='px-5 py-2 text-right font-medium'>Last run</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-slate-100 dark:divide-border'>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className='px-5 py-4 text-[12px] text-slate-400'>
                    No query has run since this API process started.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.slug} data-cache-row={r.slug}>
                  <td className='px-5 py-1.5'>
                    <span className='font-medium text-slate-800 dark:text-foreground'>
                      {r.name}
                    </span>
                    <span className='ml-2 font-mono text-[11px] text-slate-400'>{r.slug}</span>
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right tabular-nums ${r.cache_ttl === 0 ? 'text-amber-700 dark:text-amber-400' : ''}`}
                  >
                    {r.cache_ttl === 0 ? 'off' : `${r.cache_ttl}s`}
                  </td>
                  <td className='px-3 py-1.5 text-right tabular-nums'>{r.runs}</td>
                  <td className='px-3 py-1.5 text-right tabular-nums'>
                    {r.hit_rate == null ? '—' : `${Math.round(r.hit_rate * 100)}%`}
                    {r.bypasses ? (
                      <span className='ml-1 text-[10.5px] text-slate-400'>
                        ({r.bypasses} refresh)
                      </span>
                    ) : null}
                  </td>
                  <td className='px-3 py-1.5 text-right tabular-nums'>{ms(r.avg_exec_ms)}</td>
                  <td className='px-3 py-1.5 text-right tabular-nums'>
                    {r.exec_ms_max ? ms(r.exec_ms_max) : '—'}
                  </td>
                  <td className='px-3 py-1.5 text-right tabular-nums'>
                    {r.saved_ms ? ms(r.saved_ms) : '—'}
                  </td>
                  <td className='px-5 py-1.5 text-right text-slate-400'>
                    {r.last_run_at ? new Date(r.last_run_at).toLocaleTimeString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data.silent?.length ?? 0) > 0 && (
            <p className='px-5 py-2 text-[11px] text-slate-400'>
              Not run since boot: {data.silent.map((q) => q.name).join(', ')}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

export function CustomQueriesPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['custom-queries'],
    queryFn: () => api.get('/custom-queries').then((r) => r.data)
  })

  const queries: CustomQuery[] = data?.data ?? []

  const deleteQuery = useMutation({
    mutationFn: (id: string) => api.delete(`/custom-queries/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-queries'] })
      setPendingDelete(null)
      toast.success('Query deleted')
    },
    onError: () => toast.error('Failed to delete query')
  })

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900'>
              Custom Queries
            </h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500'>
                {queries.length}
              </span>
            )}
          </div>
          <Button size='sm' onClick={() => navigate('/custom-queries/new')}>
            <Plus className='mr-1.5 h-3.5 w-3.5' /> New Query
          </Button>
        </div>
      </div>

      <div className='p-8'>
        <CacheHealthCard />
        {isLoading ? (
          <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
            <div className='divide-y divide-slate-100'>
              {(['a', 'b', 'c', 'd'] as const).map((k) => (
                <div key={k} className='flex items-center gap-4 px-5 py-4'>
                  <Skeleton className='h-4 w-40' />
                  <Skeleton className='h-4 w-24' />
                  <Skeleton className='ml-auto h-4 w-16' />
                </div>
              ))}
            </div>
          </div>
        ) : isError ? (
          <div className='py-20 text-center text-[13px] text-red-500'>Failed to load queries.</div>
        ) : queries.length === 0 ? (
          <div className='flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white py-20'>
            <div className='flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100'>
              <Database className='h-8 w-8 text-slate-400' />
            </div>
            <h3 className='mt-4 text-[15px] font-semibold text-slate-700'>No custom queries yet</h3>
            <p className='mt-1.5 text-[13px] text-slate-400'>
              Define parameterized SQL queries exposed as named endpoints.
            </p>
            <Button className='mt-6' onClick={() => navigate('/custom-queries/new')}>
              <Plus className='mr-1.5 h-3.5 w-3.5' /> Create your first query
            </Button>
          </div>
        ) : (
          <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
            <table className='w-full text-left'>
              <thead>
                <tr className='border-b border-slate-100 bg-slate-50'>
                  <th className='px-5 py-2.5 text-[11px] font-medium text-slate-500'>Name</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Slug</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Access</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Cache</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Enabled</th>
                  <th className='w-24 px-5 py-2.5' />
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100'>
                {queries.map((q) => (
                  <tr key={q.id} className='group hover:bg-slate-50'>
                    <td className='px-5 py-3.5'>
                      <p className='text-[13px] font-medium text-slate-800'>{q.name}</p>
                    </td>
                    <td className='px-4 py-3.5'>
                      <span className='font-mono text-[11px] text-slate-500'>{q.slug}</span>
                    </td>
                    <td className='px-4 py-3.5'>
                      <Badge variant='outline' className='h-4 px-1.5 text-[10px] capitalize'>
                        {q.access}
                      </Badge>
                    </td>
                    <td className='px-4 py-3.5 text-[13px] text-slate-500'>
                      {q.cache_ttl > 0 ? (
                        `${q.cache_ttl}s`
                      ) : (
                        <span className='text-slate-400'>No cache</span>
                      )}
                    </td>
                    <td className='px-4 py-3.5'>
                      <Badge
                        variant='outline'
                        className={cn(
                          'h-4 px-1.5 text-[10px]',
                          q.enabled
                            ? 'bg-green-100 text-green-700 border-green-200'
                            : 'bg-slate-100 text-slate-500 border-slate-200'
                        )}
                      >
                        {q.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                    </td>
                    <td className='px-5 py-3.5'>
                      <div className='flex items-center justify-end gap-1'>
                        <button
                          type='button'
                          onClick={() => navigate(`/custom-queries/${q.id}`)}
                          className='rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-500 opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-800'
                        >
                          Edit
                        </button>
                        {pendingDelete === q.id ? (
                          <div className='flex items-center gap-1'>
                            <button
                              type='button'
                              className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600'
                              onClick={() => deleteQuery.mutate(q.id)}
                            >
                              Confirm
                            </button>
                            <button
                              type='button'
                              className='rounded border px-2 py-0.5 text-[11px] hover:bg-slate-50'
                              onClick={() => setPendingDelete(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type='button'
                            className='rounded-lg p-1.5 text-slate-400 opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:bg-red-50 hover:text-red-500'
                            onClick={() => setPendingDelete(q.id)}
                            aria-label='Delete query'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

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
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
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

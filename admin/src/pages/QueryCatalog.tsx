import { useMutation, useQuery } from '@tanstack/react-query'
import { BookOpen, Play } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Query catalog (#238): the runnable custom queries any authenticated user
 * may execute, with parameter forms. SQL never reaches the client — only
 * name/description/params, and results come from the normal execute route
 * (User-Scope injection and caching apply exactly as everywhere else).
 */

interface CatalogQuery {
  id: number
  slug: string
  name: string
  description: string | null
  params: Array<{ name: string; type?: string; required?: boolean; default?: string }>
}

export default function QueryCatalogPage() {
  const [search, setSearch] = useState('')
  const [openSlug, setOpenSlug] = useState<string | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ slug: string; rows: Array<Record<string, unknown>> } | null>(null)

  const { data: queries = [], isLoading } = useQuery<CatalogQuery[]>({
    queryKey: ['query-catalog'],
    queryFn: () => api.get<{ data: CatalogQuery[] }>('/custom-queries/catalog').then((r) => r.data.data)
  })

  const run = useMutation({
    mutationFn: (q: CatalogQuery) =>
      api
        .post<{ data: Array<Record<string, unknown>> }>(`/custom-queries/${q.slug}/execute`, {
          params: Object.fromEntries(
            Object.entries(paramValues).filter(([, v]) => v !== '')
          )
        })
        .then((r) => ({ slug: q.slug, rows: r.data.data ?? [] })),
    onSuccess: setResult,
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Query failed')
  })

  const needle = search.trim().toLowerCase()
  const visible = needle
    ? queries.filter(
        (q) =>
          q.name.toLowerCase().includes(needle) || (q.description ?? '').toLowerCase().includes(needle)
      )
    : queries
  const cols = result?.rows[0] ? Object.keys(result.rows[0]) : []

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <BookOpen className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Query Catalog
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Saved queries you can run — fill the parameters and go. Your data scopes apply.
            </p>
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search queries…'
            className='ml-auto h-8 w-64 text-[13px]'
          />
        </div>
      </header>

      <div className='flex-1 overflow-y-auto p-6'>
        {isLoading ? (
          <p className='text-[13px] text-slate-400'>Loading…</p>
        ) : visible.length === 0 ? (
          <p className='text-[13px] text-slate-400'>
            No runnable queries{needle ? ' match your search' : ' are published yet'}.
          </p>
        ) : (
          <div className='space-y-2'>
            {visible.map((q) => {
              const open = openSlug === q.slug
              return (
                <div key={q.id} className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  <button
                    type='button'
                    onClick={() => {
                      setOpenSlug(open ? null : q.slug)
                      setParamValues(
                        Object.fromEntries((q.params ?? []).map((p) => [p.name, p.default ?? '']))
                      )
                      setResult(null)
                    }}
                    className='flex w-full items-center justify-between px-4 py-3 text-left'
                  >
                    <div>
                      <p className='text-[13.5px] font-medium text-slate-800 dark:text-slate-100'>{q.name}</p>
                      {q.description && (
                        <p className='mt-0.5 text-[12px] text-slate-500'>{q.description}</p>
                      )}
                    </div>
                    <span className='text-[11px] text-slate-400'>
                      {q.params.length} param{q.params.length === 1 ? '' : 's'}
                    </span>
                  </button>
                  {open && (
                    <div className='space-y-3 border-t border-slate-100 px-4 py-3 dark:border-border/60'>
                      {q.params.length > 0 && (
                        <div className='flex flex-wrap items-end gap-3'>
                          {q.params.map((p) => (
                            <label key={p.name} className='space-y-0.5'>
                              <span className='block text-[11px] font-medium text-slate-500'>
                                {p.name}
                                {p.required && <span className='text-red-500'> *</span>}
                              </span>
                              <Input
                                value={paramValues[p.name] ?? ''}
                                onChange={(e) =>
                                  setParamValues((v) => ({ ...v, [p.name]: e.target.value }))
                                }
                                placeholder={p.type ?? 'value'}
                                className='h-8 w-44 text-[12.5px]'
                              />
                            </label>
                          ))}
                        </div>
                      )}
                      <Button
                        type='button'
                        size='sm'
                        disabled={
                          run.isPending ||
                          q.params.some((p) => p.required && !(paramValues[p.name] ?? '').trim())
                        }
                        onClick={() => run.mutate(q)}
                      >
                        <Play className='mr-1 h-3.5 w-3.5' />
                        {run.isPending ? 'Running…' : 'Run'}
                      </Button>
                      {result?.slug === q.slug && (
                        <div className='overflow-auto rounded-md border border-slate-200 dark:border-border'>
                          {result.rows.length === 0 ? (
                            <p className='px-3 py-4 text-[12px] text-slate-400'>No rows.</p>
                          ) : (
                            <table className='w-full text-[11.5px] tabular-nums'>
                              <thead>
                                <tr className='text-left text-[10px] uppercase tracking-wide text-slate-400'>
                                  {cols.map((c) => (
                                    <th key={c} className='whitespace-nowrap px-2.5 py-1.5'>{c}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className='divide-y divide-slate-50 dark:divide-border/40'>
                                {result.rows.slice(0, 100).map((r, i) => (
                                  // biome-ignore lint/suspicious/noArrayIndexKey: result rows
                                  <tr key={i}>
                                    {cols.map((c) => (
                                      <td key={c} className='max-w-[260px] truncate whitespace-nowrap px-2.5 py-1 text-slate-700 dark:text-slate-200'>
                                        {r[c] == null ? '—' : String(r[c])}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

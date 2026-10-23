import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { api } from '@/lib/api'

/**
 * Config-wide search (#37): "who references update_workflow.php" across
 * flows, rules, transitions, layouts, queues, external APIs, custom queries,
 * import templates, report widgets, field config — one query.
 */

interface Hit {
  id: unknown
  name: string
  snippet: string
  link: string
}

export default function ConfigSearch() {
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(input.trim()), 400)
    return () => clearTimeout(t)
  }, [input])

  const { data, isFetching } = useQuery<{
    groups: Array<{ surface: string; hits: Hit[] }>
    total: number
  }>({
    queryKey: ['config-search', q],
    queryFn: () => api.get('/config-search', { params: { q } }).then((r) => r.data.data),
    enabled: q.length >= 2
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Search every configuration surface at once: find what references an endpoint, a field, a state key or a template.'>
        <input
          // biome-ignore lint/a11y/noAutofocus: the page IS the search box
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='e.g. update_order.php, total_amount, waiting_on_review…'
          className='mt-3 h-9 w-full max-w-[640px] rounded-md border border-slate-200 bg-background px-3 font-mono text-[13px] dark:border-border'
        />
      </HubToolbar>

      <div className='flex-1 overflow-y-auto p-4 sm:p-6'>
        {q.length < 2 ? (
          <p className='text-[13px] text-slate-400'>Type at least two characters.</p>
        ) : isFetching ? (
          <p className='text-[13px] text-slate-400'>Searching every surface…</p>
        ) : (data?.groups ?? []).length === 0 ? (
          <p className='text-[13px] text-slate-400'>Nothing references “{q}”.</p>
        ) : (
          <div className='max-w-[880px] space-y-4'>
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              {data?.total} hit{data?.total === 1 ? '' : 's'} across {data?.groups.length} surface
              {data?.groups.length === 1 ? '' : 's'}
            </p>
            {data?.groups.map((g) => (
              <div
                key={g.surface}
                className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
              >
                <p className='border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-border/60'>
                  {g.surface}
                  <span className='ml-1.5 font-normal normal-case text-slate-400'>
                    {g.hits.length}
                  </span>
                </p>
                <div className='divide-y divide-slate-50 dark:divide-border/40'>
                  {g.hits.map((h, i) => (
                    <Link
                      key={`${String(h.id)}-${i}`}
                      to={h.link}
                      className='block px-4 py-2 hover:bg-slate-50 dark:hover:bg-muted/50'
                    >
                      <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                        {h.name}
                      </p>
                      {h.snippet && (
                        <p className='mt-0.5 truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {h.snippet}
                        </p>
                      )}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { Activity } from 'lucide-react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Requests running right now on every API replica (#2761): route, age, who asked, what phase
 * and the SQL in progress with its wait type. Polls every 2 s while the page is open, which is
 * also what makes the replicas publish. Cancel lives on the Traffic Map.
 */

interface Row {
  id: string
  node: string
  method: string
  route: string
  age_ms: number
  person: string | null
  caller: string
  phase: 'auth' | 'sql' | 'handler'
  running: Array<{ sql: string; age_ms: number }>
  wait: { wait_type: string | null; wait_ms: number; blocked_by: number | null } | null
}
interface Data {
  rows: Row[]
  total: number
  nodes: Array<{ node: string; total: number; self: boolean }>
}

const PHASE: Record<Row['phase'], string> = {
  auth: 'Signing in',
  sql: 'In SQL',
  handler: 'In the handler'
}

function age(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

export function InflightRequestsCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['ops-inflight'],
    queryFn: () => api.get<{ data: Data }>('/ops-runtime/inflight').then((r) => r.data.data),
    refetchInterval: 2000
  })
  return (
    <section
      data-ops-inflight
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <header className='flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <div className='flex items-center gap-2'>
          <Activity className='h-4 w-4 text-slate-400' />
          <div>
            <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
              Requests in flight
            </h2>
            <p className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
              Every replica, oldest first
              {data
                ? ` · ${data.total} running on ${data.nodes.length} replica${data.nodes.length === 1 ? '' : 's'}`
                : ''}
            </p>
          </div>
        </div>
        <Link
          to='/traffic-map'
          className='text-[11.5px] text-slate-500 underline-offset-2 hover:underline dark:text-muted-foreground'
        >
          Cancel on the Traffic Map
        </Link>
      </header>
      <div className='max-h-[260px] overflow-auto'>
        {isLoading ? (
          <div className='space-y-2 p-4'>
            <Skeleton className='h-4 w-full' />
            <Skeleton className='h-4 w-2/3' />
          </div>
        ) : isError || !data ? (
          <p className='p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
            The list could not be read. It retries every few seconds.
          </p>
        ) : data.rows.length === 0 ? (
          <p className='p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Nothing in flight. Every request has been answered.
          </p>
        ) : (
          <ul className='divide-y divide-slate-100 dark:divide-border/60'>
            {data.rows.map((r) => {
              const sql = r.running[0]
              return (
                <li key={`${r.node}:${r.id}`} className='px-4 py-2 text-[12px]'>
                  <div className='flex min-w-0 items-baseline gap-2'>
                    <span
                      className={cn(
                        'w-[72px] shrink-0 tabular-nums',
                        r.age_ms >= 5000
                          ? 'font-semibold text-amber-700 dark:text-amber-300'
                          : 'text-slate-600 dark:text-muted-foreground'
                      )}
                    >
                      {age(r.age_ms)}
                    </span>
                    <span
                      className='min-w-0 flex-1 truncate font-mono text-[11px]'
                      data-tip={r.route}
                    >
                      {r.method} {r.route}
                    </span>
                    <span className='max-w-[30%] shrink-0 truncate text-slate-500 dark:text-muted-foreground'>
                      {r.person ?? (r.caller === 'anon' ? 'Not signed in' : r.caller)} · {r.node}
                    </span>
                  </div>
                  <p className='mt-0.5 truncate pl-[80px] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {PHASE[r.phase]}
                    {sql ? (
                      <>
                        {r.wait?.wait_type
                          ? ` · waiting on ${r.wait.wait_type} ${age(r.wait.wait_ms)}${r.wait.blocked_by ? `, blocked by session ${r.wait.blocked_by}` : ''}`
                          : ''}
                        {' · '}
                        <span className='font-mono text-[11px]' data-tip={sql.sql}>
                          {sql.sql}
                        </span>
                      </>
                    ) : null}
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

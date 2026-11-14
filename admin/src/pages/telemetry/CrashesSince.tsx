import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Bug } from 'lucide-react'
import { Link } from 'react-router'
import type { CrashList } from '@/components/crashes-view'
import { api } from '@/lib/api'
import { Card, Dot } from './ui'

function Empty({ children }: { children: string }) {
  return <p className='m-0 text-[12.5px] text-muted-foreground'>{children}</p>
}

/**
 * Front-end crashes since each app's current release (Issue Log → Crashes): how many crash
 * groups, how many are new in that release, how often and to how many people. One read of
 * GET /issues/crashes?days=7 — the same answer the Crashes tab shows.
 */
export function CrashesSince() {
  const { data, isLoading, isError } = useQuery<CrashList>({
    queryKey: ['issues', 'crashes', 'days=7'],
    queryFn: () => api.get<{ data: CrashList }>('/issues/crashes?days=7').then((r) => r.data.data),
    staleTime: 60_000
  })
  const rows = data?.since_release ?? []
  const fresh = rows.reduce((n, r) => n + r.new, 0)
  return (
    <Card
      title='Crashes since this release'
      icon={Bug}
      aside={
        <Link
          to='/issues?view=crashes'
          className='inline-flex items-center gap-0.5 hover:underline'
        >
          Open crashes <ArrowUpRight className='h-3 w-3' />
        </Link>
      }
    >
      {isLoading ? (
        <div className='h-10 animate-pulse rounded bg-muted' />
      ) : isError ? (
        <Empty>Crashes couldn’t be read.</Empty>
      ) : rows.length === 0 ? (
        <Empty>No front-end crashes in the last 7 days.</Empty>
      ) : (
        <ul className='m-0 grid list-none gap-2 p-0 sm:grid-cols-2'>
          {rows.map((r) => (
            <li key={r.app} className='flex items-start gap-2 text-[12.5px]'>
              <span className='mt-1.5'>
                <Dot tone={r.new > 0 ? 'bad' : r.crashes > 0 ? 'warn' : 'ok'} />
              </span>
              <span className='min-w-0'>
                <span className='font-mono text-slate-800 dark:text-foreground'>
                  {r.app} {r.release}
                </span>
                <span className='block text-muted-foreground'>
                  {r.crashes} {r.crashes === 1 ? 'crash' : 'crashes'}
                  {r.new > 0 ? `, ${r.new} new` : ''} · {r.hits} {r.hits === 1 ? 'time' : 'times'} ·{' '}
                  {r.people} {r.people === 1 ? 'person' : 'people'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {fresh > 0 && (
        <p className='mb-0 mt-2 text-[11.5px] text-muted-foreground'>
          New means first seen in that release — the ones a release brought.
        </p>
      )}
    </Card>
  )
}

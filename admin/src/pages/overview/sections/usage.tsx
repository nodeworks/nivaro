import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatNumber, titleCase } from '@/lib/utils'
import { Section, SectionError, type SectionProps, Surface } from './kit'
import type { OverviewUsage } from './types'

/**
 * #20 Usage (administrators) — where the work happened today: the collections with the most
 * record changes (activity log, 24 h), the most-opened screens (page views, else RUM samples)
 * and the slowest screen this week (RUM p75, the API analytics page's own summary). Each links
 * to the tool that explains it.
 */

export function useOverviewUsage() {
  return useQuery({
    queryKey: ['overview', 'usage'],
    queryFn: () => api.get<{ data: OverviewUsage }>('/overview/usage').then((r) => r.data.data),
    staleTime: 5 * 60_000
  })
}

/** "admin /collections/:col" → "/collections/:col" (the app prefix is the RUM summary's). */
export function screenName(route: string): string {
  const m = /^(\S+)\s+(\/.*)$/.exec(route)
  if (m) return m[1] === 'admin' ? m[2] : `${m[2]} (${m[1]})`
  // Page views store the full address; show the path (and the app's port when it isn't this one).
  try {
    const u = new URL(route)
    const other = u.origin !== window.location.origin
    return other ? `${u.pathname} (${u.port ? `:${u.port}` : u.host})` : u.pathname
  } catch {
    return route
  }
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}

function Column({
  title,
  to,
  toLabel,
  children
}: {
  title: string
  to: string
  toLabel: string
  children: ReactNode
}) {
  return (
    <div className='min-w-0 px-3 py-3'>
      <div className='mb-1.5 flex items-baseline justify-between gap-2'>
        <h3 className='text-[11.5px] font-medium text-slate-500 dark:text-slate-400'>{title}</h3>
        <Link
          to={to}
          className='shrink-0 text-[11px] text-slate-400 hover:text-slate-700 hover:underline dark:hover:text-slate-200'
        >
          {toLabel}
        </Link>
      </div>
      {children}
    </div>
  )
}

const quiet = (text: string) => (
  <p className='text-[12px] text-slate-400 dark:text-slate-500'>{text}</p>
)

export function UsageSection({ hideTitle }: SectionProps = {}) {
  const { data, isLoading, isError, error, refetch } = useOverviewUsage()

  return (
    <Section id='usage' title='Usage today' hideTitle={hideTitle}>
      {isLoading ? (
        <Surface className='grid gap-px bg-slate-200 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))] dark:bg-border'>
          {[0, 1, 2].map((i) => (
            <div key={i} className='space-y-2 bg-white px-3 py-3 dark:bg-card'>
              <Skeleton className='h-3 w-24' />
              <Skeleton className='h-3.5 w-full' />
              <Skeleton className='h-3.5 w-4/5' />
            </div>
          ))}
        </Surface>
      ) : isError || !data ? (
        <SectionError error={error} what='usage' onRetry={() => void refetch()} />
      ) : (
        <Surface className='grid gap-px bg-slate-200 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))] dark:bg-border'>
          <div className='bg-white dark:bg-card'>
            <Column title='Busiest collections' to='/activity' toLabel='Activity'>
              {(data.busiest_collections ?? []).length === 0 ? (
                quiet('No records changed today.')
              ) : (
                <ol className='space-y-1'>
                  {(data.busiest_collections ?? []).map((c) => (
                    <li key={c.collection} className='flex items-baseline gap-2 text-[12.5px]'>
                      <Link
                        to={`/collections/${encodeURIComponent(c.collection)}`}
                        className='min-w-0 flex-1 truncate text-slate-700 hover:underline dark:text-slate-200'
                      >
                        {c.label || titleCase(c.collection)}
                      </Link>
                      <span className='shrink-0 tabular-nums text-slate-500 dark:text-slate-400'>
                        {formatNumber(c.changes)} {c.changes === 1 ? 'change' : 'changes'}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Column>
          </div>
          <div className='bg-white dark:bg-card'>
            <Column title='Most-used screens' to='/analytics' toLabel='Page analytics'>
              {(data.screens ?? []).length === 0 ? (
                quiet('No page views recorded today.')
              ) : (
                <ol className='space-y-1'>
                  {(data.screens ?? []).map((s) => (
                    <li key={s.route} className='flex items-baseline gap-2 text-[12.5px]'>
                      <span
                        className='min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-700 dark:text-slate-200'
                        data-tip={s.route}
                      >
                        {screenName(s.route)}
                      </span>
                      <span className='shrink-0 tabular-nums text-slate-500 dark:text-slate-400'>
                        {formatNumber(s.views)}
                        {s.people != null ? ` · ${formatNumber(s.people)} sessions` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Column>
          </div>
          <div className='bg-white dark:bg-card'>
            <Column title='Slowest screen this week' to='/analytics/api' toLabel='Speed details'>
              {data.slowest_page ? (
                <div className='text-[12.5px]'>
                  <p className='truncate font-mono text-[11.5px] text-slate-700 dark:text-slate-200'>
                    {screenName(data.slowest_page.route)}
                  </p>
                  <p className='mt-0.5 text-slate-500 dark:text-slate-400'>
                    3 in 4 loads finish within{' '}
                    <span className='font-medium tabular-nums text-slate-700 dark:text-slate-200'>
                      {seconds(data.slowest_page.p75_ms)}
                    </span>{' '}
                    ({formatNumber(data.slowest_page.samples)} loads measured)
                  </p>
                </div>
              ) : (
                quiet('Not enough page timings this week to say.')
              )}
            </Column>
          </div>
        </Surface>
      )}
    </Section>
  )
}

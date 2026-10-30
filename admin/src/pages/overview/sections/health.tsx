import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { ago, Section, SectionError, type SectionProps } from './kit'
import type { HealthStatus, OverviewHealth } from './types'

/**
 * #2 Health — one line in words instead of "All systems operational":
 * "Everything's running · last deploy 0.3.56 2 h ago · 1 warning". Administrators get the
 * version and the CACHED readiness scorecard (never ?fresh); everyone else hears only whether
 * things are running or slow. The line opens /health for administrators.
 */

export function useOverviewHealth() {
  return useQuery({
    queryKey: ['overview', 'health'],
    queryFn: () => api.get<{ data: OverviewHealth }>('/overview/health').then((r) => r.data.data),
    staleTime: 30_000,
    refetchInterval: 60_000
  })
}

/** The parts after the headline, in words. Pure — exported for tests. */
export function healthParts(h: OverviewHealth): string[] {
  const parts: string[] = []
  if (h.version) {
    const when = ago(h.deployed_at)
    parts.push(`last deploy ${h.version}${when ? ` ${when}` : ''}`)
  }
  const r = h.readiness
  if (r) {
    if (r.warn > 0) parts.push(`${r.warn} ${r.warn === 1 ? 'warning' : 'warnings'}`)
    if (r.error > 0) parts.push(`${r.error} ${r.error === 1 ? 'check' : 'checks'} could not run`)
  }
  return parts
}

const DOT: Record<HealthStatus, string> = {
  ok: 'bg-emerald-500 dark:bg-emerald-400',
  attention: 'bg-rose-500 dark:bg-rose-400',
  slow: 'bg-amber-500 dark:bg-amber-400',
  down: 'bg-rose-600 dark:bg-rose-400'
}

export function HealthSection({ hideTitle }: SectionProps = {}) {
  const { user } = useAuth()
  const { data, isLoading, isError, error, refetch } = useOverviewHealth()
  const admin = !!user?.is_admin

  let body: ReactNode
  if (isLoading) {
    body = (
      <div className='flex items-center gap-2 py-1'>
        <Skeleton className='h-2 w-2 rounded-full' />
        <Skeleton className='h-3.5 w-72 max-w-[80%]' />
      </div>
    )
  } else if (isError || !data) {
    body = <SectionError error={error} what='the system status' onRetry={() => void refetch()} />
  } else {
    const parts = healthParts(data)
    const line = (
      <span className='inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] leading-5'>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[data.status])} aria-hidden />
        <span className='font-medium text-slate-800 dark:text-slate-100'>{data.headline}</span>
        {parts.map((p) => (
          <span key={p} className='text-slate-500 dark:text-slate-400'>
            <span aria-hidden>· </span>
            {p}
          </span>
        ))}
      </span>
    )
    body = admin ? (
      <Link
        to='/health'
        data-overview-health={data.status}
        className='group inline-flex max-w-full items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
      >
        {line}
        <ChevronRight
          className='h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5'
          aria-hidden
        />
        <span className='sr-only'>Open system health</span>
      </Link>
    ) : (
      <p data-overview-health={data.status} role='status'>
        {line}
      </p>
    )
  }

  return (
    <Section id='health' title='System' hideTitle={hideTitle} className='relative'>
      {body}
    </Section>
  )
}

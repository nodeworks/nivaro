import { rankSignals, useSignals } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  ActionLink,
  ago,
  Section,
  SectionEmpty,
  SectionError,
  type SectionProps,
  Surface
} from './kit'
import { mergeProblems, signalCandidates } from './problems-merge'
import type { ProblemCandidate, ProblemSource } from './types'

/**
 * #17 Top problems (administrators) — the three most urgent open problems across background
 * jobs, SQL checks, readiness (GET /api/overview/problems, admin-only) and integrations (the
 * Integrations console's own Firefight list, ranked by its own `rankSignals`).
 */

export function useOverviewProblems() {
  return useQuery({
    queryKey: ['overview', 'problems'],
    queryFn: () =>
      api
        .get<{ data: { items: ProblemCandidate[] } }>('/overview/problems')
        .then((r) => r.data.data.items),
    staleTime: 60_000,
    refetchInterval: 120_000
  })
}

const SOURCE: Record<ProblemSource, string> = {
  jobs: 'Background job',
  sql: 'SQL checks',
  readiness: 'Readiness',
  integrations: 'Integration'
}

export function ProblemsSection({ hideTitle }: SectionProps = {}) {
  const server = useOverviewProblems()
  // Same query key + shape as the Integrations console (shared cache).
  const signals = useSignals()

  const items = useMemo(
    () =>
      mergeProblems(
        server.data ?? [],
        signals.data ? signalCandidates(rankSignals(signals.data.signals)) : [],
        3
      ),
    [server.data, signals.data]
  )

  return (
    <Section id='problems' title='Top problems' hideTitle={hideTitle}>
      {server.isLoading ? (
        <Surface className='divide-y divide-slate-100 dark:divide-border'>
          {[0, 1, 2].map((i) => (
            <div key={i} className='space-y-1.5 px-3 py-2.5'>
              <Skeleton className='h-3 w-20' />
              <Skeleton className='h-3.5 w-72 max-w-[85%]' />
            </div>
          ))}
        </Surface>
      ) : server.isError ? (
        <SectionError
          error={server.error}
          what='open problems'
          onRetry={() => void server.refetch()}
        />
      ) : items.length === 0 ? (
        <SectionEmpty next={{ label: 'Open the Integrations console', to: '/integration-health' }}>
          No open problems in jobs, SQL checks or readiness
          {signals.isError ? ' (integrations could not be checked)' : ' or integrations'}.
        </SectionEmpty>
      ) : (
        <Surface>
          <ol className='divide-y divide-slate-100 dark:divide-border'>
            {items.map((p, i) => (
              <li
                key={p.key}
                data-problem={p.source}
                className='relative flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5'
              >
                <span className='mt-0.5 w-4 shrink-0 text-[12px] tabular-nums text-slate-400'>
                  {i + 1}
                </span>
                <span className='min-w-0 flex-1'>
                  <span className='flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
                    <span
                      className={cn(
                        'font-medium',
                        p.severity === 'critical'
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-amber-700 dark:text-amber-400'
                      )}
                    >
                      {p.severity === 'critical' ? 'Critical' : 'Warning'}
                    </span>
                    <span aria-hidden>·</span>
                    <span>{SOURCE[p.source]}</span>
                    {p.since && (
                      <>
                        <span aria-hidden>·</span>
                        <span>started {ago(p.since)}</span>
                      </>
                    )}
                  </span>
                  <span className='mt-0.5 block text-[13px] leading-5 text-slate-700 dark:text-slate-200'>
                    {p.sentence}
                  </span>
                </span>
                <ActionLink to={p.href}>Open</ActionLink>
              </li>
            ))}
          </ol>
        </Surface>
      )}
    </Section>
  )
}

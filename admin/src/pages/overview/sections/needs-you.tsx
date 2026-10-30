import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ActionLink, localDay, Section, SectionError, type SectionProps, Surface } from './kit'
import type { NeedsYouItem, Tone } from './types'

/**
 * #1 "Needs you" — what is waiting on THIS person, one sentence and one action per line
 * ("3 imports failed in the last 24 hours → Review"). Counted as the viewer on the server
 * (GET /api/overview/needs-you); administrators also get jobs, imports, partner rejects, support,
 * SQL checks and readiness. Renders nothing at all when nothing waits.
 */

export function useNeedsYou() {
  return useQuery({
    queryKey: ['overview', 'needs-you'],
    queryFn: () => {
      const { today, tz } = localDay()
      return api
        .get<{ data: { items: NeedsYouItem[] } }>('/overview/needs-you', { params: { today, tz } })
        .then((r) => r.data.data)
    },
    staleTime: 30_000,
    refetchInterval: 120_000
  })
}

const DOT: Record<Tone, string> = {
  critical: 'bg-rose-500 dark:bg-rose-400',
  warn: 'bg-amber-500 dark:bg-amber-400',
  info: 'bg-slate-300 dark:bg-slate-500'
}

const TONE_WORD: Record<Tone, string> = {
  critical: 'Urgent',
  warn: 'Needs a look',
  info: 'For you'
}

export function NeedsYouSection({ hideTitle }: SectionProps = {}) {
  const { data, isLoading, isError, error, refetch } = useNeedsYou()

  if (isLoading)
    return (
      <Section id='needs-you' title='Needs you' hideTitle={hideTitle}>
        <Surface className='divide-y divide-slate-100 dark:divide-border'>
          {[0, 1].map((i) => (
            <div key={i} className='flex items-center gap-3 px-3 py-2.5'>
              <Skeleton className='h-2 w-2 rounded-full' />
              <Skeleton className='h-3.5 w-64 max-w-[60%]' />
              <Skeleton className='ml-auto h-3.5 w-14' />
            </div>
          ))}
        </Surface>
      </Section>
    )

  if (isError)
    return (
      <Section id='needs-you' title='Needs you' hideTitle={hideTitle}>
        <SectionError error={error} what='what needs you' onRetry={() => void refetch()} />
      </Section>
    )

  const items = data?.items ?? []
  if (items.length === 0) return null

  return (
    <Section id='needs-you' title='Needs you' hideTitle={hideTitle}>
      <Surface>
        <ul className='divide-y divide-slate-100 dark:divide-border'>
          {items.map((item) => (
            <li
              key={item.key}
              data-needs-you={item.key}
              className='relative flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5'
            >
              <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[item.tone])} aria-hidden />
              <span className='sr-only'>{TONE_WORD[item.tone]}: </span>
              <span className='min-w-0 flex-1 text-[13px] leading-5 text-slate-700 dark:text-slate-200'>
                {item.sentence}
              </span>
              <ActionLink to={item.action.href}>{item.action.label}</ActionLink>
            </li>
          ))}
        </ul>
      </Surface>
    </Section>
  )
}

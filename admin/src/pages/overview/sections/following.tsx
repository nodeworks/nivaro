import { useQuery } from '@tanstack/react-query'
import { Bell, Eye, ListChecks, Table2 } from 'lucide-react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { Section, SectionEmpty, SectionError, type SectionProps, Surface } from './kit'
import type { FollowedThing } from './types'

/**
 * #15 Following — the records, collections, field watches and queues this person follows
 * (notification subscriptions, field-watch subscriptions), with how many unread notifications
 * each has in their own inbox. Labels and visibility are read AS the viewer: a record they can
 * no longer see drops out.
 */

export function useFollowing() {
  return useQuery({
    queryKey: ['overview', 'following'],
    queryFn: () =>
      api
        .get<{ data: { items: FollowedThing[] } }>('/overview/following')
        .then((r) => r.data.data.items),
    staleTime: 60_000
  })
}

const ICON = {
  record: Bell,
  collection: Table2,
  field: Eye,
  queue: ListChecks
} as const

const SHOWN = 8

export function FollowingSection({ hideTitle }: SectionProps = {}) {
  const { data, isLoading, isError, error, refetch } = useFollowing()
  const more = { label: 'Manage', to: '/alerts/subscriptions' }

  return (
    <Section id='following' title='Following' hideTitle={hideTitle} more={more}>
      {isLoading ? (
        <Surface className='divide-y divide-slate-100 dark:divide-border'>
          {[0, 1, 2].map((i) => (
            <div key={i} className='flex items-center gap-3 px-3 py-2.5'>
              <Skeleton className='h-4 w-4 rounded' />
              <div className='min-w-0 flex-1 space-y-1.5'>
                <Skeleton className='h-3.5 w-40' />
                <Skeleton className='h-3 w-24' />
              </div>
            </div>
          ))}
        </Surface>
      ) : isError ? (
        <SectionError error={error} what='what you follow' onRetry={() => void refetch()} />
      ) : !data?.length ? (
        <SectionEmpty next={{ label: 'See notification rules', to: '/alerts/subscriptions' }}>
          You're not following anything yet. Use the bell on a record to hear when it changes.
        </SectionEmpty>
      ) : (
        <Surface>
          <ul className='divide-y divide-slate-100 dark:divide-border'>
            {data.slice(0, SHOWN).map((f) => {
              const Icon = ICON[f.kind]
              return (
                <li key={f.key} className='relative'>
                  <Link
                    to={f.href}
                    data-following={f.kind}
                    className='flex items-center gap-3 px-3 py-2.5 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none'
                  >
                    <Icon className='h-4 w-4 shrink-0 text-slate-400' aria-hidden />
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                        {f.label}
                      </span>
                      {f.detail && (
                        <span className='block truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
                          {f.detail}
                        </span>
                      )}
                    </span>
                    {f.unread > 0 ? (
                      <span className='shrink-0 rounded-full bg-nvr-cyan/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-nvr-navy dark:text-nvr-cyan'>
                        {f.unread} new
                      </span>
                    ) : (
                      <span className='shrink-0 text-[11px] text-slate-400'>No changes</span>
                    )}
                  </Link>
                </li>
              )
            })}
          </ul>
          {data.length > SHOWN && (
            <p className='border-t border-slate-100 px-3 py-2 text-[11.5px] text-slate-500 dark:border-border dark:text-slate-400'>
              And {data.length - SHOWN} more.{' '}
              <Link to='/alerts/subscriptions' className='font-medium hover:underline'>
                See all
              </Link>
            </p>
          )}
        </Surface>
      )}
    </Section>
  )
}

import { useQuery } from '@tanstack/react-query'
import { UserX } from 'lucide-react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { ago, Section, SectionError, type SectionProps, Surface } from './kit'
import type { OffloadPerson, OffloadReport } from './types'

/**
 * People to offload (administrators): suspended or redacted people who still hold work that has
 * to be handed on — owner seats, team places, open tasks, pending approvals, assigned records —
 * most work first. Each row opens the Inactive people tool on that person, where the work is
 * reassigned. Draws NOTHING when nobody holds work (no empty heading on a quiet instance).
 * Data: GET /api/overview/people-to-offload (the same scan as Data Integrity → Inactive people).
 */

export function useOffload() {
  return useQuery({
    queryKey: ['overview', 'people-to-offload'],
    queryFn: () =>
      api.get<{ data: OffloadReport }>('/overview/people-to-offload').then((r) => r.data.data),
    staleTime: 60_000
  })
}

const KINDS: Array<[keyof OffloadPerson['counts'], string, string]> = [
  ['seats', 'owner seat', 'owner seats'],
  ['records', 'record', 'records'],
  ['tasks', 'task', 'tasks'],
  ['approvals', 'approval', 'approvals'],
  ['teams', 'team', 'teams']
]

function statusText(p: OffloadPerson): string {
  const word = p.reason === 'suspended' ? 'Suspended' : 'Redacted'
  const when = ago(p.since)
  return when ? `${word} ${when}` : word
}

function Row({ p }: { p: OffloadPerson }) {
  const chips = KINDS.filter(([k]) => p.counts[k] > 0)
  return (
    <li className='px-3 py-2.5' data-offload-person={p.id}>
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
        <Link
          to={`/users/${encodeURIComponent(p.id)}`}
          className='min-w-0 truncate text-[13px] font-medium text-slate-800 hover:underline dark:text-slate-100'
        >
          {p.name}
        </Link>
        <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>{statusText(p)}</span>
        <Link
          to={p.tool_path}
          className='ml-auto shrink-0 text-[12px] font-medium text-slate-700 hover:underline dark:text-slate-200'
        >
          Hand on {p.total} {p.total === 1 ? 'item' : 'items'}
        </Link>
      </div>
      <p className='mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-slate-500 dark:text-slate-400'>
        {chips.map(([k, one, many]) => (
          <span key={k} className='tabular-nums'>
            {p.counts[k]} {p.counts[k] === 1 ? one : many}
          </span>
        ))}
        {p.why && (
          <span className='min-w-0 truncate' data-tip={p.why}>
            · {p.why}
          </span>
        )}
      </p>
    </li>
  )
}

export function PeopleToOffloadSection({ hideTitle }: SectionProps = {}) {
  const { data, isLoading, isError, error, refetch } = useOffload()
  // Nothing to hand on (or still loading the first time): no heading, no empty box.
  if (!isLoading && !isError && (!data?.people || data.people.length === 0)) return null
  return (
    <Section
      id='people-to-offload'
      title='People to offload'
      hideTitle={hideTitle}
      more={{ label: 'Inactive people', to: '/data-integrity/people' }}
    >
      {isLoading ? (
        <Surface className='divide-y divide-slate-100 dark:divide-border'>
          {[0, 1].map((i) => (
            <div key={i} className='space-y-1.5 px-3 py-2.5'>
              <Skeleton className='h-3.5 w-40' />
              <Skeleton className='h-3 w-64 max-w-[80%]' />
            </div>
          ))}
        </Surface>
      ) : isError || !data?.people ? (
        <SectionError error={error} what='people to offload' onRetry={() => void refetch()} />
      ) : (
        <Surface>
          <p className='flex items-center gap-1.5 border-b border-slate-100 px-3 py-2 text-[12px] text-slate-600 dark:border-border dark:text-slate-300'>
            <UserX className='h-3.5 w-3.5' strokeWidth={2} />
            {data.total_people} {data.total_people === 1 ? 'person' : 'people'} no longer here, with{' '}
            {data.total_items} {data.total_items === 1 ? 'item' : 'items'} still on them.
          </p>
          <ul className='divide-y divide-slate-100 dark:divide-border'>
            {data.people.slice(0, 5).map((p) => (
              <Row key={p.id} p={p} />
            ))}
          </ul>
          {data.total_people > 5 && (
            <p className='border-t border-slate-100 px-3 py-2 text-[11.5px] text-slate-500 dark:border-border dark:text-slate-400'>
              {data.total_people - 5} more.{' '}
              <Link to='/data-integrity/people' className='font-medium hover:underline'>
                See everyone
              </Link>
            </p>
          )}
        </Surface>
      )}
    </Section>
  )
}

import { useQuery } from '@tanstack/react-query'
import { Eye, Loader2, RefreshCw } from 'lucide-react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { SectionCard } from './primitives'

// ─── What they can see, in words (#1959) ─────────────────────────────────────
// "Beth sees 4,271 of 88,000 workflows because her Zone filter is Zone 1 and
// her role reads workflows; she cannot edit invoices." The server builds each
// sentence from the read path's own gates (role policy, row rule, User
// Scopes) and counts with them applied, so the words match what she sees.

interface AccessSummary {
  collections: Array<{
    collection: string
    collection_label: string
    visible: number | null
    total: number | null
    can_update: boolean
  }>
  cannot_edit: string[]
  lead: string
  sentences: string[]
  cannot_line: string | null
  summary: string
}

export function AccessSummaryCard({ userId }: { userId: string }) {
  const client = useNivaroClient()
  const { data, isLoading, isError, isFetching, refetch } = useQuery<AccessSummary>({
    queryKey: ['access-insights', 'person', userId],
    queryFn: () =>
      client
        .request<{ data: AccessSummary }>(get(`/access-insights/people/${userId}`))
        .then((r) => r.data),
    staleTime: 60_000
  })
  return (
    <SectionCard
      icon={<Eye className='h-4 w-4' />}
      title='What they can see'
      hint='Counted through their role, row rules and scopes — the same gates their reads use'
      testId='access-summary'
      actions={
        <button
          type='button'
          onClick={() => void refetch()}
          disabled={isFetching}
          className='text-slate-400 transition-colors hover:text-nvr-cyan disabled:opacity-50'
          aria-label='Recount'
        >
          <RefreshCw className={isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        </button>
      }
    >
      {isLoading ? (
        <p className='flex items-center gap-1.5 text-[12px] text-slate-500'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' /> Counting what they can see…
        </p>
      ) : isError || !data ? (
        <p className='text-[12px] text-slate-500'>Could not work out their access.</p>
      ) : (
        <div className='space-y-2 text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300'>
          <p className='font-medium text-slate-800 dark:text-slate-100'>{data.lead}</p>
          {data.sentences.length > 0 && (
            <ul className='space-y-1.5'>
              {data.sentences.map((s) => (
                <li key={s} className='border-l-2 border-slate-200 pl-2.5 dark:border-border'>
                  {s}
                </li>
              ))}
            </ul>
          )}
          {data.cannot_line && (
            <p className='text-[12px] text-amber-700 dark:text-amber-400'>{data.cannot_line}</p>
          )}
        </div>
      )}
    </SectionCard>
  )
}

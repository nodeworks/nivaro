import { useQuery } from '@tanstack/react-query'
import { CalendarRange, Loader2, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { EmptyLine, SectionCard } from './primitives'
import type { PersonProfile } from './types'

/**
 * "This week" on someone's page (#1968) — for administrators and the
 * person's manager (the server refuses anyone else, and the card then draws
 * nothing). Counts and records are the ones the viewer may open; "Summarise"
 * asks for a few plain lines written from that same narrowed payload.
 */

interface PersonWeekData {
  since: string
  figures: {
    created: number
    updated: number
    deleted: number
    moved: number
    completed: number
    sent_back: number
    approved: number
    rejected: number
    comments: number
    imports: number
  }
  by_collection: Array<{
    collection: string
    label: string
    created: number
    updated: number
    moved: number
    comments: number
  }>
  highlights: Array<{
    collection: string
    item_id: string
    label: string
    what: string
    state: string | null
    at: string
  }>
  summary: string | null
}

export function PersonWeekCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const { urlFor } = useItemNavigation()
  const [ai, setAi] = useState(false)
  const { data, isLoading, isError, isFetching } = useQuery<PersonWeekData>({
    queryKey: ['nvr-person-week', p.id, ai],
    queryFn: () =>
      client
        .request<{ data: PersonWeekData }>(
          get(`/users/${encodeURIComponent(p.id)}/activity-summary`, {
            days: 7,
            ...(ai ? { ai: 1 } : {})
          })
        )
        .then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: false
  })
  if (isError) return null
  const first = p.first_name ?? p.name
  const f = data?.figures
  const facts = f
    ? (
        [
          [f.created, 'created'],
          [f.moved, 'moved on'],
          [f.completed, 'finished'],
          [f.sent_back, 'sent back'],
          [f.approved, 'approved'],
          [f.rejected, 'rejected'],
          [f.comments, f.comments === 1 ? 'comment' : 'comments'],
          [f.imports, f.imports === 1 ? 'import' : 'imports']
        ] as Array<[number, string]>
      ).filter(([n]) => n > 0)
    : []
  return (
    <SectionCard
      icon={<CalendarRange className='h-4 w-4' />}
      title='This week'
      hint={`What ${first} did in the last 7 days — records you can open`}
      testId='person-week'
      actions={
        <button
          type='button'
          onClick={() => setAi(true)}
          disabled={ai && isFetching}
          className='inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-slate-600 hover:bg-muted disabled:opacity-50 dark:text-slate-300'
          data-person-week-summarise
        >
          {ai && isFetching ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Sparkles className='h-3.5 w-3.5' />
          )}
          Summarise
        </button>
      }
    >
      {isLoading ? (
        <div className='space-y-2' aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className='h-5 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
          ))}
        </div>
      ) : !data || (facts.length === 0 && f?.updated === 0) ? (
        <EmptyLine>Nothing you can see from {first} in the last 7 days.</EmptyLine>
      ) : (
        <div className='space-y-3 text-[12.5px]'>
          {data.summary && (
            <p
              className='whitespace-pre-line rounded-md bg-slate-50 px-3 py-2 text-slate-700 dark:bg-muted dark:text-slate-200'
              data-person-week-summary
            >
              {data.summary}
            </p>
          )}
          <p className='text-slate-700 dark:text-slate-200' data-person-week-facts>
            {facts.length > 0
              ? facts.map(([n, label]) => `${n} ${label}`).join(' · ')
              : 'No records created or moved'}
            {f && f.updated > 0 ? ` · edited ${f.updated} record${f.updated === 1 ? '' : 's'}` : ''}
          </p>
          {data.by_collection.length > 0 && (
            <div className='flex flex-wrap gap-1.5'>
              {data.by_collection.map((c) => (
                <span
                  key={c.collection}
                  className='rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-muted dark:text-slate-300'
                >
                  {c.label} · {c.created + c.updated + c.moved + c.comments}
                </span>
              ))}
            </div>
          )}
          {data.highlights.length > 0 && (
            <ul className='space-y-1'>
              {data.highlights.map((h) => (
                <li key={`${h.collection}:${h.item_id}`} className='flex items-baseline gap-2'>
                  <span
                    className={cn(
                      'shrink-0 text-[11px] font-medium',
                      h.what === 'completed' || h.what === 'approved'
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : h.what === 'sent back' || h.what === 'rejected'
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-slate-500 dark:text-slate-400'
                    )}
                  >
                    {h.what}
                  </span>
                  <a
                    href={urlFor({ collection: h.collection, itemId: h.item_id })}
                    className='min-w-0 truncate text-slate-800 hover:underline dark:text-slate-100'
                  >
                    {h.label}
                  </a>
                  {h.state && (
                    <span className='shrink-0 text-[11px] text-slate-400'>→ {h.state}</span>
                  )}
                  <span className='ml-auto shrink-0 text-[11px] text-slate-400'>
                    {formatRelative(h.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionCard>
  )
}

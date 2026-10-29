import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronRight, Download, ListChecks } from 'lucide-react'
import { useState } from 'react'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatDate, formatNumber, titleCase } from '../../lib/utils'
import { SimpleSelect } from '../ui/SimpleSelect'
import { EmptyLine, SectionCard } from './primitives'

/**
 * #13 — "What they did": a person's audit trail grouped by day, then collection, with counts;
 * a group expands to its entries. For administrators on anyone's page and for the person on
 * their own (GET /api/activity/people/:id/summary|entries). The CSV export goes through
 * POST …/export, which logs the export itself (`activity-export`).
 */

interface DayGroup {
  day: string
  total: number
  collections: Array<{ collection: string | null; count: number; actions: Record<string, number> }>
}
interface Summary {
  days: DayGroup[]
  total: number
  truncated: boolean
  window_days: number
  tz: string
}
interface Entry {
  id: number
  action: string
  timestamp: string
  collection: string | null
  item: string | null
  comment: string | null
}

const NO_COLLECTION = '__none__'
const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' }
]

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function collectionName(c: string | null): string {
  if (!c) return 'Sign-ins and other'
  return titleCase(c.replace(/^(nivaro|directus)_/, '').replace(/_/g, ' '))
}

function actionSummary(actions: Record<string, number>): string {
  return Object.entries(actions)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `${n} ${a.replace(/[-_]/g, ' ')}`)
    .join(' · ')
}

export function PersonDidPanel({ userId, name }: { userId: string; name?: string | null }) {
  const client = useNivaroClient()
  const [days, setDays] = useState('30')
  const tz = viewerZone()
  const { data, isLoading, isError } = useQuery<Summary>({
    queryKey: ['nvr-person-did', userId, days, tz],
    queryFn: () =>
      client
        .request<{ data: Summary }>(get(`/activity/people/${userId}/summary`, { days, tz }))
        .then((r) => r.data),
    staleTime: 60_000
  })
  const exportCsv = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { csv: string; filename: string } }>(
          post(`/activity/people/${userId}/export`, { days: Number(days), tz })
        )
        .then((r) => r.data),
    onSuccess: ({ csv, filename }) => {
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  })

  return (
    <SectionCard
      icon={<ListChecks className='h-4 w-4' />}
      title={name ? `What ${name} did` : 'What they did'}
      hint='Every recorded change, by day and collection'
      testId='what-they-did'
      actions={
        <div className='flex items-center gap-2'>
          <SimpleSelect
            value={days}
            onChange={setDays}
            options={WINDOWS}
            className='h-7 w-[130px] text-[12px]'
            ariaLabel='Window'
          />
          <button
            type='button'
            onClick={() => exportCsv.mutate()}
            disabled={exportCsv.isPending || !data?.total}
            className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[12px] text-slate-700 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-200'
            data-person-did-export
          >
            <Download className='h-3.5 w-3.5' />
            {exportCsv.isPending ? 'Exporting…' : 'CSV'}
          </button>
        </div>
      }
    >
      {isLoading ? (
        <div className='space-y-2' aria-busy='true'>
          {[0, 1, 2].map((i) => (
            <div key={i} className='h-9 animate-pulse rounded-md bg-slate-100 dark:bg-muted' />
          ))}
        </div>
      ) : isError || !data ? (
        <EmptyLine>The activity could not be loaded.</EmptyLine>
      ) : data.days.length === 0 ? (
        <EmptyLine>Nothing recorded in this window.</EmptyLine>
      ) : (
        <div className='space-y-3' data-person-did>
          <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
            {formatNumber(data.total)}
            {data.truncated ? '+' : ''} entries over {data.days.length} active day
            {data.days.length === 1 ? '' : 's'}
            {data.truncated ? ' — the newest are shown; export for a shorter window.' : ''}
          </p>
          {data.days.map((d) => (
            <DaySection key={d.day} userId={userId} group={d} tz={data.tz} />
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function DaySection({ userId, group, tz }: { userId: string; group: DayGroup; tz: string }) {
  return (
    <section data-person-did-day={group.day}>
      <h4 className='mb-1 flex items-baseline gap-2 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
        {formatDate(group.day, { weekday: 'short' })}
        <span className='font-normal text-slate-500 dark:text-slate-400'>
          {formatNumber(group.total)}
        </span>
      </h4>
      <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border/60 dark:border-border'>
        {group.collections.map((c) => (
          <CollectionRow
            key={c.collection ?? NO_COLLECTION}
            userId={userId}
            day={group.day}
            tz={tz}
            group={c}
          />
        ))}
      </ul>
    </section>
  )
}

function CollectionRow({
  userId,
  day,
  tz,
  group
}: {
  userId: string
  day: string
  tz: string
  group: DayGroup['collections'][number]
}) {
  const client = useNivaroClient()
  const items = useItemNavigation()
  const [open, setOpen] = useState(false)
  const collection = group.collection ?? NO_COLLECTION
  const { data: entries, isLoading } = useQuery<Entry[]>({
    queryKey: ['nvr-person-did-entries', userId, day, collection, tz],
    enabled: open,
    queryFn: () =>
      client
        .request<{ data: Entry[] }>(
          get(`/activity/people/${userId}/entries`, { day, collection, tz })
        )
        .then((r) => r.data),
    staleTime: 60_000
  })
  return (
    <li>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className='flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-muted'
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
            open && 'rotate-90'
          )}
        />
        <span className='font-medium text-slate-800 dark:text-slate-100'>
          {collectionName(group.collection)}
        </span>
        <span className='min-w-0 truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
          {actionSummary(group.actions)}
        </span>
        <span className='ml-auto shrink-0 tabular-nums text-slate-600 dark:text-slate-300'>
          {formatNumber(group.count)}
        </span>
      </button>
      {open && (
        <div className='border-t border-slate-100 bg-slate-50 px-3 py-2 dark:border-border/60 dark:bg-muted/30'>
          {isLoading ? (
            <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>Loading…</p>
          ) : (
            <ol className='space-y-1'>
              {(entries ?? []).map((e) => {
                const record =
                  e.collection && e.item && !/^(nivaro|directus)_/.test(e.collection)
                    ? { collection: e.collection, itemId: e.item }
                    : null
                return (
                  <li key={e.id} className='flex items-baseline gap-2 text-[11.5px]'>
                    <time className='w-14 shrink-0 tabular-nums text-slate-500 dark:text-slate-400'>
                      {new Intl.DateTimeFormat('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        timeZone: tz
                      }).format(new Date(e.timestamp))}
                    </time>
                    <span className='shrink-0 font-medium text-slate-700 dark:text-slate-200'>
                      {e.action.replace(/[-_]/g, ' ')}
                    </span>
                    {e.item &&
                      (record ? (
                        <button
                          type='button'
                          className='shrink-0 text-nvr-navy hover:underline dark:text-nvr-cyan'
                          onClick={() => items.open(record)}
                        >
                          #{e.item}
                        </button>
                      ) : (
                        <span className='shrink-0 font-mono text-slate-500 dark:text-slate-400'>
                          #{e.item}
                        </span>
                      ))}
                    {e.comment && (
                      <span
                        className='min-w-0 truncate text-slate-500 dark:text-slate-400'
                        title={e.comment}
                      >
                        {e.comment}
                      </span>
                    )}
                  </li>
                )
              })}
              {entries?.length === 500 && (
                <li className='text-[11px] text-slate-500 dark:text-slate-400'>
                  The first 500 are shown — export for all.
                </li>
              )}
            </ol>
          )}
        </div>
      )}
    </li>
  )
}

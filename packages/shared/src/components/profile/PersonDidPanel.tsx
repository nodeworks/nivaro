import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronRight, Download, ListChecks } from 'lucide-react'
import { useState } from 'react'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatDate, formatNumber, titleCase } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { QueryErrorState } from '../QueryErrorState'
import { SimpleSelect } from '../ui/SimpleSelect'
import { EmptyLine, SectionCard } from './primitives'

/**
 * #13 — "What they did": a person's audit trail by day, then collection, in plain words.
 * For administrators on anyone's page and for the person on their own
 * (GET /api/activity/people/:id/summary|entries). The server folds link-table writes into
 * their parent ("Workflows", never "Workflows Divisions"), counts with plain verbs, and
 * answers a group as readable lines — records named by their label as the viewer reads
 * them ("a workflow record" when they cannot), repeated opens of one record as one line.
 * The CSV export goes through POST …/export, which logs the export itself (`activity-export`)
 * and keeps the raw ids.
 */

interface DidPart {
  verb: string
  count: number
}
interface DayGroup {
  day: string
  total: number
  collections: Array<{
    collection: string | null
    count: number
    actions: Record<string, number>
    parts?: DidPart[]
    label?: string
  }>
}
interface Summary {
  days: DayGroup[]
  total: number
  truncated: boolean
  window_days: number
  tz: string
}
export interface DidLine {
  key: string
  ids: number[]
  at: string
  first_at?: string
  count: number
  verb: string
  kind: string
  target: string
  detail: string | null
  note?: string | null
  record: { collection: string; id: string } | null
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

/** A collection key as words — only when the server sent no label. */
export function collectionName(c: string | null): string {
  if (!c) return 'Sign-ins and other'
  return titleCase(c.replace(/^(nivaro|directus)_/, '').replace(/_/g, ' '))
}

/** Older answers carried raw action counts; say them as words at least. */
function partsOf(group: DayGroup['collections'][number]): DidPart[] {
  if (group.parts?.length) return group.parts
  return Object.entries(group.actions)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => ({ verb: titleCase(a.replace(/[-_]/g, ' ')), count: n }))
}

function clock(ts: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz
  }).format(new Date(ts))
}

export function PersonDidPanel({ userId, name }: { userId: string; name?: string | null }) {
  const client = useNivaroClient()
  const [days, setDays] = useState('30')
  const tz = viewerZone()
  const { data, isLoading, isError, error, refetch } = useQuery<Summary>({
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
  const windowLabel = WINDOWS.find((w) => w.value === days)?.label.toLowerCase() ?? 'this window'

  return (
    <SectionCard
      icon={<ListChecks className='h-4 w-4' />}
      title={name ? `What ${name} did` : 'What they did'}
      hint='What they opened and changed, day by day'
      testId='what-they-did'
      actions={
        <div className='flex items-center gap-2'>
          <SimpleSelect
            value={days}
            onChange={setDays}
            options={WINDOWS}
            className='h-7 w-[130px] text-[12px]'
            ariaLabel='Period'
          />
          <button
            type='button'
            onClick={() => exportCsv.mutate()}
            disabled={exportCsv.isPending || !data?.total}
            data-tip='Download every entry in this period as a spreadsheet'
            className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[12px] text-slate-700 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:opacity-50 dark:border-border dark:text-slate-200'
            data-person-did-export
          >
            <Download className='h-3.5 w-3.5' />
            {exportCsv.isPending ? 'Exporting…' : 'CSV'}
          </button>
        </div>
      }
    >
      {exportCsv.isError && (
        <ErrorNotice
          variant='banner'
          error={exportCsv.error}
          fallback='Could not export'
          onRetry={() => exportCsv.mutate()}
          actionLabel='Export activity'
          className='mb-3'
        />
      )}
      {isLoading ? (
        <div className='space-y-4' aria-busy='true' data-person-did-loading>
          {[0, 1].map((d) => (
            <div key={d} className='space-y-1.5'>
              <div className='h-3.5 w-28 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
              <div className='h-10 animate-pulse rounded-md bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
              <div className='h-10 animate-pulse rounded-md bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
            </div>
          ))}
        </div>
      ) : isError || !data ? (
        <QueryErrorState error={error} what='this activity' onRetry={() => void refetch()} />
      ) : data.days.length === 0 ? (
        <EmptyLine>Nothing recorded in the {windowLabel}.</EmptyLine>
      ) : (
        <div className='space-y-5' data-person-did>
          <p className='text-[12px] text-slate-500 dark:text-slate-400'>
            {formatNumber(data.total)}
            {data.truncated ? '+' : ''} recorded action{data.total === 1 ? '' : 's'} over{' '}
            {data.days.length} day{data.days.length === 1 ? '' : 's'}
            {data.truncated ? ' — the newest are shown; export for the rest.' : ''}
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
      <h4 className='mb-1.5 text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
        {formatDate(group.day, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: group.day.startsWith(String(new Date().getFullYear())) ? undefined : 'numeric'
        })}
      </h4>
      <ul className='divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200 dark:divide-border/60 dark:border-border'>
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

function PartsLine({ parts }: { parts: DidPart[] }) {
  return (
    <span
      className='text-[12px] leading-5 text-slate-600 dark:text-slate-400'
      data-person-did-parts
    >
      {parts.map((p, i) => (
        <span key={p.verb}>
          <span className='whitespace-nowrap'>
            {p.verb}
            {p.count > 1 && (
              <span className='ml-1 tabular-nums text-slate-500 dark:text-slate-400'>
                {formatNumber(p.count)}
              </span>
            )}
            {i < parts.length - 1 && (
              <span aria-hidden className='pl-1 text-slate-300 dark:text-slate-600'>
                ·
              </span>
            )}
          </span>
          {i < parts.length - 1 && ' '}
        </span>
      ))}
    </span>
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
  const [open, setOpen] = useState(false)
  const collection = group.collection ?? NO_COLLECTION
  const label = group.label ?? collectionName(group.collection)
  const entries = useQuery<{ data: DidLine[]; truncated?: boolean }>({
    queryKey: ['nvr-person-did-lines', userId, day, collection, tz],
    enabled: open,
    queryFn: () =>
      client.request<{ data: DidLine[]; truncated?: boolean }>(
        get(`/activity/people/${userId}/entries`, { day, collection, tz })
      ),
    staleTime: 60_000
  })
  const panelId = `person-did-${day}-${collection}`
  return (
    <li data-person-did-group={collection}>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className='flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:hover:bg-muted/50'
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'mt-[3px] h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
        <span className='flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3'>
          <span className='shrink-0 text-[13px] font-medium text-slate-800 dark:text-slate-100'>
            {label}
          </span>
          <PartsLine parts={partsOf(group)} />
        </span>
      </button>
      {open && (
        <div
          id={panelId}
          className='border-t border-slate-100 bg-slate-50/70 px-3 py-2 dark:border-border/60 dark:bg-muted/20'
        >
          {entries.isLoading ? (
            <div className='space-y-2 py-1' aria-busy='true'>
              {[0, 1, 2].map((i) => (
                <div key={i} className='flex gap-3'>
                  <div className='h-3 w-14 animate-pulse rounded bg-slate-200/70 dark:bg-muted' />
                  <div className='h-3 flex-1 animate-pulse rounded bg-slate-200/70 dark:bg-muted' />
                </div>
              ))}
            </div>
          ) : entries.isError ? (
            <ErrorNotice
              error={entries.error}
              what='these entries'
              onRetry={() => void entries.refetch()}
            />
          ) : (entries.data?.data ?? []).length === 0 ? (
            <EmptyLine>Nothing to show for this day.</EmptyLine>
          ) : (
            <ol
              className='divide-y divide-slate-200/60 dark:divide-border/40'
              data-person-did-lines
            >
              {(entries.data?.data ?? []).map((line) => (
                <LineRow key={line.key} line={line} tz={tz} />
              ))}
              {entries.data?.truncated && (
                <li className='pt-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
                  The newest 300 are shown — export for the rest.
                </li>
              )}
            </ol>
          )}
        </div>
      )}
    </li>
  )
}

/** The record, as a link when the viewer may open it. An anchor (a button is always
 *  inline-block) so the "4×" chip after it never wraps onto a line of its own. */
function Target({ line, generic }: { line: DidLine; generic: boolean }) {
  const items = useItemNavigation()
  if (!line.record)
    return (
      <span className={generic ? 'text-slate-500 dark:text-slate-400' : undefined}>
        {line.target}
      </span>
    )
  const target = { collection: line.record.collection, itemId: line.record.id }
  return (
    <a
      href={items.urlFor(target)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        items.open(target)
      }}
      className='rounded-sm text-sky-800 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-nvr-cyan'
    >
      {line.target}
    </a>
  )
}

function LineRow({ line, tz }: { line: DidLine; tz: string }) {
  const range =
    line.first_at && line.count > 1
      ? `${line.count} times, ${clock(line.first_at, tz)} – ${clock(line.at, tz)}`
      : undefined
  const generic = !line.record && /^a .+ record$/.test(line.target)
  return (
    <li
      className='relative grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-2 py-1.5 sm:grid-cols-[4.75rem_minmax(0,1fr)]'
      data-person-did-line={line.kind}
    >
      <time
        dateTime={line.at}
        className='pt-px text-[12px] tabular-nums text-slate-500 dark:text-slate-400'
      >
        {clock(line.at, tz)}
      </time>
      <div className='min-w-0'>
        <p className='text-[12.5px] leading-5 text-slate-700 dark:text-slate-300'>
          <span className='font-medium text-slate-900 dark:text-slate-100'>{line.verb}</span>
          {line.target && ' '}
          {line.target && <Target line={line} generic={generic} />}
          {line.count > 1 && (
            <span
              className='ml-1.5 whitespace-nowrap rounded bg-slate-200/70 px-1 py-px text-[11px] font-medium tabular-nums text-slate-600 dark:bg-muted dark:text-slate-300'
              data-tip={range}
            >
              <span aria-hidden>{line.count}×</span>
              {range && <span className='sr-only'>{range}</span>}
            </span>
          )}
        </p>
        {line.detail && (
          <p className='text-[12px] leading-5 text-slate-500 dark:text-slate-400'>{line.detail}</p>
        )}
        {line.note && (
          <p className='text-[12px] leading-5 text-slate-600 dark:text-slate-400'>“{line.note}”</p>
        )}
      </div>
    </li>
  )
}

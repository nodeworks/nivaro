import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'

/**
 * Search Analytics (#1581, admin only). What people typed into Cmd+K and the
 * collection search boxes: the top searches, searches that found nothing,
 * searches where nothing was opened and slow ones. Query text is personal
 * data, so this page is for administrators and rows expire (default 60 days).
 * Results are never stored.
 */

interface Line {
  query: string
  collection: string | null
  searches: number
  people: number
  zero_results: number
  unopened: number
  avg_results: number
  p75_ms: number | null
}

interface Summary {
  ready: boolean
  window?: { days: number; retention_days: number; truncated: boolean }
  totals?: {
    searches: number
    people: number
    zero_result_rate: number | null
    open_rate: number | null
    p75_ms: number | null
  }
  top?: Line[]
  zero_results?: Line[]
  unopened?: Line[]
  slow?: Line[]
}

const WINDOWS = [7, 30, 90]
const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const ms = (v: number | null | undefined) =>
  v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`

function Fixes({ line }: { line: Line }) {
  const q = encodeURIComponent(line.query)
  const cls = 'text-[11.5px] font-medium text-cyan-700 hover:underline dark:text-nvr-cyan'
  return line.collection ? (
    <span className='flex flex-wrap gap-x-3 gap-y-1'>
      <Link to={`/collections/${line.collection}?search=${q}`} className={cls}>
        Try it in the list
      </Link>
      <Link to={`/data-model/${line.collection}`} className={cls}>
        Check searched fields
      </Link>
    </span>
  ) : (
    <span className='flex flex-wrap gap-x-3 gap-y-1'>
      <Link
        to={`/ask?q=${encodeURIComponent(`Where would I find "${line.query}"?`)}`}
        className={cls}
      >
        Ask where it lives
      </Link>
      <Link to='/collections' className={cls}>
        Review collections
      </Link>
    </span>
  )
}

function Table({
  title,
  hint,
  rows,
  columns,
  fixes
}: {
  title: string
  hint: string
  rows: Line[]
  columns: Array<{ label: string; value: (l: Line) => string }>
  fixes?: boolean
}) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>{title}</h2>
      <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
      {rows.length === 0 ? (
        <p className='mt-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          None in this window.
        </p>
      ) : (
        <div className='mt-3 overflow-x-auto'>
          <table className='w-full text-[12px] tabular-nums'>
            <thead>
              <tr className='text-left text-[11px] text-slate-500 dark:text-muted-foreground'>
                <th className='py-1 pr-3 font-medium'>Search</th>
                {columns.map((c) => (
                  <th key={c.label} className='py-1 pr-3 text-right font-medium'>
                    {c.label}
                  </th>
                ))}
                {fixes && <th className='py-1 font-medium'>Fix</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.collection ?? ''}|${r.query}`}
                  className='border-t border-slate-100 align-top dark:border-border'
                >
                  <td className='max-w-[280px] py-1.5 pr-3'>
                    <span
                      className='block truncate font-mono text-[11.5px] text-slate-800 dark:text-foreground'
                      data-tip={r.query}
                    >
                      {r.query}
                    </span>
                    <span
                      className={cn(
                        'text-[11px] text-slate-500 dark:text-muted-foreground',
                        r.collection && 'font-mono'
                      )}
                    >
                      {r.collection ? r.collection : 'Cmd+K'}
                    </span>
                  </td>
                  {columns.map((c) => (
                    <td
                      key={c.label}
                      className='py-1.5 pr-3 text-right text-slate-600 dark:text-slate-300'
                    >
                      {c.value(r)}
                    </td>
                  ))}
                  {fixes && (
                    <td className='py-1.5'>
                      <Fixes line={r} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function SearchAnalyticsPage() {
  const [days, setDays] = useState(30)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['search-analytics', days],
    queryFn: () =>
      api
        .get<{ data: Summary }>('/search-analytics/summary', { params: { days } })
        .then((r) => r.data.data)
  })
  const searches = (l: Line) => formatNumber(l.searches)

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <header className='flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-nvr-cyan/15'>
            <Search className='h-4 w-4 text-nvr-navy dark:text-nvr-cyan' />
          </div>
          <div>
            <h1 className='text-base font-semibold'>Search Analytics</h1>
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              What people search for, what finds nothing, and what goes unopened.
            </p>
          </div>
        </div>
        <span className='flex shrink-0 rounded-md border border-slate-200 p-0.5 dark:border-border'>
          {WINDOWS.map((d) => (
            <button
              key={d}
              type='button'
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              aria-label={`Last ${d} days`}
              className={cn(
                'rounded px-2.5 py-1 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                days === d
                  ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                  : 'text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {d}d
            </button>
          ))}
        </span>
      </header>
      <div className='flex-1 space-y-4 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {isLoading ? (
          <>
            <Skeleton className='h-20 w-full' />
            <Skeleton className='h-48 w-full' />
          </>
        ) : isError || !data ? (
          <p className='text-[12.5px] text-red-600 dark:text-red-400'>
            Search analytics could not be loaded.
          </p>
        ) : !data.ready ? (
          <p className='py-10 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            The search log is not set up on this database yet. It appears after the next update.
          </p>
        ) : (
          <>
            <div className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-4 dark:border-border dark:bg-border'>
              {[
                [
                  'Searches',
                  formatNumber(data.totals?.searches ?? 0),
                  `${data.totals?.people ?? 0} people`
                ],
                ['Found nothing', pct(data.totals?.zero_result_rate), 'of all searches'],
                ['Opened a result', pct(data.totals?.open_rate), 'of searches with results'],
                ['Typical speed', ms(data.totals?.p75_ms), 'p75 time to results']
              ].map(([label, value, sub]) => (
                <div key={label} className='bg-white px-4 py-3 dark:bg-card'>
                  <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{label}</p>
                  <p className='mt-1 text-[18px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                    {value}
                  </p>
                  <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {sub}
                  </p>
                </div>
              ))}
            </div>
            {(data.totals?.searches ?? 0) === 0 ? (
              <p className='py-10 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                No searches logged in the last {days} days. They appear as people use Cmd+K and the
                search boxes on lists.
              </p>
            ) : (
              <>
                <Table
                  title='Top searches'
                  hint='Most repeated first.'
                  rows={data.top ?? []}
                  columns={[
                    { label: 'Searches', value: searches },
                    { label: 'People', value: (l) => String(l.people) },
                    { label: 'Avg results', value: (l) => String(l.avg_results) }
                  ]}
                />
                <Table
                  title='Found nothing'
                  hint='Searches with no results. Each can be fixed: check which fields a list searches, or find where the thing lives.'
                  rows={data.zero_results ?? []}
                  columns={[
                    { label: 'Searches', value: searches },
                    { label: 'Empty', value: (l) => String(l.zero_results) }
                  ]}
                  fixes
                />
                <Table
                  title='Results, but nothing opened'
                  hint='People searched, saw results and opened none of them: the wrong results ranked first, or the label did not match what they wanted.'
                  rows={data.unopened ?? []}
                  columns={[
                    { label: 'Searches', value: searches },
                    { label: 'Unopened', value: (l) => String(l.unopened) },
                    { label: 'Avg results', value: (l) => String(l.avg_results) }
                  ]}
                />
                <Table
                  title='Slow searches'
                  hint='p75 time to results of a second or more.'
                  rows={data.slow ?? []}
                  columns={[
                    { label: 'Searches', value: searches },
                    { label: 'p75', value: (l) => ms(l.p75_ms) }
                  ]}
                />
              </>
            )}
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Search text is personal data: only administrators see this page and rows are deleted
              after {data.window?.retention_days} days. Results are never stored.
              {data.window?.truncated ? ' The window holds more searches than are counted.' : ''}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

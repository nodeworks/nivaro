import { useQuery } from '@tanstack/react-query'
import { ChevronRight, PlayCircle, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { requestStoryPath } from '@/lib/recent-requests'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Error clusters (#20, Health hub tab): server and client errors grouped by a normalized
 * signature — the message with ids / numbers / quoted values stripped, the top stack frame and
 * the route template — so "Record 4471 not found" and "Record 4472 not found" are one problem.
 * Built over the issue log (nivaro_issues + occurrences). GET /api/ops/error-clusters.
 */

interface Cluster {
  signature: string
  source: string
  message: string
  frame: string | null
  route: string
  count: number
  issues: number
  issue_ids: number[]
  open: number
  first_seen: string | null
  last_seen: string | null
  users: number
  screens: string[]
  builds: string[]
  trend: number[]
  severity: string | null
  replays: Array<{ recording_id: string; offset_ms: number | null }>
}

interface ListAnswer {
  clusters: Cluster[]
  total: number
  truncated: boolean
  window: { since: string; until: string; buckets: number; bucket_ms: number }
}

const WINDOWS = [
  { days: 1, label: '24 h' },
  { days: 7, label: '7 d' },
  { days: 14, label: '14 d' },
  { days: 30, label: '30 d' }
]
const SOURCES = [
  { value: '', label: 'All' },
  { value: 'server', label: 'Server' },
  { value: 'client', label: 'Browser' }
]

function Spark({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values)
  const w = 3
  const gap = 1
  const h = 18
  return (
    <svg
      width={values.length * (w + gap)}
      height={h}
      role='img'
      aria-label={label}
      className='shrink-0 text-red-500 dark:text-red-400'
    >
      {values.map((v, i) => {
        const bh = v === 0 ? 1 : Math.max(2, Math.round((v / max) * h))
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
            key={i}
            x={i * (w + gap)}
            y={h - bh}
            width={w}
            height={bh}
            rx={0.5}
            className={v === 0 ? 'fill-slate-200 dark:fill-slate-700' : 'fill-current'}
          />
        )
      })}
    </svg>
  )
}

export function ErrorClustersPage() {
  const [days, setDays] = useState(7)
  const [source, setSource] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['ops', 'error-clusters', days, source],
    queryFn: () =>
      api
        .get<{ data: ListAnswer }>('/ops/error-clusters', {
          params: { days, ...(source ? { source } : {}) }
        })
        .then((r) => r.data.data)
  })

  const seg = (on: boolean) =>
    cn(
      'px-2.5 py-[3px] text-[12px] font-medium first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
      on ? 'bg-nvr-cyan/10 text-foreground' : 'text-muted-foreground hover:bg-muted'
    )

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar
        description='Server and browser errors grouped by what they are, not by their exact words: ids, numbers and quoted values are stripped, so the same fault on many records is one row — with how often, since when, how many people and where.'
        actions={
          <>
            <fieldset className='m-0 flex rounded-md border border-slate-200 p-0 dark:border-border'>
              <legend className='sr-only'>Window</legend>
              {WINDOWS.map((w) => (
                <button
                  key={w.days}
                  type='button'
                  aria-pressed={days === w.days}
                  onClick={() => setDays(w.days)}
                  className={seg(days === w.days)}
                >
                  {w.label}
                </button>
              ))}
            </fieldset>
            <fieldset className='m-0 flex rounded-md border border-slate-200 p-0 dark:border-border'>
              <legend className='sr-only'>Source</legend>
              {SOURCES.map((s) => (
                <button
                  key={s.value}
                  type='button'
                  aria-pressed={source === s.value}
                  onClick={() => setSource(s.value)}
                  className={seg(source === s.value)}
                >
                  {s.label}
                </button>
              ))}
            </fieldset>
            <button
              type='button'
              onClick={() => void q.refetch()}
              className='rounded-md border border-slate-200 p-1 text-slate-400 hover:text-slate-600 dark:border-border dark:hover:text-foreground'
              aria-label='Refresh'
            >
              <RotateCw className={cn('h-3.5 w-3.5', q.isFetching && 'animate-spin')} />
            </button>
          </>
        }
      />
      <div className='flex-1 overflow-y-auto bg-slate-50 px-4 py-4 sm:px-6 dark:bg-background'>
        {q.isLoading ? (
          <div className='space-y-2' role='status' aria-label='Loading'>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-12 w-full' />
            ))}
          </div>
        ) : q.isError ? (
          <p className='text-[12.5px] text-red-600 dark:text-red-400'>
            Could not read the clusters.
          </p>
        ) : !q.data || q.data.clusters.length === 0 ? (
          <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-[12.5px] text-muted-foreground dark:border-border dark:bg-card'>
            No errors were recorded in this window.
          </p>
        ) : (
          <>
            <p className='mb-2 text-[11.5px] text-muted-foreground'>
              {q.data.total} {q.data.total === 1 ? 'cluster' : 'clusters'}
              {q.data.truncated && ' · the newest 3,000 issues were read'} · trend from each issue's
              last 50 hits
            </p>
            <ul className='m-0 list-none divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white p-0 dark:divide-border dark:border-border dark:bg-card'>
              {q.data.clusters.map((c) => (
                <ClusterRow
                  key={c.signature}
                  cluster={c}
                  days={days}
                  source={source}
                  open={open === c.signature}
                  onToggle={() => setOpen(open === c.signature ? null : c.signature)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

function ClusterRow({
  cluster: c,
  days,
  source,
  open,
  onToggle
}: {
  cluster: Cluster
  days: number
  source: string
  open: boolean
  onToggle: () => void
}) {
  const panel = `cluster-${c.signature}`
  return (
    <li data-error-cluster={c.signature}>
      <button
        type='button'
        aria-expanded={open}
        aria-controls={panel}
        onClick={onToggle}
        className='flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
            open && 'rotate-90'
          )}
          aria-hidden
        />
        <span className='w-[54px] shrink-0 text-right text-[13px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
          {c.count.toLocaleString()}
        </span>
        <span className='min-w-0 flex-1'>
          <span
            className='block truncate text-[12.5px] text-slate-800 dark:text-foreground'
            data-tip={c.message}
          >
            {c.message}
          </span>
          <span className='block truncate font-mono text-[11px] text-muted-foreground'>
            {c.route}
            {c.frame ? ` · ${c.frame}` : ''}
          </span>
        </span>
        <span
          className={cn(
            'hidden shrink-0 rounded px-1.5 py-px text-[10.5px] font-semibold sm:inline',
            c.source === 'client'
              ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
              : 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300'
          )}
        >
          {c.source === 'client' ? 'Browser' : 'Server'}
        </span>
        <Spark values={c.trend} label={`${c.count} hits, trend over the window`} />
        <span className='hidden w-[70px] shrink-0 text-right text-[11.5px] text-muted-foreground md:inline'>
          {c.users} {c.users === 1 ? 'person' : 'people'}
        </span>
        <span className='w-[78px] shrink-0 text-right text-[11.5px] text-muted-foreground'>
          {c.last_seen ? formatRelative(c.last_seen) : '—'}
        </span>
      </button>
      {open && <ClusterDetail id={panel} cluster={c} days={days} source={source} />}
    </li>
  )
}

function ClusterDetail({
  id,
  cluster: c,
  days,
  source
}: {
  id: string
  cluster: Cluster
  days: number
  source: string
}) {
  const q = useQuery({
    queryKey: ['ops', 'error-cluster', c.signature, days, source],
    queryFn: () =>
      api
        .get<{
          data: {
            requests: Array<{ request_id: string; at: string; path: string; status: number }>
          }
        }>(`/ops/error-clusters/${c.signature}`, {
          params: { days, ...(source ? { source } : {}) }
        })
        .then((r) => r.data.data)
  })
  return (
    <div
      id={id}
      className='space-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-[12px] dark:border-border dark:bg-muted/20'
    >
      <dl className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
        {(
          [
            ['First seen', c.first_seen ? new Date(c.first_seen).toLocaleString() : '—'],
            ['Last seen', c.last_seen ? new Date(c.last_seen).toLocaleString() : '—'],
            ['Issues', `${c.issues} (${c.open} open)`],
            ['Severity', c.severity ?? '—']
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <div key={k} className='bg-white px-3 py-1.5 dark:bg-card'>
            <dt className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
              {k}
            </dt>
            <dd className='m-0 text-[12px] text-slate-800 dark:text-foreground'>{v}</dd>
          </div>
        ))}
      </dl>

      {c.screens.length > 0 && (
        <div>
          <p className='m-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
            {c.source === 'client' ? 'Screens' : 'Routes'}
          </p>
          <ul className='m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0'>
            {c.screens.map((s) => (
              <li
                key={s}
                className='rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-600 ring-1 ring-slate-200 dark:bg-card dark:text-slate-300 dark:ring-border'
              >
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.builds.length > 0 && (
        <p className='m-0 text-[11.5px] text-muted-foreground'>
          Builds: <span className='font-mono'>{c.builds.join(', ')}</span>
        </p>
      )}

      {c.replays.length > 0 && (
        <div className='flex flex-wrap gap-2'>
          {c.replays.map((r) => (
            <Link
              key={r.recording_id}
              to={`/analytics/replays?recording=${r.recording_id}${r.offset_ms != null ? `&t=${r.offset_ms}` : ''}`}
              className='inline-flex items-center gap-1.5 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/10 px-2 py-1 text-[11.5px] font-medium text-slate-800 hover:bg-nvr-cyan/20 dark:text-slate-100'
            >
              <PlayCircle className='h-3.5 w-3.5' aria-hidden />
              Watch a replay
            </Link>
          ))}
        </div>
      )}

      {c.source === 'server' && (
        <div>
          <p className='m-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
            Recent requests
          </p>
          {q.isLoading ? (
            <Skeleton className='mt-1 h-6 w-1/2' />
          ) : (q.data?.requests ?? []).length === 0 ? (
            <p className='m-0 mt-1 text-[11.5px] text-muted-foreground'>
              No API log row matched the stored hits (the log keeps 14 days).
            </p>
          ) : (
            <ul className='m-0 mt-1 list-none space-y-0.5 p-0'>
              {q.data?.requests.map((r) => (
                <li key={r.request_id} className='flex min-w-0 items-center gap-2 text-[11.5px]'>
                  <span className='font-semibold tabular-nums text-red-600 dark:text-red-400'>
                    {r.status}
                  </span>
                  <span className='min-w-0 truncate font-mono text-slate-600 dark:text-slate-300'>
                    {r.path}
                  </span>
                  <span className='shrink-0 text-muted-foreground'>{formatRelative(r.at)}</span>
                  <Link
                    to={requestStoryPath(r.request_id)}
                    className='shrink-0 font-medium text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
                  >
                    Request story
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className='m-0 text-[11.5px] text-muted-foreground'>
        Issue{c.issue_ids.length === 1 ? '' : 's'}{' '}
        {c.issue_ids.slice(0, 12).map((iid, i) => (
          <span key={iid}>
            {i > 0 && ', '}
            <Link to='/issues' className='font-mono underline-offset-2 hover:underline'>
              #{iid}
            </Link>
          </span>
        ))}
        {c.issue_ids.length > 12 && ` and ${c.issue_ids.length - 12} more`}
      </p>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { BarChart2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { SlowTracesPanel } from '@/components/slow-traces'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'

interface Summary {
  total: number
  error_rate: number
  p50: number
  p95: number
  avg_latency: number
}

interface TimeseriesPoint {
  bucket: string
  count: number
  avg_latency: number
  errors: number
}

interface TopPath {
  method: string
  path: string
  count: number
  avg_latency: number
  errors: number
}

interface ErrorLog {
  id: number
  method: string
  path: string
  status: number
  latency_ms: number
  created_at: string
}

const RANGES = [
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 }
]

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <p className='text-[11px] uppercase tracking-wide text-muted-foreground'>{label}</p>
      <p className='mt-1 text-[20px] font-semibold'>{value}</p>
      {sub && <p className='text-[11px] text-muted-foreground'>{sub}</p>}
    </div>
  )
}

export function ApiAnalyticsPage() {
  const [hours, setHours] = useState(24)

  const { data: summary } = useQuery<Summary>({
    queryKey: ['api-analytics-summary', hours],
    queryFn: () =>
      api.get<{ data: Summary }>(`/api-analytics/summary?hours=${hours}`).then((r) => r.data.data),
    refetchInterval: 30_000
  })

  const { data: timeseries = [] } = useQuery<TimeseriesPoint[]>({
    queryKey: ['api-analytics-timeseries', hours],
    queryFn: () =>
      api
        .get<{ data: TimeseriesPoint[] }>(`/api-analytics/timeseries?hours=${hours}`)
        .then((r) => r.data.data),
    refetchInterval: 30_000
  })

  const { data: topPaths = [] } = useQuery<TopPath[]>({
    queryKey: ['api-analytics-top-paths', hours],
    queryFn: () =>
      api
        .get<{ data: TopPath[] }>(`/api-analytics/top-paths?hours=${hours}`)
        .then((r) => r.data.data),
    refetchInterval: 30_000
  })

  const { data: errors = [] } = useQuery<ErrorLog[]>({
    queryKey: ['api-analytics-errors'],
    queryFn: () => api.get<{ data: ErrorLog[] }>('/api-analytics/errors').then((r) => r.data.data),
    refetchInterval: 30_000
  })

  const points = timeseries.map((p) => ({
    ...p,
    label: new Date(p.bucket).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit'
    })
  }))

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-border'>
        <div className='flex items-center gap-2.5'>
          <BarChart2 className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>API Analytics</h1>
        </div>
        <div className='flex items-center gap-1'>
          {RANGES.map((r) => (
            <Button
              key={r.hours}
              size='sm'
              variant={hours === r.hours ? 'default' : 'outline'}
              className='h-7 px-2.5 text-[12px]'
              onClick={() => setHours(r.hours)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {/* Stat strip */}
        <div className='mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4'>
          <StatCard
            label='Total requests'
            value={summary ? formatNumber(summary.total) : '—'}
            sub={`last ${hours}h`}
          />
          <StatCard
            label='Error rate'
            value={summary ? `${summary.error_rate}%` : '—'}
            sub='status ≥ 400'
          />
          <StatCard
            label='p50 latency'
            value={summary ? `${summary.p50} ms` : '—'}
            sub={summary ? `avg ${summary.avg_latency} ms` : undefined}
          />
          <StatCard label='p95 latency' value={summary ? `${summary.p95} ms` : '—'} />
        </div>

        {/* Timeseries chart */}
        <div className='mb-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <p className='mb-3 text-[13px] font-medium'>Requests per hour</p>
          {points.length === 0 ? (
            <p className='py-10 text-center text-[12px] text-muted-foreground'>
              No traffic recorded yet
            </p>
          ) : (
            <ResponsiveContainer width='100%' height={220}>
              <BarChart data={points} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray='3 3' stroke='rgba(0,0,0,0.06)' />
                <XAxis dataKey='label' tick={{ fontSize: 10 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ fontSize: 12, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }} labelStyle={{ color: '#f1f5f9' }} itemStyle={{ color: '#e2e8f0' }}
                  formatter={(value, name) => {
                    if (name === 'count') return [formatNumber(Number(value ?? 0)), 'Requests']
                    if (name === 'errors') return [formatNumber(Number(value ?? 0)), 'Errors']
                    return [String(value), String(name)]
                  }}
                />
                <Bar dataKey='count' fill='#00ceff' radius={[3, 3, 0, 0]} />
                <Bar dataKey='errors' fill='#ef4444' radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Tables */}
        <div className='grid gap-6 xl:grid-cols-2'>
          <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <p className='border-b border-slate-200 px-4 py-3 text-[13px] font-medium dark:border-border'>
              Top paths
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='text-[11px]'>Path</TableHead>
                  <TableHead className='w-20 text-right text-[11px]'>Count</TableHead>
                  <TableHead className='w-24 text-right text-[11px]'>Avg ms</TableHead>
                  <TableHead className='w-20 text-right text-[11px]'>Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topPaths.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className='py-8 text-center text-[12px] text-muted-foreground'
                    >
                      No data
                    </TableCell>
                  </TableRow>
                ) : (
                  topPaths.map((p) => (
                    <TableRow key={`${p.method} ${p.path}`}>
                      <TableCell className='max-w-0 truncate font-mono text-[12px]'>
                        <span className='mr-1.5 text-muted-foreground'>{p.method}</span>
                        {p.path}
                      </TableCell>
                      <TableCell className='text-right text-[12px]'>
                        {formatNumber(p.count)}
                      </TableCell>
                      <TableCell className='text-right text-[12px]'>{p.avg_latency}</TableCell>
                      <TableCell
                        className={cn(
                          'text-right text-[12px]',
                          p.errors > 0 && 'text-red-600 dark:text-red-400'
                        )}
                      >
                        {p.errors}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <p className='border-b border-slate-200 px-4 py-3 text-[13px] font-medium dark:border-border'>
              Recent errors
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-32 text-[11px]'>Time</TableHead>
                  <TableHead className='text-[11px]'>Path</TableHead>
                  <TableHead className='w-16 text-right text-[11px]'>Status</TableHead>
                  <TableHead className='w-16 text-right text-[11px]'>ms</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className='py-8 text-center text-[12px] text-muted-foreground'
                    >
                      No errors recorded
                    </TableCell>
                  </TableRow>
                ) : (
                  errors.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className='text-[12px] text-muted-foreground'>
                        {new Date(e.created_at).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </TableCell>
                      <TableCell className='max-w-0 truncate font-mono text-[12px]'>
                        <span className='mr-1.5 text-muted-foreground'>{e.method}</span>
                        {e.path}
                      </TableCell>
                      <TableCell className='text-right text-[12px] font-medium text-red-600 dark:text-red-400'>
                        {e.status}
                      </TableCell>
                      <TableCell className='text-right text-[12px]'>{e.latency_ms}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className='mt-6'>
          <ByKeyPanel hours={hours} />
        </div>
        <div className='mt-6'>
          <SlowTracesPanel />
        </div>
        <div className='mt-6'>
          <RumPanel />
        </div>
        <div className='mt-6'>
          <IndexAdvisorPanel />
        </div>
      </div>
    </div>
  )
}

/** What users actually feel: client-measured load vitals + SPA route-change
 *  p75s per route pattern. Server latency (above) says the API is fast; this
 *  says whether the pages are. */

/** Per-API-key traffic (#67) — which integration is hammering the API, and
 *  whether its calls are erroring. Session/cookie traffic is excluded; only
 *  requests authenticated by a named nivaro_api_keys key appear. */
function ByKeyPanel({ hours }: { hours: number }) {
  const { data: rows = [] } = useQuery<
    Array<{
      api_key_id: number
      name: string
      count: number
      avg_latency: number
      errors: number
      last_seen: string | null
    }>
  >({
    queryKey: ['api-analytics-by-key', hours],
    queryFn: () =>
      api.get(`/api-analytics/by-key?hours=${hours}`).then((r) => r.data.data)
  })
  if (rows.length === 0) return null
  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <p className='border-b border-slate-200 px-4 py-3 text-[13px] font-medium dark:border-border'>
        Traffic by API key
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className='text-[11px]'>Key</TableHead>
            <TableHead className='w-24 text-right text-[11px]'>Requests</TableHead>
            <TableHead className='w-24 text-right text-[11px]'>Avg ms</TableHead>
            <TableHead className='w-20 text-right text-[11px]'>Errors</TableHead>
            <TableHead className='w-40 text-right text-[11px]'>Last seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((k) => (
            <TableRow key={k.api_key_id}>
              <TableCell className='text-[12px] font-medium'>{k.name}</TableCell>
              <TableCell className='text-right text-[12px]'>{formatNumber(k.count)}</TableCell>
              <TableCell className='text-right text-[12px]'>{k.avg_latency}</TableCell>
              <TableCell
                className={cn(
                  'text-right text-[12px]',
                  k.errors > 0 && 'text-red-600 dark:text-red-400'
                )}
              >
                {k.errors}
              </TableCell>
              <TableCell className='text-right text-[12px] text-muted-foreground'>
                {k.last_seen ? new Date(k.last_seen).toLocaleString() : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function RumPanel() {
  const [days, setDays] = useState(1)
  const { data } = useQuery({
    queryKey: ['rum-summary', days],
    queryFn: () => api.get('/rum/summary', { params: { days } }).then((r) => r.data)
  })
  const rows: Array<{
    route: string
    samples: number
    load_p75: number | null
    lcp_p75: number | null
    route_p75: number | null
  }> = data?.data ?? []
  const ms = (v: number | null) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`)
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex items-center justify-between'>
        <div>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Real-user timings
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-400'>
            Measured in the browser: page-load vitals (LCP) and SPA navigation times, p75 per route.
          </p>
        </div>
        <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
          {[1, 7, 14].map((d) => (
            <button
              key={d}
              type='button'
              onClick={() => setDays(d)}
              className={
                days === d
                  ? 'rounded bg-nvr-cyan/10 px-2 py-0.5 text-[11px] font-medium text-slate-800 dark:text-foreground'
                  : 'rounded px-2 py-0.5 text-[11px] font-medium text-slate-400'
              }
            >
              {d}d
            </button>
          ))}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className='mt-3 text-[12px] text-slate-400'>
          No samples yet — timings arrive as people browse (the collector reports a few seconds
          after each page settles).
        </p>
      ) : (
        <table className='mt-3 w-full text-[12px] tabular-nums'>
          <thead>
            <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
              <th className='py-1 pr-3 font-semibold'>Route</th>
              <th className='py-1 pr-3 font-semibold'>Samples</th>
              <th className='py-1 pr-3 font-semibold'>LCP p75</th>
              <th className='py-1 pr-3 font-semibold'>Full load p75</th>
              <th className='py-1 font-semibold'>Route change p75</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 25).map((r) => (
              <tr key={r.route} className='border-t border-slate-100 dark:border-border'>
                <td className='py-1.5 pr-3 font-mono text-[11.5px] text-slate-700 dark:text-foreground'>
                  {r.route}
                </td>
                <td className='py-1.5 pr-3 text-slate-500'>{r.samples}</td>
                <td className='py-1.5 pr-3 text-slate-600 dark:text-muted-foreground'>{ms(r.lcp_p75)}</td>
                <td className='py-1.5 pr-3 text-slate-600 dark:text-muted-foreground'>{ms(r.load_p75)}</td>
                <td className='py-1.5 text-slate-600 dark:text-muted-foreground'>{ms(r.route_p75)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** Config-driven index suggestions: hot filter columns (FKs, queue filters,
 *  RLS, state mirrors) on big tables with no leading-column index. */
function IndexAdvisorPanel() {
  const [applying, setApplying] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkRunId, setBulkRunId] = useState<number | null>(null)
  const { data, refetch } = useQuery({
    queryKey: ['index-advisor'],
    queryFn: () => api.get('/index-advisor').then((r) => r.data.data)
  })
  const suggestions: Array<{
    table: string
    column: string
    rows: number
    reasons: string[]
    create_sql: string
  }> = data?.suggestions ?? []

  // Bulk runs in the background — poll its job run for live progress.
  const bulkRun = useQuery({
    queryKey: ['index-bulk-run', bulkRunId],
    queryFn: () =>
      api
        .get('/job-runs', { params: { kind: 'recalc', job_id: 'index-bulk', limit: 5 } })
        .then(
          (r) =>
            (r.data.data as Array<{ id: number; status: string; progress: string | null; outcome: string | null; error: string | null }>).find(
              (x) => x.id === bulkRunId
            ) ?? null
        ),
    enabled: bulkRunId != null,
    refetchInterval: 2500
  })
  const bulkDone = !!bulkRun.data && bulkRun.data.status !== 'running'
  useEffect(() => {
    if (bulkDone && bulkRunId != null) {
      // One-shot: clear the poll and refresh the suggestion list.
      setBulkRunId(null)
      void refetch()
    }
  }, [bulkDone, bulkRunId, refetch])
  const bulkProgress = bulkRun.data?.progress
    ? (JSON.parse(bulkRun.data.progress) as { done: number; total: number; current: string; failed: number })
    : null

  const apply = async (s: { table: string; column: string }) => {
    const key = `${s.table}.${s.column}`
    if (!window.confirm(`Create index on ${key}? On a large table this can take a minute.`)) return
    setApplying(key)
    try {
      await api.post('/index-advisor/apply', s)
      void refetch()
    } catch (err: unknown) {
      window.alert(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed'
      )
    } finally {
      setApplying(null)
    }
  }

  const applyBulk = async () => {
    const items = suggestions.filter((s) => selected.has(`${s.table}.${s.column}`))
    if (items.length === 0) return
    if (
      !window.confirm(
        `Create ${items.length} index(es)? They build one at a time in the background — large tables take a minute each.`
      )
    )
      return
    const r = await api.post('/index-advisor/apply-bulk', {
      items: items.map((s) => ({ table: s.table, column: s.column }))
    })
    setBulkRunId(r.data.data.job_run_id)
    setSelected(new Set())
  }

  const allKeys = suggestions.map((s) => `${s.table}.${s.column}`)
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k))

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>Index advisor</p>
          <p className='mt-0.5 text-[11.5px] text-slate-400'>
            Columns your config filters on (foreign keys, queue filters, row-level security,
            workflow state mirrors) that have no index on tables over{' '}
            {((data?.min_rows ?? 50000) / 1000).toFixed(0)}k rows.
          </p>
        </div>
        {suggestions.length > 0 && (
          <div className='flex items-center gap-2.5'>
            <label className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              <input
                type='checkbox'
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(allKeys))}
                className='h-3.5 w-3.5'
              />
              Select all
            </label>
            <button
              type='button'
              disabled={selected.size === 0 || bulkRunId != null}
              onClick={() => void applyBulk()}
              className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white disabled:opacity-50'
            >
              Create {selected.size > 0 ? `${selected.size} ` : ''}selected
            </button>
          </div>
        )}
      </div>
      {bulkRunId != null && (
        <p className='mt-2 rounded-md bg-sky-500/10 px-3 py-1.5 text-[12px] text-sky-800 dark:text-sky-300'>
          Building indexes in the background —{' '}
          {bulkProgress
            ? `${bulkProgress.done}/${bulkProgress.total} done${bulkProgress.failed ? ` (${bulkProgress.failed} failed)` : ''} · now: ${bulkProgress.current}`
            : 'starting…'}
        </p>
      )}
      {suggestions.length === 0 ? (
        <p className='mt-3 text-[12px] text-emerald-600 dark:text-emerald-400'>
          No gaps — every hot filter column on a large table is indexed.
        </p>
      ) : (
        <div className='mt-3 space-y-1.5'>
          {suggestions.map((s) => {
            const key = `${s.table}.${s.column}`
            return (
              <div
                key={key}
                className='flex items-center gap-3 rounded-md border border-slate-100 px-3 py-2 dark:border-border'
              >
                <input
                  type='checkbox'
                  checked={selected.has(key)}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }
                  className='h-3.5 w-3.5 shrink-0'
                />
                <div className='min-w-0 flex-1'>
                  <p className='font-mono text-[12px] text-slate-700 dark:text-foreground'>
                    {key}
                    <span className='ml-2 text-[11px] text-slate-400'>
                      {s.rows.toLocaleString()} rows
                    </span>
                  </p>
                  <p className='text-[11px] text-slate-400'>{s.reasons.join(' · ')}</p>
                </div>
                <button
                  type='button'
                  disabled={applying === key}
                  onClick={() => apply(s)}
                  className='h-7 shrink-0 rounded-md border border-slate-200 px-2.5 text-[12px] text-slate-600 hover:border-slate-300 disabled:opacity-50 dark:border-border dark:text-muted-foreground'
                >
                  {applying === key ? 'Creating…' : 'Create index'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/utils'

/**
 * Public read-only dashboard — rendered from a share-link token, no auth,
 * outside the admin shell. Auto-refreshes every 60s.
 */

interface PublicWidget {
  id: string
  type: string
  title: string | null
  col: number
  row: number
  width: number
  height: number
  data: { value?: number | null; rows?: Array<Record<string, unknown>> } | null
}

function KpiTile({ w }: { w: PublicWidget }) {
  return (
    <div className='flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900'>
      <p className='text-[12px] font-medium text-slate-400'>{w.title ?? w.type}</p>
      <p className='mt-2 text-3xl font-semibold tabular-nums text-slate-900 dark:text-slate-100'>
        {w.data?.value != null ? formatNumber(w.data.value) : '—'}
      </p>
    </div>
  )
}

function ChartTile({ w }: { w: PublicWidget }) {
  const rows = (w.data?.rows ?? []) as Array<{ date: string; count: number }>
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div className='rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900'>
      <p className='text-[12px] font-medium text-slate-400'>{w.title ?? w.type}</p>
      {rows.length === 0 ? (
        <p className='mt-6 text-center text-[12px] text-slate-300'>No data in the last 30 days</p>
      ) : w.type === 'line_chart' ? (
        <svg viewBox='0 0 300 90' className='mt-3 w-full'>
          <title>{w.title ?? 'chart'}</title>
          <polyline
            fill='none'
            stroke='#00ceff'
            strokeWidth={2}
            points={rows
              .map(
                (r, i) =>
                  `${(i / Math.max(1, rows.length - 1)) * 296 + 2},${86 - (r.count / max) * 78}`
              )
              .join(' ')}
          />
        </svg>
      ) : (
        <div className='mt-3 flex h-24 items-end gap-[2px]'>
          {rows.map((r) => (
            <div
              key={r.date}
              title={`${r.date}: ${r.count}`}
              className='flex-1 rounded-t-sm bg-[#00ceff]'
              style={{ height: `${Math.max(4, (r.count / max) * 100)}%`, opacity: 0.85 }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function LatestTile({ w }: { w: PublicWidget }) {
  const rows = w.data?.rows ?? []
  return (
    <div className='rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900'>
      <p className='mb-2 text-[12px] font-medium text-slate-400'>{w.title ?? 'Latest'}</p>
      <div className='space-y-1'>
        {rows.slice(0, 6).map((r) => (
          <p
            key={String(r.id)}
            className='truncate text-[12.5px] text-slate-700 dark:text-slate-300'
          >
            {String(r.title ?? r.name ?? r.label ?? r.subject ?? `#${String(r.id)}`)}
          </p>
        ))}
        {rows.length === 0 && <p className='text-[12px] text-slate-300'>No records</p>}
      </div>
    </div>
  )
}

export function PublicDashboardPage() {
  const { token } = useParams<{ token: string }>()

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['public-dashboard', token],
    queryFn: () =>
      api
        .get<{ data: { name: string; widgets: PublicWidget[] } }>(
          `/dashboard-links/public/${token}`
        )
        .then((r) => r.data.data),
    enabled: !!token,
    refetchInterval: 60_000,
    retry: false
  })

  if (isLoading) {
    return (
      <div className='flex min-h-screen items-center justify-center bg-slate-50 text-slate-400 dark:bg-slate-950'>
        Loading dashboard…
      </div>
    )
  }
  if (isError || !data) {
    const status = (error as { response?: { status?: number } })?.response?.status
    return (
      <div className='flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950'>
        <p className='text-[14px] text-slate-500'>
          {status === 410 ? 'This dashboard link has expired.' : 'Dashboard not found.'}
        </p>
      </div>
    )
  }

  return (
    <div className='min-h-screen bg-slate-50 dark:bg-slate-950'>
      <div className='mx-auto max-w-5xl px-6 py-8'>
        <h1 className='text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100'>
          {data.name}
        </h1>
        <p className='mt-0.5 text-[12px] text-slate-400'>Live view · refreshes every minute</p>

        <div className='mt-6 grid grid-cols-2 gap-4 md:grid-cols-4'>
          {data.widgets.map((w) => (
            <div key={w.id} style={{ gridColumn: `span ${Math.min(4, Math.max(1, w.width))}` }}>
              {w.type === 'bar_chart' || w.type === 'line_chart' ? (
                <ChartTile w={w} />
              ) : w.type === 'latest' ? (
                <LatestTile w={w} />
              ) : (
                <KpiTile w={w} />
              )}
            </div>
          ))}
        </div>

        <p className='mt-10 text-center text-[10.5px] uppercase tracking-[0.25em] text-slate-300'>
          Powered by Nivaro
        </p>
      </div>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { BarChart2, Clock, Globe, Monitor, Search, Smartphone, Tablet, Users } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

type Period = '1d' | '7d' | '30d'

interface Stats {
  total_views: number
  unique_sessions: number
  unique_pages: number
  top_pages: { page_url: string; views: number; unique_sessions: number }[]
}

interface PageView {
  id: number
  session_id: string
  user_email: string | null
  user_name: string | null
  page_url: string
  page_title: string | null
  device_type: string | null
  ip: string | null
  viewed_at: string
  duration_seconds: number | null
}

const PERIODS: { value: Period; label: string }[] = [
  { value: '1d', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' }
]

function fmtDuration(s: number | null): string {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function truncateUrl(url: string, max = 60): string {
  try {
    const u = new URL(url)
    const p = u.pathname + u.search
    return p.length > max ? `${p.slice(0, max - 1)}…` : p
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url
  }
}

function DeviceIcon({ type }: { type: string | null }) {
  if (type === 'mobile') return <Smartphone className='h-3 w-3' />
  if (type === 'tablet') return <Tablet className='h-3 w-3' />
  return <Monitor className='h-3 w-3' />
}

function StatCard({
  label,
  value,
  icon: Icon,
  loading
}: {
  label: string
  value: React.ReactNode
  icon: React.ElementType
  loading?: boolean
}) {
  return (
    <div className='flex items-center gap-4 rounded-lg border bg-card px-5 py-4'>
      <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/[0.15] dark:text-nvr-cyan'>
        <Icon className='h-4 w-4' />
      </div>
      <div>
        {loading ? (
          <Skeleton className='h-7 w-16 rounded' />
        ) : (
          <p className='text-[26px] font-semibold tabular-nums leading-none tracking-tight'>
            {value}
          </p>
        )}
        <p className='mt-1 text-[11px] text-muted-foreground'>{label}</p>
      </div>
    </div>
  )
}

export function AnalyticsPage() {
  const navigate = useNavigate()
  const [period, setPeriod] = useState<Period>('7d')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const { data: stats, isLoading: statsLoading } = useQuery<Stats>({
    queryKey: ['analytics-stats', period],
    queryFn: () => api.get<Stats>(`/analytics/pageviews/stats?period=${period}`).then((r) => r.data)
  })

  const { data: views, isLoading: viewsLoading } = useQuery({
    queryKey: ['analytics-views', period, search, page],
    queryFn: () =>
      api
        .get<{ data: PageView[]; total: number; page: number; limit: number }>(
          `/analytics/pageviews?period=${period}&page=${page}&limit=50${search ? `&search=${encodeURIComponent(search)}` : ''}`
        )
        .then((r) => r.data)
  })

  const rows: PageView[] = views?.data ?? []
  const totalPages = views ? Math.ceil(views.total / views.limit) : 1

  return (
    <div className='flex flex-col gap-6 p-6'>
      {/* Header */}
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h1 className='text-xl font-semibold text-foreground'>Frontend Analytics</h1>
          <p className='mt-0.5 text-sm text-muted-foreground'>
            Page views and session activity from the embedded tracker
          </p>
        </div>

        {/* Period tabs */}
        <div className='flex rounded-lg border bg-card p-1 gap-1'>
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type='button'
              onClick={() => {
                setPeriod(p.value)
                setPage(1)
              }}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                period === p.value
                  ? 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
        <StatCard
          label='Total page views'
          value={stats?.total_views.toLocaleString() ?? '—'}
          icon={BarChart2}
          loading={statsLoading}
        />
        <StatCard
          label='Unique sessions'
          value={stats?.unique_sessions.toLocaleString() ?? '—'}
          icon={Users}
          loading={statsLoading}
        />
        <StatCard
          label='Unique pages'
          value={stats?.unique_pages.toLocaleString() ?? '—'}
          icon={Globe}
          loading={statsLoading}
        />
      </div>

      <div className='grid gap-6 xl:grid-cols-[1fr_300px] items-start'>
        {/* Page views table */}
        <div className='space-y-3'>
          <div className='flex items-center justify-between gap-3'>
            <h2 className='text-[13px] font-semibold'>Recent Page Views</h2>
            <div className='relative w-56'>
              <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground' />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(1)
                }}
                placeholder='Search URL, user…'
                className='h-8 pl-8 text-[12px]'
              />
            </div>
          </div>

          <div className='rounded-lg border bg-card'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-[140px]'>Time</TableHead>
                  <TableHead>Page</TableHead>
                  <TableHead className='w-[160px]'>User</TableHead>
                  <TableHead className='w-[70px]'>Device</TableHead>
                  <TableHead className='w-[80px]'>Duration</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewsLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
                    <TableRow key={i}>
                      {[140, 280, 160, 70, 80].map((w) => (
                        <TableCell key={w}>
                          <Skeleton className='h-4 rounded' style={{ width: w * 0.6 }} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className='h-32 text-center text-sm text-muted-foreground'
                    >
                      No page views recorded for this period
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow
                      key={row.id}
                      className='cursor-pointer'
                      onClick={() => navigate(`/presence?session=${row.session_id}`)}
                    >
                      <TableCell className='text-[11px] text-muted-foreground whitespace-nowrap'>
                        {formatRelative(row.viewed_at)}
                      </TableCell>
                      <TableCell>
                        <p
                          className='text-[12px] font-medium leading-tight truncate max-w-[280px]'
                          title={row.page_url}
                        >
                          {truncateUrl(row.page_url)}
                        </p>
                        {row.page_title && (
                          <p className='text-[11px] text-muted-foreground leading-tight truncate max-w-[280px]'>
                            {row.page_title}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.user_name || row.user_email ? (
                          <div>
                            {row.user_name && (
                              <p className='text-[12px] font-medium leading-tight'>
                                {row.user_name}
                              </p>
                            )}
                            {row.user_email && (
                              <p className='text-[11px] text-muted-foreground leading-tight'>
                                {row.user_email}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className='text-[11px] italic text-muted-foreground'>
                            Anonymous
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant='outline' className='gap-1 text-[10px]'>
                          <DeviceIcon type={row.device_type} />
                          {row.device_type ?? 'desktop'}
                        </Badge>
                      </TableCell>
                      <TableCell className='font-mono text-[11px] text-muted-foreground'>
                        {fmtDuration(row.duration_seconds)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className='flex items-center justify-between text-[12px] text-muted-foreground'>
              <span>{views?.total.toLocaleString()} total views</span>
              <div className='flex items-center gap-2'>
                <button
                  type='button'
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className='rounded-md border px-2.5 py-1 hover:bg-muted disabled:opacity-40'
                >
                  Prev
                </button>
                <span>
                  {page} / {totalPages}
                </span>
                <button
                  type='button'
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className='rounded-md border px-2.5 py-1 hover:bg-muted disabled:opacity-40'
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Top pages sidebar */}
        <div className='rounded-lg border bg-card p-4'>
          <h2 className='mb-3 text-[13px] font-semibold'>Top Pages</h2>
          {statsLoading ? (
            <div className='space-y-2'>
              {Array.from({ length: 5 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
                <Skeleton key={i} className='h-10 w-full rounded' />
              ))}
            </div>
          ) : !stats?.top_pages.length ? (
            <p className='text-[12px] text-muted-foreground'>No data for this period</p>
          ) : (
            <div className='space-y-1'>
              {stats.top_pages.map((p, i) => {
                const maxViews = stats.top_pages[0]?.views ?? 1
                const pct = Math.round((p.views / maxViews) * 100)
                return (
                  <div key={p.page_url} className='group rounded-md px-2 py-2 hover:bg-muted/50'>
                    <div className='flex items-start justify-between gap-2 mb-1'>
                      <div className='flex items-start gap-1.5 min-w-0'>
                        <span className='text-[10px] font-mono text-muted-foreground mt-0.5 shrink-0 w-4'>
                          {i + 1}
                        </span>
                        <p
                          className='text-[11px] font-medium truncate leading-tight'
                          title={p.page_url}
                        >
                          {truncateUrl(p.page_url, 35)}
                        </p>
                      </div>
                      <div className='flex items-center gap-1.5 shrink-0'>
                        <span className='text-[11px] font-semibold tabular-nums'>
                          {p.views.toLocaleString()}
                        </span>
                        <Clock className='h-3 w-3 text-muted-foreground' />
                      </div>
                    </div>
                    <div className='ml-5.5 h-1 rounded-full bg-muted overflow-hidden'>
                      <div
                        className='h-full rounded-full bg-nvr-cyan/60 transition-all'
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className='ml-5.5 mt-0.5 text-[10px] text-muted-foreground'>
                      {p.unique_sessions.toLocaleString()} sessions
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

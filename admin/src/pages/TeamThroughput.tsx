import { useQuery } from '@tanstack/react-query'
import { TrendingUp } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { enumerateBuckets } from '@/lib/buckets'
import { cn, formatNumber } from '@/lib/utils'

interface ThroughputRow {
  user: string
  user_name: string
  bucket: string
  transitions: number
  completions: number
  send_backs: number
  avg_time_to_action_hours: number | null
}

interface ThroughputResponse {
  data: ThroughputRow[]
  meta: { from: string; to: string; bucket: string; unattributed_transitions: number }
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2 || points.every((p) => p === 0)) return null
  const w = 80
  const h = 20
  const max = Math.max(...points)
  const step = w / (points.length - 1)
  const path = points
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`
    )
    .join(' ')
  return (
    <svg width={w} height={h} className='text-nvr-cyan' aria-hidden='true'>
      <path d={path} fill='none' stroke='currentColor' strokeWidth='1.5' />
    </svg>
  )
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

export function TeamThroughputPage() {
  const { user } = useAuth()
  const [collection, setCollection] = useState('')
  const [from, setFrom] = useState(iso(new Date(Date.now() - 90 * 86_400_000)))
  const [to, setTo] = useState(iso(new Date()))
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('week')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<'transitions' | 'completions' | 'send_backs' | 'avg'>(
    'transitions'
  )

  const { data: collections = [] } = useQuery<
    Array<{ collection: string; display_name: string | null }>
  >({
    queryKey: ['throughput-collections'],
    queryFn: () => api.get('/reports/throughput/collections').then((r) => r.data.data),
    enabled: !!user?.is_admin
  })
  if (collections.length > 0 && !collection) setCollection(collections[0].collection)

  const { data: report, isLoading } = useQuery<ThroughputResponse>({
    queryKey: ['throughput', collection, from, to, bucket],
    queryFn: () =>
      api
        .get('/reports/throughput', { params: { collection, from, to, bucket } })
        .then((r) => r.data),
    enabled: !!user?.is_admin && !!collection
  })

  const buckets = useMemo(() => enumerateBuckets(from, to, bucket), [from, to, bucket])

  const perUser = useMemo(() => {
    const map = new Map<
      string,
      {
        user: string
        name: string
        transitions: number
        completions: number
        send_backs: number
        actionSum: number
        actionN: number
        series: Map<string, number>
      }
    >()
    for (const r of report?.data ?? []) {
      const u = map.get(r.user) ?? {
        user: r.user,
        name: r.user_name,
        transitions: 0,
        completions: 0,
        send_backs: 0,
        actionSum: 0,
        actionN: 0,
        series: new Map<string, number>()
      }
      u.transitions += r.transitions
      u.completions += r.completions
      u.send_backs += r.send_backs
      if (r.avg_time_to_action_hours != null) {
        u.actionSum += r.avg_time_to_action_hours * r.transitions
        u.actionN += r.transitions
      }
      u.series.set(r.bucket, (u.series.get(r.bucket) ?? 0) + r.transitions)
      map.set(r.user, u)
    }
    const rows = [...map.values()].map((u) => ({
      ...u,
      avg: u.actionN > 0 ? Math.round((u.actionSum / u.actionN) * 10) / 10 : null,
      points: buckets.map((b) => u.series.get(b) ?? 0)
    }))
    rows.sort((a, b) => {
      const va = sortKey === 'avg' ? (a.avg ?? -1) : a[sortKey]
      const vb = sortKey === 'avg' ? (b.avg ?? -1) : b[sortKey]
      return vb - va
    })
    return rows
  }, [report, buckets, sortKey])

  const totals = useMemo(
    () =>
      perUser.reduce(
        (acc, u) => ({
          transitions: acc.transitions + u.transitions,
          completions: acc.completions + u.completions,
          send_backs: acc.send_backs + u.send_backs
        }),
        { transitions: 0, completions: 0, send_backs: 0 }
      ),
    [perUser]
  )

  if (!user?.is_admin) {
    return (
      <div className='flex flex-1 items-center justify-center text-sm text-muted-foreground'>
        Team Throughput is available to administrators only.
      </div>
    )
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-border px-6 py-4'>
        <div className='flex items-center gap-2.5'>
          <TrendingUp className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Team Throughput</h1>
        </div>
      </header>
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='w-[224px] shrink-0 space-y-4 overflow-y-auto border-r border-border p-4'>
          <div className='space-y-1.5'>
            <Label>Collection</Label>
            <Select value={collection} onValueChange={setCollection}>
              <SelectTrigger>
                <SelectValue placeholder='Collection' />
              </SelectTrigger>
              <SelectContent>
                {collections.map((c) => (
                  <SelectItem key={c.collection} value={c.collection}>
                    {c.display_name ?? c.collection}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='tp-from'>From</Label>
            <Input
              id='tp-from'
              type='date'
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='tp-to'>To</Label>
            <Input id='tp-to' type='date' value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className='space-y-1.5'>
            <Label>Bucket</Label>
            <Select value={bucket} onValueChange={(v) => setBucket(v as typeof bucket)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='day'>Daily</SelectItem>
                <SelectItem value='week'>Weekly</SelectItem>
                <SelectItem value='month'>Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className='flex gap-1.5'>
            {[30, 90, 365].map((d) => (
              <button
                key={d}
                type='button'
                onClick={() => {
                  setFrom(iso(new Date(Date.now() - d * 86_400_000)))
                  setTo(iso(new Date()))
                }}
                className='rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted'
              >
                {d}d
              </button>
            ))}
          </div>
        </aside>
        <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
          <div className='mb-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
            {(
              [
                ['Transitions', totals.transitions],
                ['Completions', totals.completions],
                ['Send-backs', totals.send_backs]
              ] as const
            ).map(([label, n]) => (
              <div key={label} className='bg-white p-4 dark:bg-card'>
                <p className='text-[11px] uppercase tracking-wide text-muted-foreground'>{label}</p>
                <p className='text-xl font-semibold'>{formatNumber(n)}</p>
              </div>
            ))}
          </div>
          <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <table className='w-full text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-muted-foreground dark:border-border'>
                  <th className='px-3 py-2'>Person</th>
                  {(
                    [
                      ['transitions', 'Transitions'],
                      ['completions', 'Completions'],
                      ['send_backs', 'Send-backs'],
                      ['avg', 'Avg time to action']
                    ] as const
                  ).map(([key, label]) => (
                    <th key={key} className='px-3 py-2'>
                      <button
                        type='button'
                        onClick={() => setSortKey(key)}
                        className={cn(
                          'uppercase',
                          sortKey === key && 'text-nvr-navy dark:text-nvr-cyan'
                        )}
                      >
                        {label}
                      </button>
                    </th>
                  ))}
                  <th className='px-3 py-2'>Trend</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td colSpan={6} className='px-3 py-8 text-center text-muted-foreground'>
                      Loading…
                    </td>
                  </tr>
                )}
                {!isLoading && perUser.length === 0 && (
                  <tr>
                    <td colSpan={6} className='px-3 py-8 text-center text-muted-foreground'>
                      No transitions in this range.
                    </td>
                  </tr>
                )}
                {perUser.map((u) => (
                  <Fragment key={u.user}>
                    <tr
                      onClick={() => setExpanded(expanded === u.user ? null : u.user)}
                      className='cursor-pointer border-b border-slate-100 hover:bg-slate-50 dark:border-border/50 dark:hover:bg-muted/40'
                    >
                      <td className='px-3 py-2 font-medium'>{u.name}</td>
                      <td className='px-3 py-2'>{formatNumber(u.transitions)}</td>
                      <td className='px-3 py-2'>{formatNumber(u.completions)}</td>
                      <td className='px-3 py-2'>{formatNumber(u.send_backs)}</td>
                      <td className='px-3 py-2'>{u.avg != null ? `${u.avg}h` : '—'}</td>
                      <td className='px-3 py-2'>
                        <Sparkline points={u.points} />
                      </td>
                    </tr>
                    {expanded === u.user && (
                      <tr className='border-b border-slate-100 dark:border-border/50'>
                        <td colSpan={6} className='bg-slate-50 px-6 py-3 dark:bg-muted/30'>
                          <div className='flex flex-wrap gap-x-6 gap-y-1'>
                            {buckets.map((b) => (
                              <span key={b} className='text-[11px] text-muted-foreground'>
                                {b}:{' '}
                                <span className='font-medium text-foreground'>
                                  {u.series.get(b) ?? 0}
                                </span>
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {(report?.meta.unattributed_transitions ?? 0) > 0 && (
            <p className='mt-3 text-[11px] text-muted-foreground'>
              {formatNumber(report?.meta.unattributed_transitions ?? 0)} transitions have no
              attributable user (deleted legacy accounts) and are excluded above.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

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
        <StateFlowCard collection={collection || 'workflows'} />
        <SendbackThemesCard collection={collection || 'workflows'} />
      </div>
    </div>
  )
}

/** How records actually MOVE (#80): every from→to hop in the last 90 days as
 *  a flow diagram — ribbon width ∝ volume, send-backs amber. Hand-rolled SVG
 *  (states in sort order down the left, hops as arcs) — no chart dependency. */
function StateFlowCard({ collection }: { collection: string }) {
  const { data } = useQuery<{
    window_days: number
    states: Array<{ id: string; label: string; color: string | null; sort: number }>
    links: Array<{ from: string; to: string; count: number; back: boolean }>
  }>({
    queryKey: ['state-flow', collection],
    queryFn: () =>
      api
        .get('/reports/state-flow', { params: { collection, days: 90 } })
        .then((r) => r.data.data),
    enabled: !!collection,
    retry: false
  })
  if (!data || data.links.length === 0) return null

  const ROW_H = 44
  const LEFT = 210
  const W = 760
  const H = data.states.length * ROW_H + 16
  const yOf = new Map(data.states.map((st, i) => [st.id, 8 + i * ROW_H + ROW_H / 2]))
  const maxCount = Math.max(...data.links.map((l) => l.count))
  const stroke = (c: number) => 1.5 + (c / maxCount) * 10
  const inbound = new Map<string, number>()
  const outbound = new Map<string, number>()
  for (const l of data.links) {
    outbound.set(l.from, (outbound.get(l.from) ?? 0) + l.count)
    inbound.set(l.to, (inbound.get(l.to) ?? 0) + l.count)
  }

  return (
    <div className='mt-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
        State flow — last {data.window_days} days
      </p>
      <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        How records actually moved. Ribbon width is volume; amber arcs are send-backs.
      </p>
      <div className='mt-3 overflow-x-auto'>
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role='img'
          aria-label='State flow diagram'
          className='min-w-[560px]'
        >
          {data.links.map((l) => {
            const y1 = yOf.get(l.from)
            const y2 = yOf.get(l.to)
            if (y1 == null || y2 == null) return null
            const dx = 90 + Math.abs(y2 - y1) * 0.35 + (l.back ? 70 : 0)
            return (
              <path
                key={`${l.from}-${l.to}`}
                d={`M ${LEFT + 8} ${y1} C ${LEFT + 8 + dx} ${y1}, ${LEFT + 8 + dx} ${y2}, ${LEFT + 8} ${y2}`}
                fill='none'
                stroke={l.back ? '#f59e0b' : '#00ceff'}
                strokeOpacity={l.back ? 0.65 : 0.45}
                strokeWidth={stroke(l.count)}
                strokeLinecap='round'
              >
                <title>{`${l.count.toLocaleString()} record(s)${l.back ? ' (send-back)' : ''}`}</title>
              </path>
            )
          })}
          {data.states.map((st) => {
            const y = yOf.get(st.id) ?? 0
            const inN = inbound.get(st.id) ?? 0
            const outN = outbound.get(st.id) ?? 0
            return (
              <g key={st.id}>
                <circle cx={LEFT + 8} cy={y} r={5} fill={st.color ?? '#94a3b8'} />
                <text
                  x={LEFT - 2}
                  y={y + 3.5}
                  textAnchor='end'
                  className='fill-slate-700 text-[11px] font-medium dark:fill-slate-200'
                >
                  {st.label}
                </text>
                <text
                  x={LEFT + 20}
                  y={y + 3.5}
                  className='fill-slate-400 text-[9.5px] tabular-nums'
                >
                  {inN > 0 ? `in ${inN.toLocaleString()}` : ''}
                  {inN > 0 && outN > 0 ? ' · ' : ''}
                  {outN > 0 ? `out ${outN.toLocaleString()}` : ''}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

/** WHY records come back — send-back comments clustered into named themes by
 *  one AI call. Throughput says who reworks; this says what causes it. */
function SendbackThemesCard({ collection }: { collection: string }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, isError } = useQuery<{
    themes: Array<{ theme: string; count: number; examples?: string[] }>
    sample_size: number
    note?: string
  }>({
    queryKey: ['sendback-themes', collection],
    queryFn: () =>
      api
        .get<{ data: { themes: Array<{ theme: string; count: number; examples?: string[] }>; sample_size: number; note?: string } }>(
          `/reports/sendback-themes?collection=${collection}&days=90`
        )
        .then((r) => r.data.data),
    enabled: open,
    staleTime: 30 * 60_000,
    retry: false
  })
  return (
    <div className='mt-4 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center justify-between px-4 py-3 text-left'
      >
        <div>
          <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
            Why records come back
          </p>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Send-back comments from the last 90 days, clustered into themes — the rework causes
            behind the counts above.
          </p>
        </div>
        <span className='text-[11px] text-slate-400'>{open ? 'Hide' : 'Analyze'}</span>
      </button>
      {open && (
        <div className='border-t border-slate-100 px-4 py-3 dark:border-border'>
          {isLoading && <p className='text-[12px] text-slate-400'>Clustering comments…</p>}
          {isError && (
            <p className='text-[12px] text-amber-600 dark:text-amber-400'>
              Analysis unavailable — AI may not be configured.
            </p>
          )}
          {data?.note && <p className='text-[12px] text-slate-400'>{data.note}</p>}
          {data && data.themes.length > 0 && (
            <div className='space-y-2.5'>
              <p className='text-[11px] text-slate-400'>
                {data.sample_size} send-back comment{data.sample_size === 1 ? '' : 's'} analyzed
              </p>
              {data.themes
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((t) => (
                  <div key={t.theme}>
                    <div className='flex items-baseline gap-2'>
                      <span className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                        {t.theme}
                      </span>
                      <span className='text-[11.5px] tabular-nums text-slate-400'>
                        {t.count} comment{t.count === 1 ? '' : 's'}
                      </span>
                    </div>
                    {(t.examples ?? []).slice(0, 2).map((ex, i) => (
                      <p key={i} className='ml-3 text-[11.5px] italic text-slate-500 dark:text-muted-foreground'>
                        &ldquo;{ex}&rdquo;
                      </p>
                    ))}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

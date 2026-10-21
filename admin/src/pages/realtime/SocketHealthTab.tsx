import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Socket health (#2460 slow consumers, #2488 write buffers, #2779 handler timings, #2462 room
 * gaps). Every replica publishes its figures to Redis every 10 s; this tab shows them merged.
 */

export interface SocketHealth {
  replicas: number
  instances: string[]
  limits: { soft: number; hard: number }
  sockets: number
  waiting_bytes: number
  soft_now: number
  counters: {
    soft_entered: number
    hard_disconnects: number
    stale_sent: number
    suppressed: number
  }
  top: Array<{
    instance: string
    id: string
    user: string | null
    app: string | null
    transport: string | null
    waiting: number
    peak: number
    mode: 'ok' | 'soft'
    rooms: number
  }>
  rooms: Array<{ room: string; size: number }>
  growth: Array<{ t: number; total: number; max: number }>
  disconnects: Array<{ at: string; user: string | null; app: string | null; waiting: number }>
  handlers: Array<{
    handler: string
    count: number
    avg_ms: number
    p50_ms: number
    p95_ms: number
    max_ms: number
    sync_max_ms: number
  }>
  slowest: Array<{ handler: string; ms: number; sync_ms: number; at: string; instance?: string }>
  gaps: {
    reports: number
    missed: number
    replayed: number
    full: number
    by_kind: Array<{ kind: string; reports: number; missed: number }>
  }
  live_modes?: { batches: number; writes_batched: number; suppressed: number }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** Amber past 100 ms, red past a second: a handler that slow holds up everyone on the server. */
function msTone(ms: number): string | undefined {
  if (ms >= 1000) return 'text-red-600 dark:text-red-400'
  if (ms >= 100) return 'text-amber-700 dark:text-amber-300'
  return undefined
}

const TH = 'px-3 py-2 text-left text-[11px] font-medium text-slate-500 dark:text-muted-foreground'

export function SocketHealthTab() {
  const { data, isLoading, isError } = useQuery<SocketHealth>({
    queryKey: ['realtime-socket-health'],
    queryFn: () => api.get('/realtime/health').then((r) => r.data.data),
    refetchInterval: 10_000
  })
  if (isLoading)
    return (
      <div className='space-y-4' data-socket-health='loading'>
        <Skeleton className='h-16 w-full' />
        <Skeleton className='h-32 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
    )
  if (isError || !data)
    return (
      <p className='text-[13px] text-slate-500 dark:text-muted-foreground'>
        Socket health could not be loaded. It refreshes every 10 seconds.
      </p>
    )
  const lm = data.live_modes
  return (
    <div className='space-y-6' data-socket-health='ready'>
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        {data.replicas === 1
          ? 'One API server reporting.'
          : `${data.replicas} API servers reporting, merged.`}{' '}
        A client is held back once more than {formatBytes(data.limits.soft)} is waiting to reach it,
        and disconnected past {formatBytes(data.limits.hard)} (
        <span className='font-mono text-[11.5px]'>SOCKET_BUFFER_SOFT_BYTES</span> /{' '}
        <span className='font-mono text-[11.5px]'>SOCKET_BUFFER_HARD_BYTES</span>).
      </p>

      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6 dark:border-border dark:bg-border'>
        <Cell label='Sockets' value={data.sockets.toLocaleString()} />
        <Cell
          label='Waiting to send'
          value={formatBytes(data.waiting_bytes)}
          tip='Bytes queued for all clients right now: the engine.io write buffer plus what the websocket has not written yet'
        />
        <Cell
          label='Held back now'
          value={data.soft_now.toLocaleString()}
          tone={data.soft_now > 0 ? 'text-amber-700 dark:text-amber-300' : undefined}
          tip='Clients over the soft limit: they get one "refetch these rooms" notice instead of every event until they catch up'
        />
        <Cell
          label='Times held back'
          value={data.counters.soft_entered.toLocaleString()}
          tip={`${data.counters.suppressed.toLocaleString()} events held, ${data.counters.stale_sent.toLocaleString()} refetch notices sent, since each server started`}
        />
        <Cell
          label='Disconnected'
          value={data.counters.hard_disconnects.toLocaleString()}
          tone={data.counters.hard_disconnects > 0 ? 'text-red-600 dark:text-red-400' : undefined}
          tip='Clients closed at the hard limit; their tab reloads its data when it reconnects'
        />
        <Cell
          label='Missed events caught up'
          value={data.gaps.reports.toLocaleString()}
          tip={`${data.gaps.missed.toLocaleString()} events missed in a room while connected; ${data.gaps.replayed} replayed, ${data.gaps.full} reloaded`}
        />
      </div>

      <Section
        title='Waiting to send, last 10 minutes'
        aside={
          data.growth.length > 0
            ? `peak ${formatBytes(Math.max(...data.growth.map((p) => p.total)))}`
            : undefined
        }
      >
        <GrowthChart points={data.growth} soft={data.limits.soft} />
      </Section>

      <div className='grid gap-6 xl:grid-cols-2'>
        <Section title='Clients with the most waiting'>
          <Table
            head={['Client', 'Transport', 'Waiting', 'Peak', 'Rooms', '']}
            empty='No clients connected.'
            rows={data.top.map((s) => [
              <span key='u' className='block max-w-[220px] truncate'>
                {s.user ?? 'Not signed in'}
                <span className='ml-1.5 text-slate-500 dark:text-muted-foreground'>
                  {s.app ?? ''}
                </span>
              </span>,
              <span key='t' className='font-mono text-[11px]'>
                {s.transport ?? '—'}
              </span>,
              formatBytes(s.waiting),
              formatBytes(s.peak),
              s.rooms,
              s.mode === 'soft' ? (
                <span
                  key='m'
                  className='rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
                >
                  Held back
                </span>
              ) : null
            ])}
            numeric={[2, 3, 4]}
          />
        </Section>
        <Section title='Biggest rooms'>
          {data.rooms.length === 0 ? (
            <Empty>No rooms joined.</Empty>
          ) : (
            <div className='flex flex-wrap gap-1.5'>
              {data.rooms.map((r) => (
                <span
                  key={r.room}
                  className='rounded-full border border-slate-200 bg-white px-2.5 py-0.5 font-mono text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
                >
                  {r.room} · {r.size}
                </span>
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section
        title='Event handlers, last 10 minutes'
        aside='Total time per call; "event loop" is the longest stretch one call kept the server busy'
      >
        <Table
          head={['Event', 'Calls', 'p50', 'p95', 'Slowest', 'Event loop']}
          empty='No events handled yet.'
          rows={data.handlers.map((h) => [
            <span key='h' className='font-mono text-[11px]'>
              {h.handler}
            </span>,
            h.count.toLocaleString(),
            formatMs(h.p50_ms),
            <span key='p95' className={msTone(h.p95_ms)}>
              {formatMs(h.p95_ms)}
            </span>,
            <span key='max' className={msTone(h.max_ms)}>
              {formatMs(h.max_ms)}
            </span>,
            <span key='sync' className={msTone(h.sync_max_ms)}>
              {formatMs(h.sync_max_ms)}
            </span>
          ])}
          numeric={[1, 2, 3, 4, 5]}
        />
      </Section>

      <div className='grid gap-6 xl:grid-cols-2'>
        <Section title='Slowest recent calls'>
          <Table
            head={['When', 'Event', 'Total', 'Event loop']}
            empty='No calls yet.'
            rows={data.slowest.map((c) => [
              new Date(c.at).toLocaleTimeString(),
              <span key='h' className='font-mono text-[11px]'>
                {c.handler}
              </span>,
              <span key='ms' className={msTone(c.ms)}>
                {formatMs(c.ms)}
              </span>,
              <span key='s' className={msTone(c.sync_ms)}>
                {formatMs(c.sync_ms)}
              </span>
            ])}
            numeric={[2, 3]}
          />
        </Section>
        <Section
          title='Missed events by room'
          aside='A connected client saw a room skip an event and caught that room up alone'
        >
          <Table
            head={['Room', 'Times', 'Events missed']}
            empty='No missed events reported.'
            rows={data.gaps.by_kind.map((g) => [
              <span key='k' className='font-mono text-[11px]'>
                {g.kind}
              </span>,
              g.reports.toLocaleString(),
              g.missed.toLocaleString()
            ])}
            numeric={[1, 2]}
          />
        </Section>
      </div>

      <div className='grid gap-6 xl:grid-cols-2'>
        <Section title='Recently disconnected for falling behind'>
          <Table
            head={['When', 'Client', 'Waiting']}
            empty='No client has been disconnected.'
            rows={data.disconnects.map((d) => [
              new Date(d.at).toLocaleString(),
              `${d.user ?? 'Not signed in'}${d.app ? ` · ${d.app}` : ''}`,
              formatBytes(d.waiting)
            ])}
            numeric={[2]}
          />
        </Section>
        {lm && (
          <Section
            title='Collections with live updates batched or off'
            aside='Set per collection in Table Editor → Settings → Live updates'
          >
            <p className='text-[12px] text-slate-600 dark:text-slate-300'>
              This server sent {lm.batches.toLocaleString()} batched{' '}
              {lm.batches === 1 ? 'message' : 'messages'} for {lm.writes_batched.toLocaleString()}{' '}
              changes, and skipped {lm.suppressed.toLocaleString()} changes on collections switched
              off.
            </p>
          </Section>
        )}
      </div>
    </div>
  )
}

function Cell({
  label,
  value,
  tone,
  tip
}: {
  label: string
  value: ReactNode
  tone?: string
  tip?: string
}) {
  return (
    <div data-tip={tip} className='bg-white px-3 py-2 dark:bg-card'>
      <div className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{label}</div>
      <div className={cn('text-[15px] font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  )
}

function Section({
  title,
  aside,
  children
}: {
  title: string
  aside?: string
  children: ReactNode
}) {
  return (
    <section>
      <div className='mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5'>
        <h2 className='text-[13px] font-medium text-slate-800 dark:text-foreground'>{title}</h2>
        {aside && (
          <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{aside}</span>
        )}
      </div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>{children}</p>
}

function Table({
  head,
  rows,
  empty,
  numeric = []
}: {
  head: string[]
  rows: ReactNode[][]
  empty: string
  numeric?: number[]
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>
  return (
    <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
      <table className='w-full text-[12px] tabular-nums'>
        <thead>
          <tr className='border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40'>
            {head.map((h, i) => (
              <th key={h || i} className={cn(TH, numeric.includes(i) && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
          {rows.map((r, ri) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional snapshots
            <tr key={ri}>
              {r.map((c, ci) => (
                <td
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  key={ci}
                  className={cn('px-3 py-1.5', numeric.includes(ci) && 'text-right')}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Total waiting bytes per 10 s sample, with the soft limit drawn when the line gets near it. */
function GrowthChart({ points, soft }: { points: SocketHealth['growth']; soft: number }) {
  if (points.length < 2)
    return <Empty>Collecting samples — the first points appear within 20 seconds.</Empty>
  const W = 600
  const H = 80
  const peak = Math.max(...points.map((p) => p.total), 1)
  const top = peak > soft * 0.5 ? Math.max(peak, soft) * 1.1 : peak * 1.15
  const t0 = points[0].t
  const span = Math.max(1, points[points.length - 1].t - t0)
  const x = (t: number) => ((t - t0) / span) * W
  const y = (v: number) => H - (v / top) * H
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.total).toFixed(1)}`)
  const area = `${line.join(' ')} L${W},${H} L0,${H} Z`
  const last = points[points.length - 1]
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio='none'
        className='h-20 w-full text-nvr-cyan'
        role='img'
        aria-label={`Waiting bytes over the last ${Math.round(span / 60_000)} minutes, now ${formatBytes(last.total)}`}
      >
        <path d={area} className='fill-current opacity-15' />
        <path
          d={line.join(' ')}
          fill='none'
          stroke='currentColor'
          strokeWidth={1.5}
          vectorEffect='non-scaling-stroke'
        />
        {soft <= top && (
          <line
            x1={0}
            x2={W}
            y1={y(soft)}
            y2={y(soft)}
            className='stroke-amber-500'
            strokeDasharray='4 4'
            strokeWidth={1}
            vectorEffect='non-scaling-stroke'
          />
        )}
      </svg>
      <div className='mt-1 flex justify-between text-[11px] text-slate-500 dark:text-muted-foreground'>
        <span>{new Date(t0).toLocaleTimeString()}</span>
        <span>
          now {formatBytes(last.total)} · largest client {formatBytes(last.max)}
        </span>
      </div>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { Pencil, Radio, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { adminRealtime, joinWatchRoom } from '@/lib/socket'
import { cn } from '@/lib/utils'

/**
 * Realtime console (#270 diagnostics, #273 now-editing, #275 concurrency
 * history, #276 live traffic, #285 force refresh). Everything here is
 * per-API-node observability — the stats route says so in its payload.
 */

type Tab = 'sockets' | 'traffic' | 'editing' | 'concurrency'

interface SocketRow {
  id: string
  user: string | null
  app: string | null
  connected_seconds: number
  rtt_ms: number | null
  reconnects: number
  room_count: number
  rooms: string[]
}

export default function Realtime() {
  const [tab, setTab] = useState<Tab>('sockets')
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between gap-4'>
          <div className='flex items-center gap-2.5'>
            <Radio className='h-5 w-5 text-muted-foreground' />
            <div>
              <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
                Realtime
              </h1>
              <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                Who's connected, what's flowing, who's editing what — live from this API node.
              </p>
            </div>
          </div>
          <ForceRefreshControl />
        </div>
        <div className='mt-3 flex gap-1'>
          {(
            [
              ['sockets', 'Sockets & rooms'],
              ['traffic', 'Live traffic'],
              ['editing', 'Now editing'],
              ['concurrency', 'Concurrency']
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type='button'
              onClick={() => setTab(key)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12.5px] font-medium',
                tab === key
                  ? 'bg-[#00ceff]/10 text-[#0e7490] dark:text-[#67e8f9]'
                  : 'text-slate-500 hover:bg-muted dark:text-muted-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className='flex-1 overflow-y-auto p-6'>
        {tab === 'sockets' && <SocketsTab />}
        {tab === 'traffic' && <TrafficTab />}
        {tab === 'editing' && <EditingTab />}
        {tab === 'concurrency' && <ConcurrencyTab />}
      </div>
    </div>
  )
}

// ─── Force refresh (#285) ────────────────────────────────────────────────────

function ForceRefreshControl() {
  const [open, setOpen] = useState(false)
  const [seconds, setSeconds] = useState('30')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  return (
    <div className='relative'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[12.5px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
      >
        <RefreshCw className='h-3.5 w-3.5' />
        Force client refresh…
      </button>
      {open && (
        <div className='absolute right-0 top-full z-20 mt-1 w-[300px] rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-border dark:bg-card'>
          <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
            Every connected client shows a countdown, then reloads. Use for a deploy that must land
            now.
          </p>
          <label className='mt-2 flex items-center gap-2 text-[12px]'>
            Countdown
            <input
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
              inputMode='numeric'
              className='h-7 w-16 rounded-md border border-slate-200 bg-background px-2 text-right text-[12px] dark:border-border'
            />
            seconds
          </label>
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder='Optional message shown in the banner'
            className='mt-2 h-7 w-full rounded-md border border-slate-200 bg-background px-2 text-[12px] dark:border-border'
          />
          <div className='mt-2 flex justify-end gap-2'>
            <button
              type='button'
              onClick={() => setOpen(false)}
              className='rounded-md px-2.5 py-1 text-[12px] text-slate-500 hover:bg-muted'
            >
              Cancel
            </button>
            <button
              type='button'
              disabled={sending}
              onClick={async () => {
                setSending(true)
                try {
                  await api.post('/realtime/force-refresh', {
                    seconds: Number(seconds) || 30,
                    message
                  })
                  toast.success('Refresh pushed to every connected client')
                  setOpen(false)
                } catch {
                  toast.error('Failed to send the refresh')
                } finally {
                  setSending(false)
                }
              }}
              className='rounded-md bg-amber-500 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50'
            >
              {sending ? 'Sending…' : 'Push refresh'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sockets & rooms (#270) ──────────────────────────────────────────────────

function SocketsTab() {
  const { data, isLoading } = useQuery<{
    node_scope: string
    journal_seq: number
    socket_count: number
    sockets: SocketRow[]
    rooms: Array<{ room: string; size: number }>
  }>({
    queryKey: ['realtime-stats'],
    queryFn: () => api.get('/realtime/stats').then((r) => r.data.data),
    refetchInterval: 10_000
  })
  if (isLoading) return <p className='text-[13px] text-slate-400'>Loading…</p>
  if (!data) return null
  return (
    <div className='space-y-4'>
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        {data.socket_count} socket(s) on this node · journal seq {data.journal_seq} ·{' '}
        {data.node_scope}
      </p>
      <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
        <table className='w-full text-[12px] tabular-nums'>
          <thead>
            <tr className='border-b border-slate-200 bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border dark:bg-muted/40'>
              <th className='px-3 py-2'>User</th>
              <th className='px-3 py-2'>App</th>
              <th className='px-3 py-2 text-right'>Connected</th>
              <th className='px-3 py-2 text-right'>RTT</th>
              <th className='px-3 py-2 text-right'>Reconnects</th>
              <th className='px-3 py-2'>Rooms</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
            {data.sockets.map((s) => (
              <tr key={s.id}>
                <td className='px-3 py-1.5 font-mono text-[11px]'>{s.user ?? '(unauth)'}</td>
                <td className='px-3 py-1.5'>{s.app ?? '—'}</td>
                <td className='px-3 py-1.5 text-right'>{formatDuration(s.connected_seconds)}</td>
                <td className='px-3 py-1.5 text-right'>
                  {s.rtt_ms != null ? `${s.rtt_ms}ms` : '—'}
                </td>
                <td className='px-3 py-1.5 text-right'>{s.reconnects}</td>
                <td className='max-w-[420px] truncate px-3 py-1.5 text-[11px] text-slate-500'>
                  {s.room_count} · {s.rooms.join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h2 className='mb-2 text-[13px] font-medium'>Busiest rooms</h2>
        <div className='flex flex-wrap gap-1.5'>
          {data.rooms.slice(0, 40).map((r) => (
            <span
              key={r.room}
              className='rounded-full border border-slate-200 bg-white px-2.5 py-0.5 font-mono text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
            >
              {r.room} · {r.size}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Live traffic (#276) ─────────────────────────────────────────────────────

interface TrafficRow {
  method: string
  path: string
  status: number
  latency_ms: number
  user: string | null
  at: string
}

function TrafficTab() {
  const [rows, setRows] = useState<TrafficRow[]>([])
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  pausedRef.current = paused
  useEffect(() => {
    const leave = joinWatchRoom('traffic')
    const off = adminRealtime.on('traffic:request', (p: TrafficRow) => {
      if (pausedRef.current) return
      setRows((prev) => [p, ...prev].slice(0, 200))
    })
    return () => {
      off()
      leave()
    }
  }, [])
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between'>
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          API requests as they happen (only streamed while someone watches — zero cost otherwise).
        </p>
        <button
          type='button'
          onClick={() => setPaused((p) => !p)}
          className='rounded-md border border-slate-200 px-2.5 py-1 text-[12px] hover:bg-muted dark:border-border'
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className='text-[13px] text-slate-400'>Waiting for requests…</p>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
          <table className='w-full text-[12px] tabular-nums'>
            <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
              {rows.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className='px-3 py-1 font-mono text-[11px] text-slate-400'>
                    {new Date(r.at).toLocaleTimeString()}
                  </td>
                  <td className='px-3 py-1 font-mono text-[11px] font-semibold'>{r.method}</td>
                  <td className='max-w-[440px] truncate px-3 py-1 font-mono text-[11px]'>
                    {r.path}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-1 text-right font-semibold',
                      r.status >= 500
                        ? 'text-red-600 dark:text-red-400'
                        : r.status >= 400
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                    )}
                  >
                    {r.status}
                  </td>
                  <td className='px-3 py-1 text-right text-slate-500'>{r.latency_ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Now editing (#273) ──────────────────────────────────────────────────────

function EditingTab() {
  const { data, isLoading } = useQuery<{
    editing: Array<{ collection: string; item: string; editor: string; since: string }>
    viewing: Array<{ collection: string; item: string; viewers: string[] }>
  }>({
    queryKey: ['realtime-editing'],
    queryFn: () => api.get('/realtime/now-editing').then((r) => r.data.data),
    refetchInterval: 15_000
  })
  if (isLoading) return <p className='text-[13px] text-slate-400'>Loading…</p>
  const editing = data?.editing ?? []
  const viewing = data?.viewing ?? []
  return (
    <div className='space-y-6'>
      <section>
        <h2 className='mb-2 flex items-center gap-1.5 text-[13px] font-medium'>
          <Pencil className='h-3.5 w-3.5 text-slate-400' /> Holding edit locks
        </h2>
        {editing.length === 0 ? (
          <p className='text-[13px] text-slate-400'>Nobody holds an edit lock right now.</p>
        ) : (
          <ul className='space-y-1'>
            {editing.map((e) => (
              <li key={`${e.collection}:${e.item}`} className='text-[13px]'>
                <span className='font-medium'>{e.editor}</span>{' '}
                <span className='text-slate-500 dark:text-muted-foreground'>is editing</span>{' '}
                <a
                  href={`/collections/${e.collection}/${e.item}`}
                  className='font-mono text-[12px] text-nvr-navy underline decoration-dotted dark:text-[#67e8f9]'
                >
                  {e.collection}/{e.item}
                </a>{' '}
                <span className='text-[11px] text-slate-400'>
                  since {new Date(e.since).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className='mb-2 text-[13px] font-medium'>Viewing records (this node)</h2>
        {viewing.length === 0 ? (
          <p className='text-[13px] text-slate-400'>No record pages open right now.</p>
        ) : (
          <ul className='space-y-1'>
            {viewing.map((v) => (
              <li key={`${v.collection}:${v.item}`} className='text-[13px]'>
                <span className='font-mono text-[12px]'>
                  {v.collection}/{v.item}
                </span>{' '}
                <span className='text-slate-500 dark:text-muted-foreground'>
                  — {v.viewers.join(', ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ─── Concurrency history (#275) ──────────────────────────────────────────────

function ConcurrencyTab() {
  const [days, setDays] = useState(14)
  const { data = [] } = useQuery<
    Array<{ sampled_at: string; instance: string | null; sockets: number; users: number }>
  >({
    queryKey: ['realtime-concurrency', days],
    queryFn: () => api.get('/realtime/concurrency', { params: { days } }).then((r) => r.data.data),
    refetchInterval: 60_000
  })
  const series = useMemo(() => {
    // Sum instances per 5-min bucket so multi-replica deployments chart truth.
    const byTs = new Map<string, { sockets: number; users: number }>()
    for (const row of data) {
      const key = row.sampled_at
      const cur = byTs.get(key) ?? { sockets: 0, users: 0 }
      cur.sockets += row.sockets
      cur.users += row.users
      byTs.set(key, cur)
    }
    return [...byTs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ts, v]) => ({ ts, ...v }))
  }, [data])
  const max = Math.max(1, ...series.map((s) => s.sockets))
  const W = 800
  const H = 160
  const pts = (key: 'sockets' | 'users') =>
    series
      .map(
        (s, i) =>
          `${((i / Math.max(1, series.length - 1)) * W).toFixed(1)},${(
            H - (s[key] / max) * (H - 10)
          ).toFixed(1)}`
      )
      .join(' ')
  return (
    <div className='space-y-3'>
      <div className='flex items-center gap-2'>
        {[7, 14, 30, 90].map((d) => (
          <button
            key={d}
            type='button'
            onClick={() => setDays(d)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px]',
              days === d
                ? 'bg-[#00ceff]/10 font-medium text-[#0e7490] dark:text-[#67e8f9]'
                : 'text-slate-500 hover:bg-muted'
            )}
          >
            {d}d
          </button>
        ))}
        <span className='ml-2 text-[11px] text-slate-400'>
          Sampled every 5 minutes · sockets (cyan) and distinct users (navy)
        </span>
      </div>
      {series.length < 2 ? (
        <p className='text-[13px] text-slate-400'>
          Not enough samples yet — the collector runs every 5 minutes.
        </p>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className='h-[180px] w-full min-w-[600px]'
            role='img'
            aria-label='Concurrent sockets and users over time'
          >
            <title>Concurrent sockets and users over time</title>
            <polyline points={pts('sockets')} fill='none' stroke='#00ceff' strokeWidth='1.5' />
            <polyline
              points={pts('users')}
              fill='none'
              stroke='#172940'
              strokeWidth='1.5'
              className='dark:[stroke:#94a3b8]'
            />
          </svg>
          <p className='mt-1 text-[11px] text-slate-400'>
            Peak {max} socket(s) in this window · {series.length} samples
          </p>
        </div>
      )}
    </div>
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

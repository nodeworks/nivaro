import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { cn, formatNumber } from '@/lib/utils'

/**
 * Wallboard / TV mode — full-screen dark queue dashboard for ops-floor
 * displays. No chrome, giant numbers, auto-rotates across queues, refreshes
 * live. Deliberately committed to a single dark look: it renders on TVs,
 * not in the themed admin.
 */

interface QueueRow {
  id: string
  name: string
}

interface QueueStats {
  total: number
  unowned: number
  sla_warning: number
  sla_breached: number
  at_risk: number
  by_state: Record<string, number>
}

const ROTATE_MS = 20_000
const REFRESH_MS = 60_000

function Tile({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone: 'neutral' | 'warn' | 'bad' | 'accent'
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border p-8',
        tone === 'bad' && value > 0
          ? 'border-red-500/40 bg-red-500/10'
          : tone === 'warn' && value > 0
            ? 'border-amber-500/40 bg-amber-500/10'
            : tone === 'accent'
              ? 'border-[#00ceff40] bg-[#00ceff10]'
              : 'border-white/10 bg-white/[0.04]'
      )}
    >
      <span
        className={cn(
          'text-7xl font-bold tabular-nums tracking-tight',
          tone === 'bad' && value > 0
            ? 'text-red-400'
            : tone === 'warn' && value > 0
              ? 'text-amber-400'
              : tone === 'accent'
                ? 'text-[#00ceff]'
                : 'text-white'
        )}
      >
        {formatNumber(value)}
      </span>
      <span className='mt-2 text-sm font-medium uppercase tracking-[0.2em] text-white/50'>
        {label}
      </span>
    </div>
  )
}

export function WallboardPage() {
  const [index, setIndex] = useState(0)
  const [clock, setClock] = useState(() => new Date())

  const { data: queues = [] } = useQuery({
    queryKey: ['wallboard-queues'],
    queryFn: () => api.get<{ data: QueueRow[] }>('/queues').then((r) => r.data.data),
    refetchInterval: 5 * 60_000
  })

  const queue = queues.length > 0 ? queues[index % queues.length] : null

  const { data: stats } = useQuery({
    queryKey: ['wallboard-stats', queue?.id],
    queryFn: () =>
      api
        .get<{ stats: QueueStats }>(`/queues/${queue?.id}/items`, {
          params: { scope: 'all', page: 1, limit: 1 }
        })
        .then((r) => r.data.stats),
    enabled: !!queue,
    refetchInterval: REFRESH_MS
  })

  useEffect(() => {
    if (queues.length < 2) return
    const t = setInterval(() => setIndex((i) => i + 1), ROTATE_MS)
    return () => clearInterval(t)
  }, [queues.length])

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const states = Object.entries(stats?.by_state ?? {}).sort((a, b) => b[1] - a[1])
  const maxState = states.length > 0 ? states[0][1] : 1

  return (
    <div className='fixed inset-0 flex flex-col bg-[#0a0f1a] p-10 text-white'>
      {/* Header */}
      <div className='flex items-baseline justify-between'>
        <div className='flex items-baseline gap-4'>
          <h1 className='text-4xl font-bold tracking-tight'>{queue?.name ?? 'Queues'}</h1>
          {queues.length > 1 && (
            <div className='flex gap-1.5'>
              {queues.map((q, i) => (
                <span
                  key={q.id}
                  className={cn(
                    'h-1.5 w-6 rounded-full',
                    i === index % queues.length ? 'bg-[#00ceff]' : 'bg-white/15'
                  )}
                />
              ))}
            </div>
          )}
        </div>
        <p className='text-3xl font-light tabular-nums text-white/60'>
          {clock.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>

      {/* Stat tiles */}
      <div className='mt-8 grid grid-cols-5 gap-5'>
        <Tile label='Total' value={stats?.total ?? 0} tone='accent' />
        <Tile label='Unowned' value={stats?.unowned ?? 0} tone='neutral' />
        <Tile label='SLA warning' value={stats?.sla_warning ?? 0} tone='warn' />
        <Tile label='SLA breached' value={stats?.sla_breached ?? 0} tone='bad' />
        <Tile label='At risk' value={stats?.at_risk ?? 0} tone='warn' />
      </div>

      {/* State distribution */}
      <div className='mt-10 flex-1 overflow-hidden'>
        <p className='mb-4 text-sm font-medium uppercase tracking-[0.2em] text-white/40'>
          By state
        </p>
        <div className='grid grid-cols-2 gap-x-12 gap-y-4'>
          {states.slice(0, 12).map(([state, count]) => (
            <div key={state} className='flex items-center gap-4'>
              <span className='w-64 truncate text-lg text-white/80'>{state}</span>
              <div className='h-4 flex-1 overflow-hidden rounded-full bg-white/[0.06]'>
                <div
                  className='h-full rounded-full bg-[#00ceff] transition-all duration-700'
                  style={{ width: `${Math.max(2, (count / maxState) * 100)}%` }}
                />
              </div>
              <span className='w-16 text-right text-xl font-semibold tabular-nums'>
                {formatNumber(count)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className='text-center text-xs uppercase tracking-[0.3em] text-white/25'>
        Nivaro · live · refreshes every minute
      </p>
    </div>
  )
}

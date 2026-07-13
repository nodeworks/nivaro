import { useQuery } from '@tanstack/react-query'
import { Activity, Radio } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Mission control — live activity pulse. Streams every activity entry as it
 * happens (admin-only socket room) over a seed of the most recent entries,
 * with a per-minute pulse sparkline accumulated client-side.
 */

interface PulseEvent {
  id: number
  action: string
  collection: string | null
  item: string | null
  comment: string | null
  timestamp: string
  live?: boolean
}

const ACTION_TONE: Array<[RegExp, string]> = [
  [/delete|reject|breach|error|fail/i, '#ef4444'],
  [/create|approve|complete/i, '#10b981'],
  [/update|transition|change/i, '#00ceff'],
  [/login|auth/i, '#8b5cf6']
]

function toneFor(action: string): string {
  for (const [re, color] of ACTION_TONE) if (re.test(action)) return color
  return '#94a3b8'
}

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'
const MAX_EVENTS = 150
const BUCKETS = 30

export function PulsePage() {
  const { user } = useAuth()
  const [events, setEvents] = useState<PulseEvent[]>([])
  const [connected, setConnected] = useState(false)
  const countsRef = useRef<Map<number, number>>(new Map()) // minute-epoch → count
  const [, forceTick] = useState(0)

  // Seed with recent history
  const { data: seed } = useQuery({
    queryKey: ['pulse-seed'],
    queryFn: () =>
      api
        .get<{ data: PulseEvent[] }>('/activity', { params: { limit: 40 } })
        .then((r) => r.data.data),
    staleTime: Number.POSITIVE_INFINITY
  })
  useEffect(() => {
    if (seed && events.length === 0) setEvents(seed)
    // biome-ignore lint/correctness/useExhaustiveDependencies: seed once
  }, [seed])

  useEffect(() => {
    const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })

    socket.on('connect', async () => {
      let token = user?.static_token ?? null
      if (!token) {
        try {
          const r = await api.get<{ data?: { token?: string }; token?: string }>('/auth/ws-token')
          token = r.data.data?.token ?? r.data.token ?? null
        } catch {
          token = null
        }
      }
      if (token) socket.emit('auth', { token })
    })
    socket.on('auth:ok', () => {
      socket.emit('pulse:join')
      setConnected(true)
    })
    socket.on('activity:pulse', (e: PulseEvent) => {
      setEvents((prev) => [{ ...e, live: true }, ...prev].slice(0, MAX_EVENTS))
      const minute = Math.floor(Date.now() / 60_000)
      countsRef.current.set(minute, (countsRef.current.get(minute) ?? 0) + 1)
    })
    socket.on('disconnect', () => setConnected(false))

    const tick = setInterval(() => forceTick((n) => n + 1), 10_000)
    return () => {
      socket.emit('pulse:leave')
      socket.disconnect()
      clearInterval(tick)
    }
  }, [user?.static_token])

  const spark = useMemo(() => {
    const now = Math.floor(Date.now() / 60_000)
    return Array.from(
      { length: BUCKETS },
      (_, i) => countsRef.current.get(now - (BUCKETS - 1 - i)) ?? 0
    )
  }, [events.length])
  const sparkMax = Math.max(1, ...spark)

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <Radio className={cn('h-4 w-4', connected ? 'text-green-500' : 'text-slate-300')} />
          <div>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Pulse
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              {connected ? 'Live — every action as it happens' : 'Connecting…'}
            </p>
          </div>
          {/* per-minute sparkline */}
          <div
            className='ml-auto flex h-10 items-end gap-[3px]'
            title='Events per minute, last 30 min'
          >
            {spark.map((v, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed buckets
                key={i}
                className='w-1.5 rounded-sm bg-nvr-cyan transition-all duration-500'
                style={{
                  height: `${Math.max(8, (v / sparkMax) * 100)}%`,
                  opacity: v === 0 ? 0.15 : 0.9
                }}
              />
            ))}
          </div>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='mx-auto max-w-3xl space-y-1 p-6'>
          {events.length === 0 && (
            <div className='pt-16 text-center text-slate-400'>
              <Activity className='mx-auto h-8 w-8 opacity-40' />
              <p className='mt-3 text-[13px]'>Waiting for activity…</p>
            </div>
          )}
          {events.map((e) => (
            <div
              key={`${e.id}-${e.timestamp}`}
              className={cn(
                'flex items-center gap-3 rounded-lg border border-transparent bg-white px-3 py-2 dark:bg-card',
                e.live && 'animate-page-enter border-[#00ceff30]'
              )}
            >
              <span
                className='h-2.5 w-2.5 shrink-0 rounded-full'
                style={{
                  background: toneFor(e.action),
                  boxShadow: e.live ? `0 0 8px ${toneFor(e.action)}` : undefined
                }}
              />
              <span className='shrink-0 font-mono text-[11.5px] font-medium text-slate-700 dark:text-slate-300'>
                {e.action}
              </span>
              {e.collection && (
                <span className='truncate text-[12px] text-slate-500'>
                  {e.collection}
                  {e.item ? `/${e.item}` : ''}
                </span>
              )}
              {e.comment && (
                <span className='hidden truncate text-[11.5px] text-slate-400 md:inline'>
                  {e.comment}
                </span>
              )}
              <span className='ml-auto shrink-0 text-[10.5px] text-slate-400'>
                {formatRelative(e.timestamp)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

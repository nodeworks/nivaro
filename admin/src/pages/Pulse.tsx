import {
  ActivityEntry,
  groupActivity,
  ROUTINE_READ_ACTIONS,
  useActivityLabels
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { Activity, Eye, Pause, Play, Radio } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { getSocket } from '@/lib/socket'
import { cn } from '@/lib/utils'

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
  user?: string | null
  origin?: string | null
  group_key?: string | null
  actor?: string | null
  auth_method?: string | null
  live?: boolean
}

/** Reads ("Pat opened PO 4471") outnumber every other entry many times over; off by default. */
const isRead = (e: PulseEvent) => ROUTINE_READ_ACTIONS.includes(e.action)

const MAX_EVENTS = 150
const BUCKETS = 30

export function PulsePage() {
  const { user } = useAuth()
  const [events, setEvents] = useState<PulseEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [showReads, setShowReads] = useState(false)
  // Paused: new events wait in a buffer so the list holds still while someone reads it.
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const [waiting, setWaiting] = useState<PulseEvent[]>([])
  const navigate = useNavigate()
  const countsRef = useRef<Map<number, number>>(new Map()) // minute-epoch → count
  const [, forceTick] = useState(0)

  // Seed with recent history
  const { data: seed } = useQuery({
    queryKey: ['pulse-seed'],
    queryFn: () =>
      api
        .get<{ data: PulseEvent[] }>('/activity', {
          params: { limit: 60, exclude_actions: 'read' }
        })
        .then((r) => r.data.data),
    staleTime: Number.POSITIVE_INFINITY
  })
  useEffect(() => {
    if (seed && events.length === 0) setEvents(seed)
    // biome-ignore lint/correctness/useExhaustiveDependencies: seed once
  }, [seed])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect when the signed-in person changes
  useEffect(() => {
    // The app's one socket (getSocket: the shared worker, or this tab's own) — signed in there.
    const socket = getSocket()
    const onAuth = () => {
      socket.emit('pulse:join')
      setConnected(true)
    }
    const onPulse = (e: PulseEvent) => {
      if (pausedRef.current)
        setWaiting((prev) => [{ ...e, live: true }, ...prev].slice(0, MAX_EVENTS))
      else setEvents((prev) => [{ ...e, live: true }, ...prev].slice(0, MAX_EVENTS))
      const minute = Math.floor(Date.now() / 60_000)
      countsRef.current.set(minute, (countsRef.current.get(minute) ?? 0) + 1)
    }
    const onDisconnect = () => setConnected(false)
    socket.on('auth:ok', onAuth)
    socket.on('activity:pulse', onPulse)
    socket.on('disconnect', onDisconnect)
    // Already signed in: join now (a join before sign-in is ignored; auth:ok joins again).
    if (socket.connected) onAuth()

    const tick = setInterval(() => forceTick((n) => n + 1), 10_000)
    return () => {
      socket.emit('pulse:leave')
      socket.off('auth:ok', onAuth)
      socket.off('activity:pulse', onPulse)
      socket.off('disconnect', onDisconnect)
      clearInterval(tick)
    }
  }, [user?.id])

  const spark = useMemo(() => {
    const now = Math.floor(Date.now() / 60_000)
    return Array.from(
      { length: BUCKETS },
      (_, i) => countsRef.current.get(now - (BUCKETS - 1 - i)) ?? 0
    )
  }, [events.length])
  const sparkMax = Math.max(1, ...spark)

  const shown = useMemo(
    () => (showReads ? events : events.filter((e) => !isRead(e))),
    [events, showReads]
  )
  const hiddenReads = events.length - shown.length
  const groups = useMemo(() => groupActivity(shown), [shown])
  const labels = useActivityLabels(shown)

  const setPausedBoth = (next: boolean) => {
    pausedRef.current = next
    setPaused(next)
    if (!next && waiting.length > 0) {
      setEvents((prev) => [...waiting, ...prev].slice(0, MAX_EVENTS))
      setWaiting([])
    }
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='What people, integrations and jobs are doing right now, newest first. The bars count changes per minute for the last 30 minutes.'
        actions={
          <>
            <Button
              size='sm'
              variant='ghost'
              className='h-7 gap-1.5 text-[12px]'
              aria-pressed={showReads}
              onClick={() => setShowReads((v) => !v)}
            >
              <Eye className='h-3.5 w-3.5' aria-hidden />
              {showReads ? 'Hide record views' : 'Show record views'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-7 gap-1.5 text-[12px]'
              aria-pressed={paused}
              onClick={() => setPausedBoth(!paused)}
            >
              {paused ? (
                <Play className='h-3.5 w-3.5' aria-hidden />
              ) : (
                <Pause className='h-3.5 w-3.5' aria-hidden />
              )}
              {paused
                ? waiting.length > 0
                  ? `Resume (${waiting.length} new)`
                  : 'Resume'
                : 'Pause'}
            </Button>
            <span
              className='inline-flex items-center gap-1.5 text-[12px] text-muted-foreground'
              role='status'
            >
              <Radio
                className={cn('h-3.5 w-3.5', connected ? 'text-green-500' : 'text-slate-300')}
                aria-hidden
              />
              {paused ? 'Paused' : connected ? 'Live' : 'Connecting…'}
            </span>
            {/* per-minute sparkline */}
            <div
              className='flex h-8 items-end gap-[3px]'
              data-tip='Changes per minute, last 30 minutes'
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
          </>
        }
      />

      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='max-w-4xl p-4 sm:p-6'>
          {groups.length === 0 ? (
            <div className='pt-16 text-center text-slate-500 dark:text-muted-foreground'>
              <Activity className='mx-auto h-8 w-8 opacity-40' aria-hidden />
              <p className='mt-3 text-[13px]'>
                {connected
                  ? 'Nothing has changed yet. New changes appear here as they happen.'
                  : 'Connecting to the live stream…'}
              </p>
              {hiddenReads > 0 && (
                <p className='mt-1 text-[12px]'>
                  {hiddenReads} record {hiddenReads === 1 ? 'view is' : 'views are'} hidden.
                </p>
              )}
            </div>
          ) : (
            <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <div className='divide-y divide-slate-100 dark:divide-border'>
                {groups.map((g) => (
                  <ActivityEntry
                    key={g.key}
                    entry={g.entries[0]}
                    group={g.entries.length > 1 ? g.entries : undefined}
                    labels={labels}
                    onOpen={(e) => e.id != null && navigate(`/activity/${e.id}`)}
                    className={cn(
                      'px-3',
                      (g.entries[0] as PulseEvent).live && 'animate-page-enter bg-nvr-cyan/[0.04]'
                    )}
                  />
                ))}
              </div>
              {hiddenReads > 0 && (
                <p className='border-t border-slate-100 px-3 py-2 text-[11.5px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                  {hiddenReads} record {hiddenReads === 1 ? 'view' : 'views'} hidden ·{' '}
                  <button
                    type='button'
                    className='underline underline-offset-2 hover:text-foreground'
                    onClick={() => setShowReads(true)}
                  >
                    show them
                  </button>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

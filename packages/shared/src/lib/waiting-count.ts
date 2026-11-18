import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'
import { useLiveEvent } from './live'
import { useLiveOps } from './live-ops'
import { useLiveRefetchInterval } from './live-queries'

/** The slice of GET /my-work/counts this count reads. */
export interface WaitingCounts {
  owned?: number
  approvals?: number
  tasks?: number
  questions?: number
}

/**
 * What "waiting on you" adds up to in the tab title: records you own, approval steps on you
 * and questions put to you. Open tasks are left out (Rob, 2026-11-15) — a standing to-do list
 * is not something that just arrived, and it kept the count from ever reaching zero.
 * Pure — exported for tests. Anything missing or negative counts as none.
 */
export function waitingCount(counts: WaitingCounts | null | undefined): number {
  if (!counts) return 0
  let n = 0
  for (const v of [counts.owned, counts.approvals, counts.questions]) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) n += Math.floor(v)
  }
  return n
}

/** A refetch is at least this far from the last one. */
export const WAITING_LIVE_GAP_MS = 30_000

/** The query the tab count reads: GET /my-work/counts, the three numbers and nothing else. */
export const WAITING_COUNT_KEY = ['my-work-count'] as const

/**
 * The number of things waiting on the signed-in person, live. Reads the cheap
 * `GET /my-work/counts` (not the whole My Work aggregation), under its own key. A poke from the
 * ops topic or a new notification refetches it, never closer together than WAITING_LIVE_GAP_MS.
 * A hidden tab does nothing: no poll, and pokes that arrive meanwhile are replayed once when the
 * tab becomes visible again (S14).
 */
export function useWaitingCount(enabled = true): number {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const poll = useLiveRefetchInterval(180_000, { safetyMs: 180_000, enabled })
  const { data } = useQuery({
    queryKey: WAITING_COUNT_KEY,
    queryFn: () =>
      client!
        .request<{ data: WaitingCounts }>(get('/my-work/counts'))
        .then((r) => r.data as WaitingCounts),
    enabled: enabled && !!client,
    staleTime: 60_000,
    refetchInterval: poll,
    refetchIntervalInBackground: false,
    retry: false,
    select: (d) => waitingCount(d as WaitingCounts | undefined)
  })
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const missed = useRef(false)
  const poke = () => {
    if (typeof document !== 'undefined' && document.hidden) {
      missed.current = true
      return
    }
    if (timer.current) return
    const run = () => {
      timer.current = null
      last.current = Date.now()
      void qc.invalidateQueries({ queryKey: WAITING_COUNT_KEY })
    }
    const wait = last.current + WAITING_LIVE_GAP_MS - Date.now()
    if (wait <= 0) run()
    else timer.current = setTimeout(run, wait)
  }
  const pokeRef = useRef(poke)
  pokeRef.current = poke
  useLiveOps('my-work', poke, { debounceMs: 1500, enabled })
  useLiveEvent('notification:new', poke, { debounceMs: 1500, enabled })
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    const onVisible = () => {
      if (document.hidden || !missed.current) return
      missed.current = false
      pokeRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return enabled ? (data ?? 0) : 0
}

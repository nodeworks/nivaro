import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'
import { useLiveEvent } from './live'
import { useLiveOps } from './live-ops'
import { useLiveRefetchInterval } from './live-queries'

/** The slice of GET /my-work this count reads. */
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

/** A refetch is at least this far from the last one: /my-work re-aggregates, so a burst waits. */
export const WAITING_LIVE_GAP_MS = 30_000

/**
 * The number of things waiting on the signed-in person, live. Shares the My Work page's
 * query (`['my-work']`, same shape), so an open My Work page and this count are one read.
 * Pokes from the ops topic and new notifications refetch it, never closer together than
 * WAITING_LIVE_GAP_MS; a slow poll (kept going in a hidden tab — that is where the title
 * matters) covers a missed poke.
 */
export function useWaitingCount(enabled = true): number {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const poll = useLiveRefetchInterval(180_000, { safetyMs: 180_000, enabled })
  const { data } = useQuery({
    queryKey: ['my-work'],
    queryFn: () =>
      client!
        .request<{ data: Record<string, unknown> }>(get('/my-work'))
        .then((r) => r.data as Record<string, unknown>),
    enabled: enabled && !!client,
    staleTime: 60_000,
    refetchInterval: poll,
    refetchIntervalInBackground: true,
    retry: false,
    select: (d) => waitingCount((d as { counts?: WaitingCounts } | undefined)?.counts)
  })
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const poke = () => {
    if (timer.current) return
    const run = () => {
      timer.current = null
      last.current = Date.now()
      void qc.invalidateQueries({ queryKey: ['my-work'] })
    }
    const wait = last.current + WAITING_LIVE_GAP_MS - Date.now()
    if (wait <= 0) run()
    else timer.current = setTimeout(run, wait)
  }
  useLiveOps('my-work', poke, { debounceMs: 1500, enabled })
  useLiveEvent('notification:new', poke, { debounceMs: 1500, enabled })
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return enabled ? (data ?? 0) : 0
}

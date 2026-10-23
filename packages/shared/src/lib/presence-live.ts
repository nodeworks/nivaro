import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { LIVE_WINDOW_EVENT } from './live'
import { useLiveRefetchInterval } from './live-queries'
import { type RealtimeAdapter, useOptionalRealtime } from './realtime'

/**
 * The shared online list (`['presence-online']`, GET /presence/online) kept current from
 * `presence:changed` — ONE listener per tab, however many components read the list.
 *
 * Staging 2026-10-23: every mounted reader invalidated the list on every presence event, so
 * each event made every open browser refetch, several times over (N² load on a ~250 ms
 * handler). Now a burst of events — the server already coalesces them, `{ user_id, user_ids }`
 * (older servers: `{ user_id }`) — becomes one invalidate PRESENCE_REFETCH_DELAY_MS after the
 * first event, which joins a refetch already in flight instead of cancelling it. The payload
 * shape does not matter here: any change refreshes the whole list.
 *
 * Polls under the listener are a backstop only (PRESENCE_POLL_BACKSTOP_MS while the socket is
 * live; the readers' own interval when it is not).
 */

export const PRESENCE_ONLINE_KEY = ['presence-online'] as const
export const PRESENCE_REFETCH_DELAY_MS = 1000
export const PRESENCE_POLL_BACKSTOP_MS = 60_000

interface Hub {
  refs: number
  adapter: RealtimeAdapter | null
  offAdapter: (() => void) | null
  offWindow: () => void
  timer: ReturnType<typeof setTimeout> | null
}

const hubs = new WeakMap<QueryClient, Hub>()

function schedule(qc: QueryClient, hub: Hub): void {
  if (hub.timer) return // the burst's refetch is already scheduled
  hub.timer = setTimeout(() => {
    hub.timer = null
    void qc.invalidateQueries({ queryKey: [...PRESENCE_ONLINE_KEY] }, { cancelRefetch: false })
  }, PRESENCE_REFETCH_DELAY_MS)
}

/** Take a reference on the tab's presence listener; returns the release. Exported for tests. */
export function acquirePresenceListener(
  qc: QueryClient,
  adapter: RealtimeAdapter | null
): () => void {
  let hub = hubs.get(qc)
  if (!hub) {
    const fresh: Hub = {
      refs: 0,
      adapter: null,
      offAdapter: null,
      offWindow: () => {},
      timer: null
    }
    // Events relayed through the window (leader/follower tabs, replays) count too.
    const onWindow = (e: Event) => {
      const d = (e as CustomEvent).detail as { event?: string } | undefined
      if (d?.event === 'presence:changed') schedule(qc, fresh)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener(LIVE_WINDOW_EVENT, onWindow)
      fresh.offWindow = () => window.removeEventListener(LIVE_WINDOW_EVENT, onWindow)
    }
    hub = fresh
    hubs.set(qc, hub)
  }
  const h = hub
  h.refs++
  if (adapter && h.adapter !== adapter) {
    h.offAdapter?.()
    h.adapter = adapter
    h.offAdapter = adapter.on('presence:changed', () => schedule(qc, h))
  }
  let released = false
  return () => {
    if (released) return
    released = true
    h.refs--
    if (h.refs > 0) return
    h.offAdapter?.()
    h.offWindow()
    if (h.timer) clearTimeout(h.timer)
    hubs.delete(qc)
  }
}

/** Keep `['presence-online']` current from presence:changed while mounted (shared listener). */
export function usePresenceOnlineLive(enabled = true): void {
  const qc = useQueryClient()
  const realtime = useOptionalRealtime()
  useEffect(() => {
    if (!enabled) return
    return acquirePresenceListener(qc, realtime)
  }, [qc, realtime, enabled])
}

/**
 * The poll interval for a `['presence-online']` reader: `base` without a live socket, a
 * PRESENCE_POLL_BACKSTOP_MS backstop while presence:changed is arriving. Also mounts the
 * shared listener, so every reader stays current without polling hard.
 */
export function usePresenceOnlinePoll(
  base: number | false,
  enabled = true
): number | false | undefined {
  usePresenceOnlineLive(enabled)
  return useLiveRefetchInterval(enabled ? base : false, { safetyMs: PRESENCE_POLL_BACKSTOP_MS })
}

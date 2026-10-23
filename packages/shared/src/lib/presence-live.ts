import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useItemEditAuth } from '../context'
import { LIVE_WINDOW_EVENT } from './live'
import { useLiveRefetchInterval } from './live-queries'
import { presenceChangeTouches } from './presence-state'
import { type RealtimeAdapter, useOptionalRealtime } from './realtime'

/**
 * The shared online list (`['presence-online']`, GET /presence/online) kept current from
 * `presence:changed` — ONE listener per tab, however many components read the list.
 *
 * Staging 2026-10-23: every mounted reader invalidated the list on every presence event, so
 * each event made every open browser refetch, several times over (N² load on a ~250 ms
 * handler). Then, at 250 people (≈ 400 tabs), someone changed in nearly every server window,
 * so even one refetch per event per tab was ~180 req/s. The rule now, per tab:
 *
 *   lastRefreshAt = when the last presence:changed-driven invalidate FIRED (0 at start, reset
 *   when the last reader leaves). Backstop polls and mount fetches do not count.
 *   On presence:changed:
 *     - the event names this tab's own user (not `many`): refresh NOW, replacing any pending
 *       timer — a person sees their own change at once;
 *     - a refresh is already pending: nothing (it will read this change too);
 *     - since = now - lastRefreshAt
 *       quiet (since >= PRESENCE_MIN_REFRESH_GAP_MS): refresh in PRESENCE_REFRESH_WINDOW_MS;
 *       busy: refresh in (PRESENCE_MIN_REFRESH_GAP_MS - since) + random * PRESENCE_REFRESH_JITTER_MS.
 *   The refresh is an invalidate with { cancelRefetch: false } (joins a fetch in flight).
 *
 * So a quiet tenant shows a change in ~1 s, a busy one refreshes each tab at most once per
 * 10–12 s, spread by the jitter, and a change shows everywhere within ≈ 12 s: the server's
 * coalescing window (api services/presence-changed.ts, ≤ 3 s) falls inside the gap rather
 * than adding to it. efp-new implements the same rule with the same constants.
 * The payload shape (`{ user_id, user_ids, many? }`, older servers `{ user_id }`) only matters
 * for the own-user check: any change refreshes the whole list.
 *
 * Polls under the listener are a backstop only (PRESENCE_POLL_BACKSTOP_MS while the socket is
 * live; the readers' own interval when it is not).
 */

export const PRESENCE_ONLINE_KEY = ['presence-online'] as const
/** Quiet: how long after the first change the list refreshes. */
export const PRESENCE_REFRESH_WINDOW_MS = 1000
/** @deprecated the quiet delay; use PRESENCE_REFRESH_WINDOW_MS. */
export const PRESENCE_REFETCH_DELAY_MS = PRESENCE_REFRESH_WINDOW_MS
/** Busy: the least time between two event-driven refreshes of one tab. */
export const PRESENCE_MIN_REFRESH_GAP_MS = 10_000
/** Busy: random spread added on top of the gap so tabs do not refetch in step. */
export const PRESENCE_REFRESH_JITTER_MS = 2000
export const PRESENCE_POLL_BACKSTOP_MS = 60_000

interface Hub {
  refs: number
  adapter: RealtimeAdapter | null
  offAdapter: (() => void) | null
  offWindow: () => void
  timer: ReturnType<typeof setTimeout> | null
  lastRefreshAt: number
  /** This tab's signed-in user, for "your own change shows at once". */
  selfId: string | null
}

const hubs = new WeakMap<QueryClient, Hub>()

/** Test seams: the clock and the jitter source. */
export const presenceLiveClock = { now: () => Date.now(), random: () => Math.random() }

function refresh(qc: QueryClient, hub: Hub): void {
  if (hub.timer) clearTimeout(hub.timer)
  hub.timer = null
  hub.lastRefreshAt = presenceLiveClock.now()
  void qc.invalidateQueries({ queryKey: [...PRESENCE_ONLINE_KEY] }, { cancelRefetch: false })
}

/** How long to wait before refreshing for a change that arrives `since` ms after the last one. */
export function presenceRefreshDelay(since: number, random = presenceLiveClock.random()): number {
  if (since >= PRESENCE_MIN_REFRESH_GAP_MS) return PRESENCE_REFRESH_WINDOW_MS
  return PRESENCE_MIN_REFRESH_GAP_MS - Math.max(0, since) + random * PRESENCE_REFRESH_JITTER_MS
}

function onChange(qc: QueryClient, hub: Hub, payload: unknown): void {
  const p = payload as { many?: unknown } | null | undefined
  if (hub.selfId && p?.many !== true && presenceChangeTouches(payload, hub.selfId)) {
    refresh(qc, hub)
    return
  }
  if (hub.timer) return // a refresh is already on its way and will read this change too
  const since = presenceLiveClock.now() - hub.lastRefreshAt
  hub.timer = setTimeout(() => refresh(qc, hub), presenceRefreshDelay(since))
}

/** Take a reference on the tab's presence listener; returns the release. Exported for tests. */
export function acquirePresenceListener(
  qc: QueryClient,
  adapter: RealtimeAdapter | null,
  selfId?: string | null
): () => void {
  let hub = hubs.get(qc)
  if (!hub) {
    const fresh: Hub = {
      refs: 0,
      adapter: null,
      offAdapter: null,
      offWindow: () => {},
      timer: null,
      lastRefreshAt: 0,
      selfId: null
    }
    // Events relayed through the window (leader/follower tabs, replays) count too.
    const onWindow = (e: Event) => {
      const d = (e as CustomEvent).detail as { event?: string; payload?: unknown } | undefined
      if (d?.event === 'presence:changed') onChange(qc, fresh, d.payload)
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
  if (selfId) h.selfId = String(selfId)
  if (adapter && h.adapter !== adapter) {
    h.offAdapter?.()
    h.adapter = adapter
    h.offAdapter = adapter.on('presence:changed', (payload: unknown) => onChange(qc, h, payload))
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
  const { userId } = useItemEditAuth()
  useEffect(() => {
    if (!enabled) return
    return acquirePresenceListener(qc, realtime, userId || null)
  }, [qc, realtime, enabled, userId])
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

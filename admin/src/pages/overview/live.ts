import { ROUTINE_READ_ACTIONS } from '@nivaro/shared'
import { useEffect, useRef } from 'react'
import { getSocket } from '@/lib/socket'

/**
 * The Overview's live feed. Administrators join the activity pulse room (every entry as it is
 * written — the room refuses anyone else); everyone else is refreshed on a gentle interval by
 * the queries themselves. One subscription per page, handed to whoever listens.
 */

export interface PulseEvent {
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
}

/** Entries the Overview never shows: record views and config housekeeping. */
export const HIDDEN_ACTIONS = [...ROUTINE_READ_ACTIONS, 'config-epoch', 'config-snapshot-store']
export const isShownEvent = (e: { action: string | null }) =>
  !!e.action && !HIDDEN_ACTIONS.includes(e.action)

// One room membership for however many parts of the page listen (a leave from one must not
// drop the others): joined on the first listener, left after the last.
const listeners = new Set<(e: PulseEvent) => void>()
let detach: (() => void) | null = null

function attach() {
  const socket = getSocket()
  const join = () => socket.emit('pulse:join')
  const on = (e: PulseEvent) => {
    for (const l of listeners) l(e)
  }
  socket.on('auth:ok', join)
  socket.on('activity:pulse', on)
  if (socket.connected) join()
  detach = () => {
    socket.emit('pulse:leave')
    socket.off('auth:ok', join)
    socket.off('activity:pulse', on)
    detach = null
  }
}

export function usePulse(enabled: boolean, onEvent: (e: PulseEvent) => void, userId?: string) {
  const handler = useRef(onEvent)
  handler.current = onEvent
  // biome-ignore lint/correctness/useExhaustiveDependencies: rejoin when the signed-in person changes
  useEffect(() => {
    if (!enabled) return
    const l = (e: PulseEvent) => handler.current(e)
    listeners.add(l)
    if (!detach) attach()
    return () => {
      listeners.delete(l)
      if (listeners.size === 0) detach?.()
    }
  }, [enabled, userId])
}

/**
 * A trailing call at most once per `gapMs` (bursts of writes become one refetch; the last one
 * is never dropped).
 */
export function useThrottledCall(fn: () => void, gapMs: number) {
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ref = useRef(fn)
  ref.current = fn
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return () => {
    if (timer.current) return
    const wait = Math.max(0, last.current + gapMs - Date.now())
    timer.current = setTimeout(() => {
      timer.current = null
      last.current = Date.now()
      ref.current()
    }, wait)
  }
}

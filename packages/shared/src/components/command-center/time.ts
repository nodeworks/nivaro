import { type CSSProperties, useEffect, useRef } from 'react'
import { useLiveEvent } from '../../lib/live'
import { useOptionalRealtime } from '../../lib/realtime'
import { useCc } from './state'
import { ccVars, useAppIsDark } from './theme'

/**
 * Command Center time, links & live helpers (program slice 3).
 *
 * URL parameters the board understands (slice 4 reads them on open, the Traffic Map writes `map`):
 *   region=<region id>           focus the board on a region
 *   at=<ISO instant | epoch ms>  rewind the board to that instant (live when absent)
 *   map=<collection>             the map / board's collection focus
 *   peek=<collection>:<id>       open that record in the peek panel
 */
export const CC_URL_PARAMS = ['region', 'at', 'map', 'peek'] as const

/** The Command Center focused on one collection (and optionally rewound). */
export function commandCenterUrl(opts: {
  map?: string | null
  region?: string | null
  at?: number | null
  peek?: { collection: string; id: string } | null
  base?: string
}): string {
  const p = new URLSearchParams()
  if (opts.region) p.set('region', opts.region)
  if (opts.at) p.set('at', new Date(opts.at).toISOString())
  if (opts.map) p.set('map', opts.map)
  if (opts.peek) p.set('peek', `${opts.peek.collection}:${opts.peek.id}`)
  const qs = p.toString()
  return `${opts.base ?? '/command'}${qs ? `?${qs}` : ''}`
}

/**
 * The Traffic Map with a collection's node selected (admin route /traffic-map; `sel` is the
 * map's own view parameter, `at` its rewind second). null for system tables and odd names.
 */
export function trafficMapUrl(collection: string, at?: number | null): string | null {
  if (
    collection.startsWith('__') ||
    !/^[A-Za-z0-9_]{1,128}$/.test(collection) ||
    /^(nivaro|directus)_/i.test(collection)
  )
    return null
  const p = new URLSearchParams({ sel: `entity:items/${collection}` })
  if (at) p.set('at', String(Math.floor(at / 1000)))
  return `/traffic-map?${p.toString()}`
}

/** "2:10 PM" in the viewer's own zone. */
export function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** "Tue, Oct 28, 2:10 PM" when not today, else the clock. */
export function whenLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  if (sameDay) return clockLabel(ms)
  return d.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Local midnight of the day containing `ms` (viewer's zone). */
export function localDayStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * The activity pulse (administrators): every activity entry as it is written, from the
 * admin-only 'pulse' socket room the server refuses to anyone else. Joins through the host's
 * RealtimeAdapter (admin's shared-worker / leader socket; the worker reference-counts the room
 * and rejoins after a reconnect), joins again whenever the connection comes back, leaves on
 * unmount. Without a host adapter it does nothing (the caller polls instead).
 */
export function useCcPulse(
  enabled: boolean,
  onEntry: (e: { action?: string; collection?: string | null }) => void
): boolean {
  const realtime = useOptionalRealtime()
  const live = enabled && !!realtime
  const handler = useRef(onEntry)
  handler.current = onEntry
  useEffect(() => {
    if (!live || !realtime) return
    realtime.emit('pulse:join')
    let wasLive = (realtime.status?.().state ?? 'live') === 'live'
    const off = realtime.onStatus?.((s) => {
      const isLive = s.state === 'live'
      if (isLive && !wasLive) realtime.emit('pulse:join')
      wasLive = isLive
    })
    return () => {
      off?.()
      realtime.emit('pulse:leave')
    }
  }, [live, realtime])
  useLiveEvent('activity:pulse', (p) => handler.current(p ?? {}), {
    includeOwn: true,
    enabled: live
  })
  return live
}

/**
 * The board's colour tokens for content portaled out of the board root (popovers): the
 * --cc-* variables live on the board's own element, so a portal re-applies them.
 */
export function usePortalVars(): CSSProperties {
  const { tv } = useCc()
  const dark = useAppIsDark()
  return ccVars(dark || tv ? 'dark' : 'light')
}

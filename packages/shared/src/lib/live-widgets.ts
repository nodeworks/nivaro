import { useEffect, useRef, useState } from 'react'
import { useOptionalRealtime } from './realtime'

/**
 * Pushed dashboard and report widgets (#1675).
 *
 * The widget asks the server to watch it (`widgets:watch` over the host's socket). When a write
 * lands on a collection the widget reads, the server recomputes it AS THIS SIGN-IN — at most
 * once every 10 seconds per widget — and pushes the new figure to this socket alone
 * (`widget:data`). `onData` gets it; the caller drops it into its query cache.
 *
 * Returns whether the push is on. While it is, the caller slows its poll to a safety net
 * (`liveWidgetInterval`); when the server refuses the widget (raw-SQL query widgets, AI
 * insight, calc formulas, a host without realtime) or drops it, the poll carries on as before.
 * The watch is renewed every minute and after a reconnect (the server lets it lapse after 150
 * seconds unrenewed), and a reconnect refetches once through `onStale`, since writes made while
 * disconnected were not pushed.
 */

export interface LiveWidgetOptions {
  kind: 'dashboard' | 'report'
  widget: string
  report?: string | null
  /** Dashboard: `{ extra_filters }`; report: `{ date_range, entity_filters }`. */
  params?: Record<string, unknown> | null
  enabled?: boolean
  onData: (data: unknown) => void
  /** Refetch through the normal route (figure too large to push, or a reconnect). */
  onStale?: () => void
}

const RENEW_MS = 60_000
/** The poll a pushed widget keeps as a safety net. */
export const LIVE_WIDGET_SAFETY_MS = 5 * 60_000

/** The refetch interval to use: the caller's own while not live, a slow safety poll while live. */
export function liveWidgetInterval(live: boolean, base: number | undefined): number | undefined {
  if (!live || base == null) return base
  return Math.max(base, LIVE_WIDGET_SAFETY_MS)
}

function newKey(): string {
  return `w${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
}

export function useLiveWidget(opts: LiveWidgetOptions): boolean {
  const realtime = useOptionalRealtime()
  const [live, setLive] = useState(false)
  const dataRef = useRef(opts.onData)
  dataRef.current = opts.onData
  const staleRef = useRef(opts.onStale)
  staleRef.current = opts.onStale
  const enabled = opts.enabled !== false && !!opts.widget
  let paramsJson = 'null'
  try {
    paramsJson = JSON.stringify(opts.params ?? null)
  } catch {
    /* unserialisable params: watch without them */
  }
  const { kind, widget } = opts
  const report = opts.report ?? null

  useEffect(() => {
    if (!realtime || !enabled) return
    // A fresh key per watch: a push for the previous parameters never lands on these.
    const key = newKey()
    const params = JSON.parse(paramsJson) as Record<string, unknown> | null
    const send = () =>
      realtime.emit('widgets:watch', { watches: [{ key, kind, widget, report, params }] })
    const mine = (p: unknown) => (p as { key?: unknown } | null)?.key === key
    const offs = [
      realtime.on(
        'widget:watching',
        (p: { accepted?: string[]; refused?: Array<{ key: string }> }) => {
          if (p?.accepted?.includes(key)) setLive(true)
          else if (p?.refused?.some((r) => r?.key === key)) setLive(false)
        }
      ),
      realtime.on('widget:data', (p: { key?: string; data?: unknown }) => {
        if (mine(p)) dataRef.current(p.data)
      }),
      realtime.on('widget:stale', (p) => {
        if (mine(p)) staleRef.current?.()
      }),
      realtime.on('widget:unwatched', (p) => {
        if (mine(p)) setLive(false)
      })
    ]
    let wasLive = realtime.status?.().state !== 'reconnecting'
    const offStatus = realtime.onStatus?.((s) => {
      const nowLive = s.state === 'live'
      if (nowLive && !wasLive) {
        send()
        staleRef.current?.()
      }
      wasLive = nowLive
    })
    send()
    const timer = setInterval(send, RENEW_MS)
    return () => {
      clearInterval(timer)
      for (const off of offs) off()
      offStatus?.()
      realtime.emit('widgets:unwatch', { keys: [key] })
      setLive(false)
    }
  }, [realtime, enabled, kind, widget, report, paramsJson])

  return live
}

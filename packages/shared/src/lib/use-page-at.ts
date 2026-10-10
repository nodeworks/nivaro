import { useEffect, useRef } from 'react'
import { useOptionalRealtime } from './realtime'

/**
 * Journeys for the portal (#1391): report where this person is on every route
 * change, the way the admin does (admin/src/lib/use-page-presence.ts), so
 * nivaro_admin_journeys, the presence map, "who else is here" and stuck
 * detection cover both apps.
 *
 * Rides the host's RealtimeAdapter (RealtimeContext) — the socket the portal
 * already holds — and no-ops without one. Pass the router's pathname as
 * `path` when the host has one; without it the hook follows
 * window.location itself (popstate plus a one-second check, which also sees
 * pushState navigations without patching history).
 *
 *   usePageAt({ app: 'efp', path: useLocation().pathname })
 */

const CHECK_MS = 1000

/** The ping body, or null when the path is not something the server keeps. */
export function pageAtPayload(path: string, app: string): { path: string; app: string } | null {
  if (!path.startsWith('/') || path.startsWith('//')) return null
  return { path: path.slice(0, 200), app: app.slice(0, 50) }
}

export function usePageAt(opts: { app: string; path?: string; disabled?: boolean }): void {
  const rt = useOptionalRealtime()
  const { app, path, disabled } = opts
  const last = useRef<string | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path

  useEffect(() => {
    if (!rt || disabled || typeof window === 'undefined') return
    const current = () => pathRef.current ?? window.location.pathname
    const send = (force = false) => {
      const p = current()
      if (!force && p === last.current) return
      const body = pageAtPayload(p, app)
      if (!body) return
      last.current = p
      try {
        rt.emit('page:at', body)
      } catch {
        /* presence must never break the page */
      }
    }
    send(true)
    // A reconnect is a new server socket with no page — say it again.
    const offAuth = rt.on('auth:ok', () => send(true))
    const onPop = () => send()
    window.addEventListener('popstate', onPop)
    const timer = pathRef.current === undefined ? setInterval(() => send(), CHECK_MS) : null
    return () => {
      offAuth()
      window.removeEventListener('popstate', onPop)
      if (timer) clearInterval(timer)
      last.current = null
    }
  }, [rt, app, disabled])

  // Router-driven hosts: the prop changing IS the route change.
  useEffect(() => {
    if (!rt || disabled || path === undefined || path === last.current) return
    const body = pageAtPayload(path, app)
    if (!body) return
    last.current = path
    try {
      rt.emit('page:at', body)
    } catch {
      /* presence must never break the page */
    }
  }, [rt, app, disabled, path])
}

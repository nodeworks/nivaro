/**
 * Real-user monitoring collector. Hand-rolled (no web-vitals dep): one 'load'
 * event per page load (TTFB / FCP / LCP / total) once LCP settles, plus one
 * 'route' event per SPA navigation (time from route change to a settled
 * frame). Batched and sent via sendBeacon/fetch to POST /api/rum — fire and
 * forget, RUM must never affect the page it measures.
 *
 * Host wiring: call `startRum({app, routePattern})` once at app mount, and
 * `rumRouteChange(pathname)` on every route change. `routePattern` turns a
 * concrete path into its pattern ('/collections/workflows/123' →
 * '/collections/:c/:id') so p75s aggregate per PAGE, not per record.
 */

interface RumEvent {
  route: string
  kind: 'load' | 'route' | 'rage'
  ttfb_ms?: number
  fcp_ms?: number
  lcp_ms?: number
  duration_ms?: number
  app?: string
}

let started = false
let appName: string | undefined
let toPattern: (path: string) => string = (p) => p
let queue: RumEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let apiBase = '/api'

// ─── Rage-click detection (#409) ────────────────────────────────────────────
// 3+ clicks on the same element within 600ms = frustration; reported as a
// 'rage' RUM event with the element's readable label folded into the route
// ("/collections/:c :: button 'Save'"). Detection only — no recording.
let rageTarget: EventTarget | null = null
let rageCount = 0
let rageTimer: ReturnType<typeof setTimeout> | null = null

function targetLabel(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const text = (el.textContent ?? '').trim().slice(0, 40)
  const aria = el.getAttribute('aria-label')
  const testid = el.getAttribute('data-testid')
  return `${tag}${testid ? `[${testid}]` : ''}${aria ? ` '${aria}'` : text ? ` '${text}'` : ''}`
}

function watchRageClicks(currentRoute: () => string): void {
  if (typeof window === 'undefined') return
  window.addEventListener(
    'click',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest('button, a, [role="button"], input, [data-testid]') : null
      if (!el) return
      if (el === rageTarget) {
        rageCount++
        if (rageCount === 3) {
          enqueue({
            kind: 'rage',
            route: `${currentRoute()} :: ${targetLabel(el)}`.slice(0, 300),
            duration_ms: rageCount
          })
        }
      } else {
        rageTarget = el
        rageCount = 1
      }
      if (rageTimer) clearTimeout(rageTimer)
      rageTimer = setTimeout(() => {
        rageTarget = null
        rageCount = 0
      }, 600)
    },
    { capture: true, passive: true }
  )
}

function flush(): void {
  if (queue.length === 0) return
  const body = JSON.stringify({ events: queue.splice(0, queue.length) })
  try {
    // sendBeacon survives pagehide; credentialed fetch is the fallback.
    const ok =
      typeof navigator.sendBeacon === 'function' &&
      navigator.sendBeacon(`${apiBase}/rum`, new Blob([body], { type: 'application/json' }))
    if (!ok) {
      void fetch(`${apiBase}/rum`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      }).catch(() => {})
    }
  } catch {
    // never let telemetry throw
  }
}

function enqueue(e: RumEvent): void {
  queue.push({ ...e, app: appName })
  if (queue.length >= 10) flush()
  else {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, 10_000)
  }
}

/** Route-change timing: from the navigation to a settled double-rAF frame. */
export function rumRouteChange(pathname: string): void {
  if (!started || typeof window === 'undefined') return
  const began = performance.now()
  // Two rAFs: the first fires before paint of the new route's first frame,
  // the second after it — a cheap "render settled" proxy that tracks what a
  // person perceives far better than the synchronous route switch does.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const ms = Math.round(performance.now() - began)
      enqueue({ route: toPattern(pathname), kind: 'route', duration_ms: ms })
    })
  })
}

export function startRum(opts?: { app?: string; routePattern?: (path: string) => string; apiBase?: string }): void {
  if (started || typeof window === 'undefined' || typeof performance === 'undefined') return
  started = true
  appName = opts?.app
  if (opts?.routePattern) toPattern = opts.routePattern
  if (opts?.apiBase) apiBase = opts.apiBase
  watchRageClicks(() => toPattern(window.location.pathname))

  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  let lcp: number | null = null
  try {
    const po = new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1) as { startTime?: number } | undefined
      if (last?.startTime != null) lcp = Math.round(last.startTime)
    })
    po.observe({ type: 'largest-contentful-paint', buffered: true })
  } catch {
    // LCP unsupported — the other vitals still report
  }

  const report = () => {
    const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0]
    enqueue({
      route: toPattern(window.location.pathname),
      kind: 'load',
      ttfb_ms: nav ? Math.round(nav.responseStart) : undefined,
      fcp_ms: fcpEntry ? Math.round(fcpEntry.startTime) : undefined,
      lcp_ms: lcp ?? undefined,
      duration_ms: nav ? Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd) : undefined
    })
  }
  // LCP settles within a few seconds of load; report once, then flush on exit.
  setTimeout(report, 6_000)
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

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
  kind: 'load' | 'route' | 'rage' | 'dead' | 'widget'
  ttfb_ms?: number
  fcp_ms?: number
  lcp_ms?: number
  duration_ms?: number
  app?: string
  /** Viewport width; the server keeps only a class (phone, tablet, laptop…). */
  vw?: number
  /** 'widget' only (#1353): the canvas catalog key and the viewer's role id. */
  widget?: string
  role?: string
  fetch_ms?: number
  paint_ms?: number
}

let started = false
let appName: string | undefined
let toPattern: (path: string) => string = (p) => p
const queue: RumEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let apiBase = '/api'
/** Hosts that sign in with a bearer token (no session cookie) hand it over here. */
let tokenProvider: (() => string | null | undefined) | undefined

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
      const el =
        e.target instanceof Element
          ? e.target.closest('button, a, [role="button"], input, [data-testid]')
          : null
      if (!el) return
      if (el === rageTarget) {
        rageCount++
        if (rageCount === 3) {
          enqueue({
            kind: 'rage',
            route: `${currentRoute()} :: ${targetLabel(el)}`.slice(0, 300),
            duration_ms: rageCount
          })
          // #1371 — the server may ask this tab to record; tell it now.
          flush()
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

// ─── Dead-click bursts (#1371) ──────────────────────────────────────────────
// A click on a button or link after which nothing happens — no DOM change,
// no navigation — within DEAD_WAIT_MS is dead. DEAD_BURST of them inside
// DEAD_WINDOW_MS is reported as one 'dead' RUM event (sent at once), which
// the server can answer with an auto recording when that is on.
export const DEAD_WAIT_MS = 1000
export const DEAD_WINDOW_MS = 10_000
export const DEAD_BURST = 3

/** Counts dead clicks; true when this one completes a burst (then resets). */
export function createDeadClickCounter(burst = DEAD_BURST, windowMs = DEAD_WINDOW_MS) {
  let times: number[] = []
  return (now: number): boolean => {
    times = times.filter((t) => now - t < windowMs)
    times.push(now)
    if (times.length >= burst) {
      times = []
      return true
    }
    return false
  }
}

function watchDeadClicks(currentRoute: () => string): void {
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return
  const countDead = createDeadClickCounter()
  window.addEventListener(
    'click',
    (e) => {
      const el =
        e.target instanceof Element ? e.target.closest('button, a[href], [role="button"]') : null
      if (!el || (el as HTMLButtonElement).disabled || el.closest('.nvr-no-record')) return
      const href = window.location.href
      let alive = false
      const mo = new MutationObserver(() => {
        alive = true
      })
      try {
        mo.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true
        })
      } catch {
        return
      }
      setTimeout(() => {
        mo.disconnect()
        if (alive || window.location.href !== href) return
        if (countDead(Date.now())) {
          enqueue({
            kind: 'dead',
            route: `${currentRoute()} :: ${targetLabel(el)}`.slice(0, 300),
            duration_ms: DEAD_BURST
          })
          flush()
        }
      }, DEAD_WAIT_MS)
    },
    { capture: true, passive: true }
  )
}

function flush(): void {
  if (queue.length === 0) return
  const body = JSON.stringify({ events: queue.splice(0, queue.length) })
  try {
    const token = tokenProvider?.()
    // sendBeacon survives pagehide; credentialed fetch is the fallback. A beacon cannot carry an
    // Authorization header, so a bearer-token host always takes the keepalive fetch.
    const ok =
      !token &&
      typeof navigator.sendBeacon === 'function' &&
      navigator.sendBeacon(`${apiBase}/rum`, new Blob([body], { type: 'application/json' }))
    if (!ok) {
      void fetch(`${apiBase}/rum`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body,
        keepalive: true
      }).catch(() => {})
    }
  } catch {
    // never let telemetry throw
  }
}

function enqueue(e: RumEvent): void {
  queue.push({
    ...e,
    app: appName,
    vw: typeof window === 'undefined' ? undefined : window.innerWidth
  })
  if (queue.length >= 10) flush()
  else {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, 10_000)
  }
}

const WIDGET_KEY = /^[A-Za-z0-9._:-]{1,80}$/
const ROLE_ID = /^[0-9A-Fa-f-]{36}$/

/**
 * Per-widget timing (#1353): how long a dashboard widget took to get its data
 * (`fetchMs`, first fetch start to data settled) and to put it on screen
 * (`paintMs`, settled to the next painted frame). Carries the catalog key and
 * the viewer's role id only — no record data, no user input. A malformed key
 * is dropped here so the server never sees it.
 */
export function rumWidget(opts: {
  key: string
  roleId?: string | null
  fetchMs: number
  paintMs: number
}): void {
  if (!started || !WIDGET_KEY.test(opts.key)) return
  const role = opts.roleId && ROLE_ID.test(opts.roleId) ? opts.roleId.toUpperCase() : undefined
  enqueue({
    kind: 'widget',
    route: `widget:${opts.key}`,
    widget: opts.key,
    role,
    fetch_ms: Math.max(0, Math.round(opts.fetchMs)),
    paint_ms: Math.max(0, Math.round(opts.paintMs))
  })
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

export function startRum(opts?: {
  app?: string
  routePattern?: (path: string) => string
  apiBase?: string
  getToken?: () => string | null | undefined
}): void {
  if (started || typeof window === 'undefined' || typeof performance === 'undefined') return
  started = true
  appName = opts?.app
  if (opts?.routePattern) toPattern = opts.routePattern
  if (opts?.apiBase) apiBase = opts.apiBase
  tokenProvider = opts?.getToken
  watchRageClicks(() => toPattern(window.location.pathname))
  watchDeadClicks(() => toPattern(window.location.pathname))

  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined
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

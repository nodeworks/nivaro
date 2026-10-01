/**
 * Which screen a request came from (Traffic Map #1113 / #1116).
 *
 * Every API call a front end makes can carry three headers:
 *   x-nivaro-app   the front end (`admin`, `efp-new`)
 *   x-nivaro-page  the route PATTERN of the current screen — ids, uuids, tokens and emails are
 *                  replaced with `:id`, so no record id ever leaves in a header
 *   x-nivaro-load  one random id per route navigation / page load, so the API can count how many
 *                  calls one screen load fires (fan-out)
 *
 * The server normalises all three again and caps them (they are untrusted). Hosts either add
 * `pageContextHeaders()` to their own requests or call `installPageContextFetch()` once at boot,
 * which adds them to every `fetch` the tab makes to its own API (the SDK clients included —
 * install it before any client is created, since a client keeps the `fetch` it was given).
 */

export const PAGE_HEADER = 'x-nivaro-page'
export const LOAD_HEADER = 'x-nivaro-load'
export const APP_HEADER = 'x-nivaro-app'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `/collections/workflows/371367?tab=1` → `/collections/workflows/:id`. */
export function pagePattern(pathname: string): string {
  const path = String(pathname || '/').split(/[?#]/)[0]
  const segs: string[] = []
  for (const raw of path.split('/')) {
    if (!raw) continue
    let s = raw
    try {
      s = decodeURIComponent(raw)
    } catch {
      /* keep raw */
    }
    const id =
      /\d/.test(s) || UUID.test(s) || s.includes('@') || s.length > 40 || !/^[\w.:-]+$/.test(s)
    const seg = id ? ':id' : s.toLowerCase()
    if (seg === ':id' && segs[segs.length - 1] === ':id') continue
    segs.push(seg)
    if (segs.length >= 10) break
  }
  return `/${segs.join('/')}`.slice(0, 140)
}

function randomId(): string {
  try {
    const a = new Uint8Array(9)
    crypto.getRandomValues(a)
    return Array.from(a, (b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 16)
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }
}

/** A fresh load id whenever the path changes (a navigation), else the current one. */
export class PageContext {
  private path: string | null = null
  private load = ''
  constructor(private readonly app: string) {}
  headers(pathname: string): Record<string, string> {
    const p = String(pathname || '/').split(/[?#]/)[0]
    if (p !== this.path) {
      this.path = p
      this.load = randomId()
    }
    return {
      [APP_HEADER]: this.app,
      [PAGE_HEADER]: pagePattern(p),
      [LOAD_HEADER]: this.load
    }
  }
}

let shared: PageContext | null = null

/** The tab's page context (created by the first caller, with its app name). */
export function pageContext(app = 'app'): PageContext {
  if (!shared) shared = new PageContext(app)
  return shared
}

/** Headers for the current `window.location` (empty outside a browser). */
export function pageContextHeaders(app?: string): Record<string, string> {
  if (typeof window === 'undefined' || !window.location) return {}
  return pageContext(app).headers(window.location.pathname)
}

function isApiUrl(input: RequestInfo | URL, apiBase: string | null): boolean {
  try {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const u = new URL(raw, window.location.href)
    if (apiBase) {
      const base = new URL(apiBase, window.location.href)
      if (u.origin === base.origin && u.pathname.startsWith('/api')) return true
    }
    return u.origin === window.location.origin && u.pathname.startsWith('/api')
  } catch {
    return false
  }
}

let installed = false

/**
 * Add the page headers to every `fetch` this tab makes to its API (same origin, or `apiBase`).
 * A request that already names a header keeps its own value. Idempotent.
 */
export function installPageContextFetch(opts: { app: string; apiBase?: string | null }): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  installed = true
  const ctx = pageContext(opts.app)
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isApiUrl(input, opts.apiBase ?? null)) return original(input, init)
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    for (const [k, v] of Object.entries(ctx.headers(window.location.pathname)))
      if (!headers.has(k)) headers.set(k, v)
    return original(input, { ...init, headers })
  }
}

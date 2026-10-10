/**
 * Replay context for session recordings (#1357): the page's console warnings /
 * errors and a light request log, emitted as rrweb CUSTOM events (type 5) into
 * the same event stream as the pixels, so the replay player can list them
 * beside the replay and follow the playhead.
 *
 * One implementation for both recorders — the admin app's
 * (admin/src/lib/use-session-recorder.ts, imported by path) and @nivaro/react's
 * useSessionRecorder (bundled from this package's source).
 *
 * rrweb 2.x moved its console plugin to @rrweb/rrweb-plugin-console-record,
 * a separate package; these patches ride rrweb's own `record.addCustomEvent`
 * instead, which needs nothing new installed in a host app.
 *
 * Privacy: console lines are error/warn only, cut to 200 characters, with
 * anything token-shaped replaced by `[redacted]` first. Requests carry method,
 * route pattern (ids → `:id`, no query string), status and duration — never
 * bodies or headers.
 */

import { pagePattern } from './page-context'

export const CONSOLE_LEVELS = ['warn', 'error'] as const
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number]
export const CONSOLE_MAX_CHARS = 200
export const CONSOLE_MAX_EVENTS = 500
export const REQUEST_MAX_EVENTS = 1000

export const REDACTED = '[redacted]'

type Emit = (tag: string, payload: unknown) => void

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Replace anything that looks like a credential with `[redacted]`:
 *  - `key=value` / `key: value` / `"key":"value"` where the key names a token,
 *    secret, password, API key, authorization or cookie
 *  - `Bearer …` / `Basic …` credentials (Basic only when what follows looks encoded)
 *  - JWTs (`eyJ….….…`)
 *  - long opaque strings: 32+ hex characters, or 32+ base64/base64url
 *    characters mixing letters and digits (uuids — record ids — stay)
 */
export function redactSecrets(text: string): string {
  return (
    String(text)
      // key=value pairs first, so `authorization: Bearer x` loses the whole value.
      .replace(
        /([\w.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[\w.-]*)(["']?\s*[:=]\s*["']?)((?:(?:bearer|basic)\s+)?[^\s"'&,;}\])]+)/gi,
        (m, key: string, sep: string, value: string) =>
          value === REDACTED ? m : `${key}${sep}${REDACTED}`
      )
      .replace(/\b(bearer)\s+(?!\[redacted\])[\w.~+/=-]+/gi, `$1 ${REDACTED}`)
      // "Basic" is an English word too: only when what follows looks encoded.
      .replace(/\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})/g, (m, v: string) =>
        /[0-9+/=]/.test(v) || /[A-Z]/.test(v.slice(1)) ? `Basic ${REDACTED}` : m
      )
      .replace(/\beyJ[\w-]{6,}(?:\.[\w-]*){1,2}/g, REDACTED)
      .replace(/[A-Za-z0-9+/_=-]{32,}/g, (m) => {
        if (UUID.test(m)) return m
        if (/^[0-9a-f]{32,}$/i.test(m)) return REDACTED
        // Paths and hyphenated words are long too — an opaque token mixes
        // letters and digits and carries no path separators.
        if (m.includes('/') && /[a-z]{3,}\//i.test(m)) return m
        return /\d/.test(m) && /[a-z]/i.test(m) ? REDACTED : m
      })
  )
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return `${a.name}: ${a.message}`
  try {
    return JSON.stringify(a) ?? String(a)
  } catch {
    return String(a)
  }
}

/** One console call → the line the recording keeps: redacted, then cut to 200 characters. */
export function consoleLine(args: unknown[], max = CONSOLE_MAX_CHARS): string {
  // Bound the work on a huge object before redacting; nothing past `max` is kept anyway.
  const raw = args
    .map(stringifyArg)
    .join(' ')
    .slice(0, max * 8)
  return redactSecrets(raw).slice(0, max)
}

/**
 * Patch console.warn / console.error to also emit `console` custom events
 * ({ level, msg }). Re-entrancy guarded and capped. Returns the undo.
 */
export function instrumentConsole(emit: Emit, max = CONSOLE_MAX_EVENTS): () => void {
  if (typeof console === 'undefined') return () => {}
  let captured = 0
  let inHook = false
  const originals: Partial<Record<ConsoleLevel, (...a: unknown[]) => void>> = {}
  const patched: Partial<Record<ConsoleLevel, (...a: unknown[]) => void>> = {}
  for (const level of CONSOLE_LEVELS) {
    const original = console[level]
    originals[level] = original
    const fn = (...args: unknown[]) => {
      original.apply(console, args)
      if (inHook || captured >= max) return
      inHook = true
      try {
        captured++
        emit('console', { level, msg: consoleLine(args) })
      } catch {
        /* never break the console */
      } finally {
        inHook = false
      }
    }
    patched[level] = fn
    console[level] = fn
  }
  return () => {
    for (const level of CONSOLE_LEVELS) {
      // Someone patched over us since: leave theirs in place.
      if (console[level] === patched[level]) console[level] = originals[level] as never
    }
  }
}

/**
 * A request URL as the log keeps it: the path as a route pattern (ids, uuids,
 * emails → `:id`), no query string or fragment; a cross-origin call keeps its
 * host. Null for non-http(s) URLs (data:, blob:).
 */
export function requestRoute(url: string, base?: string): string | null {
  try {
    const origin =
      base ??
      (typeof window !== 'undefined' && window.location
        ? window.location.href
        : 'http://localhost/')
    const u = new URL(url, origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const path = pagePattern(u.pathname)
    return u.origin === new URL(origin).origin ? path : `${u.host}${path}`
  } catch {
    return null
  }
}

/**
 * The recorder's own uploads (`/session-recordings/…`) and the RUM beacon
 * (`/rum`) would otherwise log themselves into every recording.
 */
export function isRecorderNoise(url: string, base?: string): boolean {
  try {
    const origin =
      base ??
      (typeof window !== 'undefined' && window.location
        ? window.location.href
        : 'http://localhost/')
    const p = new URL(url, origin).pathname
    return /\/session-recordings(\/|$)/.test(p) || /\/rum\/?$/.test(p)
  } catch {
    return false
  }
}

export interface RequestEvent {
  method: string
  route: string
  /** 0 = network error / aborted. */
  status: number
  duration_ms: number
}

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href
  const u = (input as { url?: unknown } | null)?.url
  return typeof u === 'string' ? u : String(input ?? '')
}

/**
 * Patch fetch and XMLHttpRequest to emit `request` custom events
 * ({ method, route, status, duration_ms }) as each call settles. The page's
 * own promise / XHR is untouched — the patch only watches. Capped per page
 * load; returns the undo.
 */
export function instrumentRequests(emit: Emit, max = REQUEST_MAX_EVENTS): () => void {
  let logged = 0
  let off = false
  const record = (method: string, url: string, status: number, started: number) => {
    if (off || logged >= max) return
    try {
      if (isRecorderNoise(url)) return
      const route = requestRoute(url)
      if (!route) return
      logged++
      const ev: RequestEvent = {
        method: String(method || 'GET')
          .toUpperCase()
          .slice(0, 10),
        route,
        status: Number(status) || 0,
        duration_ms: Math.max(0, Math.round(now() - started))
      }
      emit('request', ev)
    } catch {
      /* the log is best-effort */
    }
  }

  const g = globalThis as {
    fetch?: typeof fetch
    XMLHttpRequest?: typeof XMLHttpRequest
  }

  // ── fetch ──
  const origFetch = typeof g.fetch === 'function' ? g.fetch : null
  let patchedFetch: typeof fetch | null = null
  if (origFetch) {
    patchedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const started = now()
      const pending = origFetch.call(this ?? globalThis, input, init)
      try {
        const method = init?.method ?? (input as { method?: string } | null)?.method ?? 'GET'
        const url = urlOf(input)
        pending.then(
          (res) => record(method, url, res.status, started),
          () => record(method, url, 0, started)
        )
      } catch {
        /* watching only */
      }
      return pending
    } as typeof fetch
    g.fetch = patchedFetch
  }

  // ── XMLHttpRequest (axios' browser adapter) ──
  const XHR = g.XMLHttpRequest
  const proto = XHR?.prototype
  const origOpen = proto?.open
  const origSend = proto?.send
  const meta = new WeakMap<object, { method: string; url: string }>()
  let patchedOpen: typeof XMLHttpRequest.prototype.open | null = null
  let patchedSend: typeof XMLHttpRequest.prototype.send | null = null
  if (proto && origOpen && origSend) {
    patchedOpen = function (this: XMLHttpRequest, method: string, url: string | URL) {
      try {
        meta.set(this, { method, url: urlOf(url) })
      } catch {
        /* watching only */
      }
      // biome-ignore lint/complexity/noArguments: forwards open()'s optional async/user/password as given
      return (origOpen as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[])
    } as typeof XMLHttpRequest.prototype.open
    patchedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const m = meta.get(this)
      if (m) {
        const started = now()
        try {
          this.addEventListener('loadend', () => record(m.method, m.url, this.status, started), {
            once: true
          })
        } catch {
          /* watching only */
        }
      }
      return origSend.call(this, body)
    }
    proto.open = patchedOpen
    proto.send = patchedSend
  }

  return () => {
    off = true
    if (patchedFetch && g.fetch === patchedFetch && origFetch) g.fetch = origFetch
    if (proto) {
      if (patchedOpen && proto.open === patchedOpen && origOpen) proto.open = origOpen
      if (patchedSend && proto.send === patchedSend && origSend) proto.send = origSend
    }
  }
}

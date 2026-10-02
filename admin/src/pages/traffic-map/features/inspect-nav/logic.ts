/**
 * Investigation group "nav" — pure client helpers (no React, no fetches): the search box's
 * credential guard, waterfall bar geometry, window labels and "does the Traffic Map page have
 * focus" for the page-scoped keys.
 */

/** API key / masquerade / key-simulation tokens, a pasted Authorization header. */
const CREDENTIAL_PREFIX_RE = /^(?:nvk|nvm|nvq)_|^bearer\s/i
/** A long opaque run (static tokens are 64 hex): treated as a secret. */
const OPAQUE_RE = /^[A-Za-z0-9_+/=-]{32,}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const CREDENTIAL_MESSAGE =
  'That looks like a credential. Search never looks up API keys or tokens — search by the key name, its owner or a request instead. Nothing was sent.'

/**
 * Should this search entry stay on the client? A credential never leaves the browser: the API
 * log keeps request query strings, and a search box is not a secret field.
 */
export function looksLikeCredential(raw: string): boolean {
  const q = raw.trim()
  if (!q) return false
  if (CREDENTIAL_PREFIX_RE.test(q)) return true
  if (UUID_RE.test(q)) return false
  return OPAQUE_RE.test(q)
}

/** Left / width percentages of one waterfall bar (min width so a 0 ms call stays visible). */
export function barGeometry(
  offsetMs: number,
  ms: number,
  totalMs: number
): { left: number; width: number } {
  const total = Math.max(1, totalMs)
  const left = Math.min(100, Math.max(0, (offsetMs / total) * 100))
  const width = Math.max(0.6, Math.min(100 - left, (Math.max(0, ms) / total) * 100))
  return { left: round1(left), width: round1(width) }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export const WINDOW_CHOICES = [60, 300, 900, 3600] as const

/** "±5 min" / "±90 s" / "±2 h". */
export function windowText(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '±5 min'
  if (sec < 60) return `±${Math.round(sec)} s`
  if (sec <= 3600 || sec % 3600 !== 0) return `±${Math.round(sec / 60)} min`
  return `±${sec / 3600} h`
}

/** The page's own ring holds the last 15 minutes: can the map rewind to `ms`? */
export const MAP_RING_MS = 15 * 60_000
export function canRewindTo(ms: number | null | undefined, now = Date.now()): boolean {
  if (ms == null || !Number.isFinite(ms)) return false
  return now - ms <= MAP_RING_MS && ms <= now + 5_000
}

/** Duration with its unit ("558 ms", "1.2 s", "—"). */
export function fmtDur(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`
}

function isTyping(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const t = el.tagName
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT'
}

/**
 * The Traffic Map page "has focus" when focus sits inside it, or nothing is focused and the last
 * click landed inside it. Elsewhere the admin-wide keys (`/`, ⌘K → command palette) keep working.
 */
export function pageHasFocus(
  active: Element | null,
  lastPointerInPage: boolean,
  root = '.traffic-map'
): boolean {
  if (!active || active === document.body || active === document.documentElement)
    return lastPointerInPage
  return !!active.closest(root)
}

/** `/` only while not typing; ⌘K / Ctrl-K anywhere (when the page has focus). */
export function searchKey(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>
): 'slash' | 'mod-k' | null {
  if (e.altKey) return null
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return 'mod-k'
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !isTyping(e.target as Element | null))
    return 'slash'
  return null
}

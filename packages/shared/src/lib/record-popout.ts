/**
 * Pop out a record (#2131): the record opens in its own browser window for
 * side-by-side work on two screens. The window is a normal authenticated
 * route of the host app — the cookie session (or, for a "View as" tab, the
 * per-tab session storage the browser copies into a window it opens) signs
 * it in; nothing secret rides the URL, which only gains `?popout=1` so the
 * host can drop its navigation chrome.
 *
 * Staying live needs nothing new: the window runs the same record page, so
 * presence, remote changes and locks arrive as they do in any tab, and
 * record-tabs.ts keeps it in step with the main tab (saves, unsaved edits,
 * the edit lock).
 */

export const POPOUT_PARAM = 'popout'
const WINDOW_PREFIX = 'nvr-record:'

/** The href with `popout=1` added (hash kept). */
export function recordPopoutHref(href: string): string {
  const hashAt = href.indexOf('#')
  const base = hashAt >= 0 ? href.slice(0, hashAt) : href
  const hash = hashAt >= 0 ? href.slice(hashAt) : ''
  if (new RegExp(`[?&]${POPOUT_PARAM}=1(&|$)`).test(base)) return href
  return `${base}${base.includes('?') ? '&' : '?'}${POPOUT_PARAM}=1${hash}`
}

/** Is this window a popped-out record? */
export function isRecordPopout(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get(POPOUT_PARAM) === '1') return true
    return window.name.startsWith(WINDOW_PREFIX)
  } catch {
    return false
  }
}

/**
 * Open (or bring forward) the record's pop-out window. One window per record:
 * popping the same record out again focuses the window already showing it.
 * Returns false when the browser blocked the window.
 */
export function openRecordPopout(href: string, collection: string, itemId: string): boolean {
  if (typeof window === 'undefined') return false
  const w = Math.min(1280, Math.max(720, Math.round(window.screen?.availWidth * 0.6) || 1100))
  const h = Math.min(1000, Math.max(600, Math.round(window.screen?.availHeight * 0.85) || 900))
  const left = Math.max(0, (window.screenX ?? 0) + (window.outerWidth ?? w) - Math.round(w / 2))
  const top = Math.max(0, (window.screenY ?? 0) + 40)
  // Not `noopener`: the browser copies this tab's session storage into a
  // window it opens, which is what keeps a "View as" tab's pop-out signed in
  // as the person being viewed rather than as the admin.
  const win = window.open(
    recordPopoutHref(href),
    `${WINDOW_PREFIX}${collection}:${itemId}`,
    `popup=yes,width=${w},height=${h},left=${left},top=${top}`
  )
  if (!win) return false
  try {
    win.focus()
  } catch {
    /* focus is a nicety */
  }
  return true
}

/** From a popped-out window: bring the window that opened it forward. */
export function focusPopoutOpener(): boolean {
  try {
    const o = window.opener as Window | null
    if (!o || o.closed) return false
    o.focus()
    return true
  } catch {
    return false
  }
}

// Where a sign-in may send someone afterwards — the ONE check for every sign-in
// path (admin App routes, the login page's password / TOTP / token forms and
// the IdP returnTo). Security audit 2026-10-27: a crafted
// `/login?redirect=/api/…` link must not walk someone from sign-in into a GET
// of the sender's choosing with their fresh session.
//
// Allowlist: an SPA path (anything outside the server's root prefixes), or one
// of the listed server return pages. Everything else lands on '/'.

export const POST_LOGIN_KEY = 'nivaro_post_login_redirect'

/** Root-level paths the API server answers itself (not the SPA). */
const SERVER_PREFIXES = ['api', 'oauth', '.well-known', 'share', 'form', 'status', 'socket.io']

/** The server pages a sign-in may return to. */
const SERVER_RETURN_PATHS = [
  /^\/oauth\/authorize(?:[?#]|$)/i, // AI app consent (routes/oauth.ts signInUrl)
  /^\/api\/message-actions\/callback(?:[?#]|$)/i, // Teams/email approve link confirm page
  /^\/api\/teams\/connect(?:[?#]|$)/i // Teams bot account link
]

/** Slash / backslash smuggling: a backslash, an encoded slash or backslash, or
 *  a protocol-relative start, anywhere in the raw value. */
const SMUGGLED = /\\|%2f|%5c|^\s*\/\s*\//i

/** A same-origin path (pathname + search + hash), else the fallback. */
export function safeRedirectPath(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    return fallback
  }
}

/** A path the API server answers (one of its root prefixes, or a file such as
 *  /widget.js) — it must be a full page load, never a client-side navigation. */
export function isServerPath(path: string): boolean {
  const pathname = path.split(/[?#]/)[0]
  const first = (pathname.split('/')[1] ?? '').toLowerCase()
  if (SERVER_PREFIXES.includes(first)) return true
  // A file with an extension (/presence.js, /assets/x.css, /favicon.ico).
  return /\.[a-z0-9]{1,8}$/i.test(pathname)
}

/** Where a sign-in may land: an SPA path, or a listed server page; else '/'. */
export function postLoginTarget(raw: string | null | undefined): string {
  if (!raw || SMUGGLED.test(raw)) return '/'
  const target = safeRedirectPath(raw)
  if (SMUGGLED.test(target)) return '/'
  if (!isServerPath(target)) return target
  return SERVER_RETURN_PATHS.some((re) => re.test(target)) ? target : '/'
}

/** True on the login page (case-insensitive, trailing slashes ignored). */
export function isLoginPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '').toLowerCase() === '/login'
}

/** Store a post-login target only after it passes postLoginTarget. */
export function rememberPostLoginTarget(raw: string | null | undefined): void {
  try {
    if (raw && postLoginTarget(raw) !== '/') sessionStorage.setItem(POST_LOGIN_KEY, raw)
  } catch {
    /* storage blocked */
  }
}

/** Read (and forget) the stored target, checked. */
export function takePostLoginTarget(): string {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(POST_LOGIN_KEY)
    sessionStorage.removeItem(POST_LOGIN_KEY)
  } catch {
    /* storage blocked */
  }
  return postLoginTarget(raw)
}

/** On the login page with a `redirect` that postLoginTarget refuses: the same
 *  URL without it (and any refused stored copy cleared). Null when there is
 *  nothing to drop. */
export function refusedLoginRedirect(): string | null {
  try {
    const stored = sessionStorage.getItem(POST_LOGIN_KEY)
    if (stored && postLoginTarget(stored) === '/' && safeRedirectPath(stored) !== '/')
      sessionStorage.removeItem(POST_LOGIN_KEY)
  } catch {
    /* storage blocked */
  }
  if (!isLoginPath(window.location.pathname)) return null
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('redirect')
  if (!raw || postLoginTarget(raw) !== '/' || raw === '/') return null
  params.delete('redirect')
  const rest = params.toString()
  return `${window.location.pathname}${rest ? `?${rest}` : ''}`
}

// Where a sign-in may send someone afterwards (admin App routes + /login).

/** A same-origin path (pathname + search + hash), else the fallback. */
export function safeRedirectPath(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw
    return fallback
  }
}

/** A post-login target the SPA does not route (the OAuth consent page, an API
 *  URL) — it must be a full page load, not a client-side navigation. */
export const isServerPath = (path: string) => /^\/(oauth|api)(\/|$)/i.test(path)

/** The server pages a sign-in may return to. Any other API URL is refused
 *  (security audit 2026-10-27): a crafted `/login?redirect=/api/…` link would
 *  otherwise send someone straight from sign-in into a GET of the attacker's
 *  choosing, with their fresh session. */
const SERVER_RETURN_PATHS = [
  /^\/oauth\/authorize(?:[?#]|$)/i, // AI app consent (routes/oauth.ts signInUrl)
  /^\/api\/message-actions\//i, // Teams/email approve links: sign in, then confirm
  /^\/api\/teams\/connect(?:[?#]|$)/i // Teams bot account link
]

/** Where a sign-in may land: a same-origin path, and a server path only when listed. */
export function postLoginTarget(raw: string | null | undefined): string {
  const target = safeRedirectPath(raw)
  if (isServerPath(target) && !SERVER_RETURN_PATHS.some((re) => re.test(target))) return '/'
  return target
}

/** On /login with a `redirect` that postLoginTarget refuses: the same URL
 *  without it (and any stored copy cleared). Null when there is nothing to drop. */
export function refusedLoginRedirect(): string | null {
  try {
    const stored = sessionStorage.getItem('nivaro_post_login_redirect')
    if (stored && postLoginTarget(stored) !== safeRedirectPath(stored))
      sessionStorage.removeItem('nivaro_post_login_redirect')
  } catch {
    /* storage blocked */
  }
  if (window.location.pathname !== '/login') return null
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('redirect')
  if (!raw || postLoginTarget(raw) === safeRedirectPath(raw)) return null
  params.delete('redirect')
  const rest = params.toString()
  return `/login${rest ? `?${rest}` : ''}`
}

/**
 * Per-tab "View as" (#640). The admin app is a cookie-session app, and a
 * cookie is shared by every tab — so viewing as someone else cannot change
 * the session. Instead a new tab carries a short-lived masquerade token
 * (POST /auth/masquerade, 4h, activity-logged) in sessionStorage, which is
 * per tab: every request THIS tab makes rides `Authorization: Bearer nvm_…`
 * (authenticate() checks a bearer before the cookie), and every other tab
 * stays signed in as the admin.
 *
 * The token arrives in the URL fragment (`#masq=…`) — a fragment never
 * reaches a server or an access log — and is removed from the address bar
 * the moment it is read.
 *
 * This file has NO imports: lib/masquerade-boot.ts runs it before any other module (an SDK
 * client keeps the fetch it was created with, and modules create theirs at import time).
 */

export const MASQUERADE_KEY = 'nvr_masq'
const KEY = MASQUERADE_KEY

export interface MasqueradeTab {
  token: string
  name: string
  user_id: string
}

export function readMasquerade(): MasqueradeTab | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as MasqueradeTab
    return v?.token?.startsWith('nvm_') ? v : null
  } catch {
    return null
  }
}

/**
 * A popped-out record (#2131) opened from a "View as" tab is that same
 * person: browsers copy the opener's session storage into a window it opens,
 * and where one does not, the opener (same origin only) still has the token.
 * Only a pop-out adopts it — any other window opened from a View-as tab stays
 * the admin.
 */
function adoptOpenerMasquerade(): void {
  try {
    if (readMasquerade()) return
    const isPopout =
      new URLSearchParams(window.location.search).get('popout') === '1' ||
      window.name.startsWith('nvr-record:')
    if (!isPopout || !window.opener) return
    const raw = (window.opener as Window).sessionStorage.getItem(KEY)
    if (raw) sessionStorage.setItem(KEY, raw)
  } catch {
    /* cross-origin opener or blocked storage: the window opens as the cookie session */
  }
}

/** Run once at boot, before anything fetches. */
export function captureMasqueradeFromHash(): void {
  if (typeof window === 'undefined') return
  adoptOpenerMasquerade()
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash.includes('masq=')) return
  const params = new URLSearchParams(hash)
  const token = params.get('masq')
  if (token?.startsWith('nvm_')) {
    try {
      sessionStorage.setItem(
        KEY,
        JSON.stringify({
          token,
          name: params.get('name') ?? '',
          user_id: params.get('uid') ?? ''
        } satisfies MasqueradeTab)
      )
    } catch {
      /* private mode: the tab simply opens as the admin */
    }
  }
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`
  )
}

function sameOriginApi(input: RequestInfo | URL): boolean {
  try {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin
    )
    return (
      url.origin === window.location.origin && /^\/(api|graphql|files)(\/|$)/.test(url.pathname)
    )
  } catch {
    return false
  }
}

/**
 * Every fetch() this tab makes to its own API carries the masquerade bearer —
 * the SDK clients, the widget renderers and raw fetches alike. A request that
 * already names an Authorization header (the Playground's own token) is left
 * alone. axios adds it in lib/api.ts.
 */
export function installMasqueradeFetch(): void {
  const m = readMasquerade()
  if (!m || typeof window === 'undefined') return
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!sameOriginApi(input)) return original(input, init)
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${m.token}`)
    return original(input, { ...init, headers })
  }
}

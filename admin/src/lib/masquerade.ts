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
 */

const KEY = 'nvr_masq'

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

/** Run once at boot, before anything fetches. */
export function captureMasqueradeFromHash(): void {
  if (typeof window === 'undefined') return
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

/** Revoke the token and leave: close the tab, or land back as the admin. */
export async function stopMasquerade(): Promise<void> {
  const m = readMasquerade()
  try {
    if (m) {
      await fetch('/api/auth/masquerade', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${m.token}` }
      })
    }
  } catch {
    /* the token expires on its own within four hours */
  }
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  window.close()
  // A tab the script did not open cannot close itself — reload as the admin.
  window.location.href = '/'
}

/**
 * Mint a token and open a new tab on it. The tab is opened BEFORE the request
 * (a window.open after an await is a popup a browser may block) and pointed
 * at the app once the token is back.
 */
export async function openViewAsTab(person: { id: string; name: string }): Promise<void> {
  const tab = window.open('about:blank', '_blank')
  try {
    const current = readMasquerade()
    const res = await fetch('/api/auth/masquerade', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        // From inside a view-as tab the admin cookie still identifies the admin;
        // never mint from the masqueraded identity.
        ...(current ? { authorization: '' } : {})
      },
      body: JSON.stringify({ user_id: person.id })
    })
    const body = (await res.json().catch(() => ({}))) as {
      data?: { token?: string }
      error?: string
    }
    if (!res.ok || !body.data?.token) throw new Error(body.error ?? 'Could not start View as')
    const frag = new URLSearchParams({
      masq: body.data.token,
      name: person.name,
      uid: person.id
    }).toString()
    const url = `${window.location.origin}/#${frag}`
    if (tab) tab.location.href = url
    else window.open(url, '_blank')
  } catch (err) {
    tab?.close()
    throw err
  }
}

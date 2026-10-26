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

import { clearRecordOutboxFor } from '@nivaro/shared'
import { MASQUERADE_KEY as KEY, readMasquerade } from './masquerade-core'

export {
  captureMasqueradeFromHash,
  installMasqueradeFetch,
  type MasqueradeTab,
  readMasquerade
} from './masquerade-core'

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
  // Nothing queued under the viewed person may outlive the View-as tab.
  if (m?.user_id) await clearRecordOutboxFor(m.user_id).catch(() => {})
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

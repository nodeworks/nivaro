/**
 * First-party phone apps that sign in through the OAuth server (routes/oauth.ts). Unlike MCP
 * clients they are not registered dynamically: the official Nivaro app is built in and an
 * operator adds their own builds with env, never code:
 *
 *   MOBILE_APP_CLIENTS=client_id|Name|redirect_uri[,redirect_uri];client_id|Name|redirect_uri
 *   MOBILE_SIGNIN=off   no phone sign-in (independent of MCP_OAUTH)
 *
 * A mobile app returns to its own URL scheme (`dev.nivaro.app:/oauth/callback`), so its redirect
 * URIs are matched exactly, never by the https/loopback rules dynamic clients follow.
 */

export interface MobileClient {
  client_id: string
  client_name: string
  redirect_uris: string[]
}

export type DevicePlatform = 'ios' | 'android'

const BUILT_IN: MobileClient = {
  client_id: 'nivaro-mobile',
  client_name: 'Nivaro',
  redirect_uris: ['dev.nivaro.app:/oauth/callback']
}

/** A registry id: short, plain, and never shaped like a dynamic client's (`nvc_…`). */
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/

/** Schemes that can never carry an authorization code back to an app. */
const REFUSED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'])

const printable = (s: string) =>
  [...s]
    .filter((c) => {
      const code = c.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .trim()

function acceptableRedirect(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (raw.includes('#') || u.username || u.password) return false
  if (REFUSED_SCHEMES.has(u.protocol) || u.protocol === 'http:') return false
  return true
}

function parseEntry(entry: string): MobileClient | null {
  const parts = entry.split('|')
  if (parts.length !== 3) return null
  const client_id = parts[0].trim()
  const client_name = printable(parts[1]).slice(0, 80)
  const redirect_uris = parts[2]
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  if (!CLIENT_ID.test(client_id) || client_id.startsWith('nvc_')) return null
  if (!client_name || redirect_uris.length === 0 || !redirect_uris.every(acceptableRedirect))
    return null
  return { client_id, client_name, redirect_uris }
}

/** The built-in app, then every well-formed MOBILE_APP_CLIENTS entry (first id wins). */
export function mobileClients(): MobileClient[] {
  const out: MobileClient[] = [BUILT_IN]
  for (const entry of (process.env.MOBILE_APP_CLIENTS ?? '').split(';')) {
    const c = entry.trim() ? parseEntry(entry) : null
    if (c && !out.some((o) => o.client_id === c.client_id)) out.push(c)
  }
  return out
}

export function mobileClient(clientId: string): MobileClient | null {
  if (!clientId) return null
  return mobileClients().find((c) => c.client_id === clientId) ?? null
}

/** Exact string match only — no port, path, query or case leeway. */
export function isMobileRedirect(client: MobileClient, uri: string): boolean {
  return !!uri && client.redirect_uris.includes(uri)
}

export function mobileSignInEnabled(): boolean {
  return (process.env.MOBILE_SIGNIN ?? '').trim().toLowerCase() !== 'off'
}

/** The device name an app sends on authorize, safe to store and show (≤ 60 characters). */
export function cleanDeviceName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  return printable(raw).slice(0, 60).trim() || undefined
}

export function devicePlatform(raw: unknown): DevicePlatform | undefined {
  return raw === 'ios' || raw === 'android' ? raw : undefined
}

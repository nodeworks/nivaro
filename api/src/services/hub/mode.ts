import { isMultiTenant } from '../deployment-mode.js'

/**
 * Nivaro Hub mode (env only):
 *   HUB=on|true|1   this install is a Hub (routes, nav, tables); off by default, never in cloud mode
 *   HUB_TOKEN=…     bearer an app presents on /api/hub-link/*; ignored under 32 characters
 */
export function hubModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isMultiTenant(env)) return false
  const v = (env.HUB ?? '').trim().toLowerCase()
  return v === 'on' || v === 'true' || v === '1'
}

export function hubLinkToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = (env.HUB_TOKEN ?? '').trim()
  return t.length >= 32 ? t : null
}

const HUB_URL_LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Hub phase 7 (sign-in through the Hub): the origin of `HUB_URL`, the Hub this app signs in
 * through (phase 5 reads the same variable for its tenant list). https only; plain http only for
 * a loopback host outside production. Null when unset, malformed, carrying a user or password,
 * or in cloud mode.
 */
export function hubUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLOUD_META_DB_URL) return null
  const raw = (env.HUB_URL ?? '').trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.username || u.password) return null
  if (u.protocol === 'https:') return u.origin
  if (
    u.protocol === 'http:' &&
    env.NODE_ENV !== 'production' &&
    HUB_URL_LOOPBACK.has(u.hostname.toLowerCase())
  )
    return u.origin
  return null
}

import { hubUrlOrigin, isMultiTenant } from '../deployment-mode.js'

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

/**
 * Hub phase 7 (sign-in through the Hub, the app switcher): the origin of `HUB_URL`, the Hub this
 * app signs in through. ONE HUB_URL rule for every reader (ruling P5-17): hubUrlOrigin() in
 * services/deployment-mode.ts (origin only, no user or password, plain http only for a loopback
 * host outside production; a refused value counts as unset). Null on any multi-tenant deployment
 * (cloud mode or a Hub shared deployment): a shared deployment always has HUB_URL for its tenant
 * list, and that must not switch Hub sign-in or the switcher on for every app it serves.
 */
export function hubUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isMultiTenant(env)) return null
  return hubUrlOrigin(env)
}

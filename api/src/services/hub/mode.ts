import { hubUrlOrigin, isMultiTenant, tenantSource } from '../deployment-mode.js'
import { currentAppHubLink } from '../tenancy/app-hub-links.js'

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
 * list, and that must not switch Hub sign-in or the switcher on for every app it serves. There,
 * each app's own link comes from the tenant list: appHubLink() below and hubSigninConfig().
 */
export function hubUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isMultiTenant(env)) return null
  return hubUrlOrigin(env)
}

/**
 * The Hub link of the app being served, for its sign-in reports and the app switcher: the Hub's
 * origin and the bearer the app presents there (its environment's hub token).
 *
 *  - dedicated app: HUB_URL (hubUrl) + HUB_TOKEN (hubLinkToken), as before;
 *  - Hub shared deployment: the deployment's HUB_URL (the Hub that lists its apps) + the current
 *    app's own token from the Hub's tenant list (tenancy/app-hub-links.ts); null outside an app
 *    or for an app the Hub gave no token. HUB_TOKEN on a shared deployment is never an app's;
 *  - Nivaro Cloud: null.
 */
export function appHubLink(
  env: NodeJS.ProcessEnv = process.env
): { hub: string; token: string } | null {
  if (tenantSource(env) === 'hub') {
    const hub = hubUrlOrigin(env)
    const token = currentAppHubLink(env)?.token ?? null
    return hub && token ? { hub, token } : null
  }
  const hub = hubUrl(env)
  const token = hubLinkToken(env)
  return hub && token ? { hub, token } : null
}

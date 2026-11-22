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

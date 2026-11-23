import { config } from '../../config.js'
import { tenantOrigin } from '../../db/tenant-context.js'
import { perAppJobs } from '../deployment-mode.js'

/**
 * Where people reach this app, without a trailing slash: PUBLIC_URL self-hosted (as before), the
 * app's own listed origin on a Hub shared deployment, never the shared process's address. '' when
 * a shared app has none here (outside an app): callers then build a same-origin path.
 */
export function teamsBotOrigin(): string {
  const origin = perAppJobs() ? (tenantOrigin() ?? '') : config.PUBLIC_URL
  return origin.replace(/\/$/, '')
}

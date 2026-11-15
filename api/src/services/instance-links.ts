import { adminBaseUrl } from '../admin-base.js'
import { config } from '../config.js'
import { tenantOrigin } from '../db/tenant-context.js'

/**
 * Absolute link bases for addresses this instance hands out (approval links, status pages,
 * sign-in redirects). In cloud mode the current tenant's verified origin (its own subdomain or
 * active custom domain, else its canonical origin — db/tenant-context.ts), never PUBLIC_URL /
 * ADMIN_URL, which name the shared process. Self-hosted: the configured addresses.
 */

const trim = (u: string) => u.replace(/\/$/, '')

/** Where `/api/*` and the root public pages (`/form-status/…`) are reached. */
export function publicLinkBase(): string {
  return trim(tenantOrigin() ?? config.PUBLIC_URL)
}

/** Where the admin app's pages (`/collections/…`) are reached. */
export function adminLinkBase(): string {
  return trim(tenantOrigin() ?? adminBaseUrl() ?? config.ADMIN_URL)
}

/** Every origin this instance is served on (for an Origin-header check). In cloud mode only the
 *  current tenant's own origin — another tenant's page is never "us". */
export function ownOrigins(): string[] {
  const tenant = tenantOrigin()
  const out: string[] = []
  const raws = tenant ? [tenant] : [config.PUBLIC_URL, config.ADMIN_URL, adminBaseUrl()]
  for (const raw of raws) {
    if (!raw) continue
    try {
      const o = new URL(raw).origin
      if (o !== 'null' && !out.includes(o)) out.push(o)
    } catch {
      /* not a URL */
    }
  }
  return out
}

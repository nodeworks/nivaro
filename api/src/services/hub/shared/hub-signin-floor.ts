import { compareVersions } from '../promote-plan.js'

/**
 * Sign-in through the Hub per app on a shared deployment: from this version a shared deployment
 * takes each app's own Hub client, hub token and Microsoft audience from the tenant list
 * (services/hub/shared/tenant-hub-link.ts → tenancy/app-hub-links.ts), so an app in `hub` mode
 * may be placed on it or moved onto it. Before it, such an app is refused (SIGNIN_VIA_HUB).
 */
export const SHARED_HUB_SIGNIN_SINCE = '0.3.215'

/**
 * The deployment runs SHARED_HUB_SIGNIN_SINCE or later. A version the Hub cannot read (none, not
 * x.y.z) is taken as older, and so is a pre-release of that version: the safe side refuses.
 */
export function runsSharedHubSignin(version: string | null | undefined): boolean {
  const m = /^v?(\d+\.\d+\.\d+)(.*)$/.exec((version ?? '').trim())
  if (!m) return false
  const c = compareVersions(m[1], SHARED_HUB_SIGNIN_SINCE)
  return c > 0 || (c === 0 && !m[2].startsWith('-'))
}

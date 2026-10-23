import { clientVersion, reloadCountFor } from './client-version'
import { serverClockOffset } from './server-clock'

/**
 * Sticky force refresh — the client half of api/src/services/sticky-refresh.ts.
 *
 * The server pushes `client:force-refresh` live, again when a tab that missed it connects, and
 * whenever a tab connects below an app's minimum build. A browser's shared worker carries every
 * tab of an app on ONE socket and reports the first tab's build, so a push meant for an old tab
 * can reach a newer one: each tab checks for itself here before counting down.
 */

/** What `client:force-refresh` carries. Everything after `message` is optional (older servers). */
export interface ForceReloadDetail {
  seconds?: number
  message?: string
  id?: string
  issued_at?: number
  reason?: 'push' | 'sticky' | 'min-build'
  min_build?: string
  set_at?: number
}

/** A tab reloads at most this often for one minimum-build rule (a cached bundle stays old). */
export const MIN_BUILD_RELOADS = 2

const VERSION_RE = /^v?(\d+(?:\.\d+){0,3})(?:[-+][\w.+-]*)?$/i

function judgeable(v: string | null | undefined): v is string {
  return !!v && v !== 'dev' && !v.startsWith('0.0.0')
}

/** Twin of api/src/services/sticky-refresh.ts compareBuilds — change both. */
export function compareBuilds(a: string, b: string): number | null {
  const ma = VERSION_RE.exec(a.trim())
  const mb = VERSION_RE.exec(b.trim())
  if (!ma || !mb) return null
  const pa = ma[1].split('.').map(Number)
  const pb = mb[1].split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Twin of api/src/services/sticky-refresh.ts buildBelow — change both. */
export function buildBelow(
  build: string | null | undefined,
  min: string,
  loaded: number | null | undefined,
  setAt: number
): boolean {
  if (!judgeable(build) || !judgeable(min)) return false
  const cmp = compareBuilds(build, min)
  if (cmp != null) return cmp < 0
  return build !== min && loaded != null && loaded < setAt
}

/**
 * Should this tab count down for `detail`? `me` = this tab's build and page-load time on the
 * SERVER's clock; `count` = how often it already reloaded for an id.
 */
export function shouldObeyForceReload(
  detail: ForceReloadDetail,
  me: { build: string | null; loaded: number },
  count: (id: string) => number = reloadCountFor
): boolean {
  const id = typeof detail.id === 'string' && detail.id ? detail.id : null
  if (!id) return true // an older server: every push is obeyed, as before
  if (detail.reason === 'min-build') {
    if (count(id) >= MIN_BUILD_RELOADS) return false
    if (typeof detail.min_build === 'string' && typeof detail.set_at === 'number')
      return buildBelow(me.build, detail.min_build, me.loaded, detail.set_at)
    return true
  }
  if (count(id) >= 1) return false
  // A remembered instruction reaches a tab that loaded after it only through a shared worker.
  if (detail.reason === 'sticky' && typeof detail.issued_at === 'number')
    return me.loaded < detail.issued_at
  return true
}

/** This tab, as the server would judge it (page-load time moved onto the server's clock). */
export function thisTabForReload(): { build: string | null; loaded: number } {
  const v = clientVersion()
  return { build: v.build, loaded: v.loaded + serverClockOffset() }
}

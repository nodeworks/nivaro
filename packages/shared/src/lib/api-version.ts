import { useSyncExternalStore } from 'react'

/**
 * Detects that the Nivaro API has been redeployed since this tab loaded.
 *
 * The baseline is the version the API reported the FIRST time this tab asked,
 * not a build-time constant: the API and the frontend ship separately, so an
 * API-only deploy has to be detectable by a bundle that never changed. (A
 * frontend's own redeploy is a different signal — efp-new's version.ts owns
 * that one, and the two banners are independent on purpose.)
 *
 * Environment scoping is structural rather than configured: a tab polls the
 * API origin it was served from, so staging tabs learn about staging deploys
 * and production tabs about production ones. A staging deploy cannot reach
 * production's users. `environment` is reported anyway so the message can name
 * which environment moved.
 *
 * Clearing is structural too: after a reload the tab re-reads the baseline
 * from the API it just talked to, the two agree, and nothing renders. There is
 * no dismissal flag to store or expire.
 */

const POLL_MS = 60_000

export interface ApiVersionInfo {
  version: string
  environment?: string
}

type Fetcher = () => Promise<ApiVersionInfo | null>

let baseline: string | null = null
let updateInfo: ApiVersionInfo | null = null
const listeners = new Set<() => void>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let checking = false
let fetcher: Fetcher | null = null
let watching = false

const emit = (next: ApiVersionInfo | null) => {
  if (next?.version === updateInfo?.version) return
  updateInfo = next
  for (const l of listeners) l()
}

/**
 * Poll once. Silent on failure: an unreachable API is an outage, and hosts
 * already surface connectivity separately — announcing a deploy on the
 * strength of a failed request would be a lie.
 */
export async function checkApiVersion(): Promise<void> {
  if (checking || updateInfo || !fetcher) return
  checking = true
  try {
    const info = await fetcher()
    const served = typeof info?.version === 'string' ? info.version : null
    // A dev placeholder never triggers the banner — a local API that cannot
    // resolve its version would otherwise nag on every restart.
    if (!served || served.startsWith('0.0.0')) return
    if (baseline === null) {
      baseline = served
      return
    }
    // Latched on purpose — never cleared back. A rolling update can serve the
    // new and old build on consecutive polls, and a flickering banner is worse
    // than a sticky one. A rollback counts too: the served build still is not
    // the one running here, so reloading is still the right move.
    if (served !== baseline) emit({ version: served, environment: info?.environment })
  } catch {
    // ignored — see above
  } finally {
    checking = false
  }
}

const stop = () => {
  if (pollTimer == null) return
  clearInterval(pollTimer)
  pollTimer = null
}

const start = () => {
  if (pollTimer != null || updateInfo) return
  pollTimer = setInterval(() => void checkApiVersion(), POLL_MS)
}

function onVisibility() {
  if (document.visibilityState === 'visible') {
    void checkApiVersion()
    start()
  } else {
    stop()
  }
}

/**
 * Idempotent; safe from an effect that runs more than once, and safe to call
 * from several components — only the first call arms the timer.
 */
export function startApiVersionWatch(fetchVersion: Fetcher): void {
  // Fetcher first: it must be usable even where there is no window (tests,
  // SSR), otherwise a manual checkApiVersion() silently no-ops.
  fetcher = fetchVersion
  if (typeof window === 'undefined') return
  if (watching) return
  watching = true
  // A backgrounded tab polls nothing; on return it checks at once rather than
  // making someone wait out the interval to learn the API moved on.
  document.addEventListener('visibilitychange', onVisibility)
  if (document.visibilityState === 'visible') {
    void checkApiVersion()
    start()
  }
}

/** The newer API build being served, or null while this tab is current. */
export function getApiUpdate(): ApiVersionInfo | null {
  return updateInfo
}

export function useApiUpdate(): ApiVersionInfo | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getApiUpdate,
    getApiUpdate
  )
}

/** Test seam — resets the module-level latch between cases. */
export function __resetApiVersionWatch(): void {
  baseline = null
  updateInfo = null
  checking = false
  watching = false
  fetcher = null
  stop()
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

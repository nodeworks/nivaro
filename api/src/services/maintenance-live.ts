import { registerAppKeyed } from './app-forget.js'
import { isMultiTenant } from './deployment-mode.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * rt4 #13 — maintenance starts, ends or changes its notice: open tabs hear it at once.
 *
 * Maintenance is read through `maintenanceState()` (services/security.ts): a Redis override a
 * rebuild job sets and deletes from outside the app, else the settings row an admin or a
 * scheduled window writes. Every successful read is handed to `observeMaintenance`; when what
 * people would see moved (on/off, page or strip, expected end, wording) a payload-free
 * `announcements:changed` goes to the tenant's signed-in sockets — the same notice banners use
 * — and each tab re-reads GET /announcements/active as itself. The full maintenance page then
 * hands the app back the moment the freeze lifts, instead of on its next 30 s poll.
 *
 * Who notices:
 *   - a write in this process (settings PATCH, window sweep, End maintenance) busts the cache;
 *     `recheckMaintenanceSoon` reads again a moment later and announces, then once more after
 *     the other replicas' 15 s caches ran out (their tabs may re-read from them);
 *   - the override changing outside the app (golive script `DEL nvr:maintenance`): while this
 *     process last saw maintenance ON it re-reads every WATCH_MS (one Redis GET, plus the
 *     settings row when there is no override) — self-hosted only; in cloud mode module timers
 *     would be shared by every tenant, and no rebuild job sets the override there.
 * A failed read (database offline mid-rebuild) is never observed, so it never reads as "over".
 */

export interface ObservedMaintenance {
  on: boolean
  display?: string | null
  until?: string | null
  message?: string | null
}

const WATCH_MS = 5_000
/** Other replicas' maintenanceState cache (15 s) plus a little. */
const SECOND_ANNOUNCE_MS = 16_000
const RECHECK_MS = 250

const lastSeen = registerAppKeyed(new Map<string, string>())
const lastOn = registerAppKeyed(new Map<string, boolean>())
let watchTimer: ReturnType<typeof setInterval> | null = null

type Announce = () => void
let announceImpl: Announce = () => {
  void import('./record-events.js')
    .then((m) => m.announceToTenant('announcements:changed', { maintenance: true }))
    .catch(() => {})
}
type Read = () => Promise<unknown>
let readImpl: Read = async () => {
  const m = await import('./security.js')
  // Only the tenant this read is for: busting every tenant's entry made one app's watch or
  // recheck re-read every other app's maintenance state on a multi-tenant process.
  m.bustMaintenanceCache(currentTenantKey())
  return m.maintenanceState()
}

/** What people see of a maintenance state, as one comparable string. Exported for tests. */
export function maintenanceSignature(s: ObservedMaintenance): string {
  if (!s.on) return 'off'
  return ['on', s.display ?? 'banner', s.until ?? '', (s.message ?? '').trim()].join('|')
}

/**
 * A successful maintenance read. Announces when it differs from the last one this process
 * saw for the tenant (the first read only sets the baseline). Returns true when it announced.
 */
export function observeMaintenance(s: ObservedMaintenance, tenant = currentTenantKey()): boolean {
  const sig = maintenanceSignature(s)
  const prev = lastSeen.get(tenant)
  lastSeen.set(tenant, sig)
  lastOn.set(tenant, !!s.on)
  if (lastSeen.size > 5000) {
    lastSeen.clear()
    lastOn.clear()
  }
  syncWatch()
  if (prev === undefined || prev === sig) return false
  announceImpl()
  return true
}

/** Read again shortly after this process wrote maintenance (the cache was just busted). */
const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
export function recheckMaintenanceSoon(): void {
  const tenant = currentTenantKey()
  if (recheckTimers.has(tenant)) return
  const t = setTimeout(() => {
    recheckTimers.delete(tenant)
    const before = lastSeen.get(tenant)
    void readImpl()
      .then(() => {
        // The read observed (and, on a change, announced). Tabs that re-read from a replica
        // still holding the old state are covered by one more notice after its cache expires.
        const after = lastSeen.get(tenant)
        if (before === undefined || after === undefined || before === after) return
        const later = setTimeout(() => announceImpl(), SECOND_ANNOUNCE_MS)
        later.unref?.()
      })
      .catch(() => {})
  }, RECHECK_MS)
  t.unref?.()
  recheckTimers.set(tenant, t)
}

/** Self-hosted: while maintenance was last seen ON, look again every WATCH_MS. */
function syncWatch(): void {
  if (isMultiTenant()) return
  const anyOn = [...lastOn.values()].some(Boolean)
  if (anyOn && !watchTimer) {
    watchTimer = setInterval(() => {
      void readImpl().catch(() => {})
    }, WATCH_MS)
    watchTimer.unref?.()
  } else if (!anyOn && watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
}

/** Stop the watch (server close, tests). */
export function stopMaintenanceWatch(): void {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = null
  for (const t of recheckTimers.values()) clearTimeout(t)
  recheckTimers.clear()
}

/** Tests: replace the announce / read seams and forget what was seen. */
export function _resetMaintenanceLive(seams: { announce?: Announce; read?: Read } = {}): void {
  stopMaintenanceWatch()
  lastSeen.clear()
  lastOn.clear()
  if (seams.announce) announceImpl = seams.announce
  if (seams.read) readImpl = seams.read
}

/** Tests: whether the watch is running. */
export function _maintenanceWatching(): boolean {
  return watchTimer != null
}

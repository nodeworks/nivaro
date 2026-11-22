import { currentTenantKey } from './tenant-rooms.js'

/**
 * Keys for module caches that hold one app's data (Hub phase 6). One shared-deployment process
 * serves many apps, and two of them may hold the same collection names and record ids (dev = a
 * copy of prod): a cache keyed by those alone would answer one app with another's data.
 *
 * `appKey(k)` = `<app>\u0000<k>`; self-hosted the app is '' so every key is `\u0000<k>` — one app,
 * nothing changes.
 */
export function appKey(k: string): string {
  return `${currentTenantKey()}\u0000${k}`
}

/**
 * Drop cached entries: inside an app only that app's (one key, or all of its keys); outside any
 * app (self-hosted, a cache reset, another process's config change) every app's.
 */
export function dropAppEntries(map: Map<string, unknown>, k?: string): void {
  const app = currentTenantKey()
  if (k !== undefined) {
    if (app) {
      map.delete(`${app}\u0000${k}`)
      return
    }
    const tail = `\u0000${k}`
    for (const key of [...map.keys()]) if (key.endsWith(tail)) map.delete(key)
    return
  }
  if (!app) {
    map.clear()
    return
  }
  const head = `${app}\u0000`
  for (const key of [...map.keys()]) if (key.startsWith(head)) map.delete(key)
}

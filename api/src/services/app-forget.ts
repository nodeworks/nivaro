/**
 * Module caches keyed by hand per app (Hub phase 6 final review I-1). appMap / appSet / appBox
 * (app-state.ts) give every app its own slot; about two hundred other module Maps / Sets put the
 * app into the key themselves (`appKey(k)` = `<app>\u0000<k>`, `${currentTenantKey()}|…`, a
 * Map<tenant, …>, tenantState()). When an app leaves a shared deployment's process (unplaced, or
 * moved away) and later comes back, those entries must not answer it: the process heard none of
 * the config changes made while the app was elsewhere, so a relation, a rollup or a column added
 * there would stay unknown here. Registering such a container lets forgetAppState() drop every
 * entry of the app in one call.
 *
 * A leaf module on purpose (no imports): db/, hooks/ and services/ modules all register here
 * without any import cycle.
 *
 * An entry belongs to the app when its key (a string key, or a string member of a Set) IS the
 * app's key, or carries it between separators: `<app>\u0000…`, `<app>|…`, `…|<app>|…`, `t:<app>:…`.
 * A separator is any character that never appears in an app key (letters, digits, `-`, `_`).
 * Self-hosted the app key is '' and nothing is ever forgotten.
 */

/** A store that forgets an app's entries itself (a cache whose keys are not plain strings). */
export interface ForgetsApp {
  forgetApp(appKey: string): number
}

type Container = Map<unknown, unknown> | Set<unknown> | ForgetsApp

const registered = new Set<Container>()

/** Registers a module Map / Set whose keys name the app (or a store with its own forgetApp), so
 *  forgetAppState() drops that app's entries. Answers the container, for `const x =
 *  registerAppKeyed(new Map<…>())`. */
export function registerAppKeyed<T extends Container>(container: T): T {
  registered.add(container)
  return container
}

const KEY_CHAR = /[A-Za-z0-9_-]/

/** The key `key` belongs to the app `appKey` (see the module comment). */
export function keyNamesApp(key: unknown, appKey: string): boolean {
  if (!appKey || typeof key !== 'string') return false
  if (key === appKey) return true
  for (let at = key.indexOf(appKey); at >= 0; at = key.indexOf(appKey, at + 1)) {
    const before = at === 0 ? '' : key[at - 1]
    const after = key[at + appKey.length] ?? ''
    if ((before === '' || !KEY_CHAR.test(before)) && (after === '' || !KEY_CHAR.test(after)))
      return true
  }
  return false
}

/** Drops every entry of `appKey` from every registered container. Answers how many went. Reads
 *  and deletes through Map / Set's own methods, so a subclass that rewrites keys on the way in
 *  (items.ts RelationCache) is emptied by its stored keys. */
export function forgetAppEntries(appKey: string): number {
  if (!appKey) return 0
  let n = 0
  for (const c of registered) {
    if (c instanceof Map) {
      for (const k of [...Map.prototype.keys.call(c)])
        if (keyNamesApp(k, appKey) && Map.prototype.delete.call(c, k)) n++
    } else if (c instanceof Set) {
      for (const k of [...Set.prototype.values.call(c)])
        if (keyNamesApp(k, appKey) && Set.prototype.delete.call(c, k)) n++
    } else n += c.forgetApp(appKey)
  }
  return n
}

/** How many containers are registered (tests). */
export function registeredAppKeyedCount(): number {
  return registered.size
}

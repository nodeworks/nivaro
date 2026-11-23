import { forgetAppEntries } from './app-forget.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Module state per app (Hub phase 6 Task 22). One process of a Hub shared deployment (and of
 * Nivaro Cloud) serves many apps, and two of them may be copies of each other (same collection
 * names, same record and user ids). A module-level cache, flag or memo kept in one slot would
 * answer one app with another's data. These helpers give every app its own slot, by
 * currentTenantKey(); self-hosted that key is '' (one app), so nothing changes there.
 *
 * Outside any app (key '') on a deployment that has apps — a timer, a cache reset heard from
 * another process — a reset reaches every app: `clear()` / `delete(k)` on an appMap / appSet,
 * `reset()` on a box, and putting a box's initial (primitive) value back. Any other read or
 * write outside an app uses the '' slot, exactly as the module did before.
 *
 * Rules that keep this sound (review M-3, report item 6):
 *  - Iteration (`for…of`, `keys()`, `size`) outside an app sees only the '' slot: a prefix bust
 *    that loops over keys must run inside the app, or use clear().
 *  - A listener or timer created lazily inside an app request keeps that app's async context for
 *    life: a cross-process bust it hears then clears that app only. Register such listeners at
 *    boot (outside any app).
 *  - A flag put back to its initial value outside any app resets every app's flag: only reset
 *    flags in the context that set them.
 */

/**
 * Every per-app slot map made here, so an app that leaves this process can be forgotten in one
 * call (forgetAppState). Process-wide by design: it holds the containers, not any app's data.
 */
const registered = new Set<Map<string, unknown>>()

/**
 * Drops every per-app slot of `tenantKey` in every appMap / appSet / appBox of this process, and
 * every entry of it in the hand-keyed module caches registered with registerAppKeyed()
 * (app-forget.ts: appKey maps, Map<tenant, …>, tenantState()): an app that left it (unplaced from
 * a shared deployment, or moved away — its tenant no longer listed) leaves no cached state
 * behind, and a later return starts clean. The deployment's own '' slot is never dropped.
 * Answers how many slots and entries were dropped.
 */
export function forgetAppState(tenantKey: string): number {
  if (!tenantKey) return 0
  let n = 0
  for (const byApp of registered) if (byApp.delete(tenantKey)) n++
  return n + forgetAppEntries(tenantKey)
}

function slots<T>(make: () => T) {
  const byApp = new Map<string, T>()
  registered.add(byApp as Map<string, unknown>)
  return {
    byApp,
    mine(): T {
      const key = currentTenantKey()
      let v = byApp.get(key)
      if (v === undefined) {
        v = make()
        byApp.set(key, v)
      }
      return v
    }
  }
}

/** A Map whose entries are the current app's own. */
export function appMap<K, V>(): Map<K, V> {
  const s = slots(() => new Map<K, V>())
  return new Proxy(new Map<K, V>(), {
    get(_t, prop) {
      if (!currentTenantKey()) {
        if (prop === 'clear')
          return () => {
            for (const m of s.byApp.values()) m.clear()
          }
        if (prop === 'delete')
          return (k: K) => {
            let hit = false
            for (const m of s.byApp.values()) hit = m.delete(k) || hit
            return hit
          }
      }
      const m = s.mine()
      const v = Reflect.get(m, prop, m)
      return typeof v === 'function' ? v.bind(m) : v
    }
  })
}

/** A Set whose members are the current app's own. */
export function appSet<T>(): Set<T> {
  const s = slots(() => new Set<T>())
  return new Proxy(new Set<T>(), {
    get(_t, prop) {
      if (!currentTenantKey()) {
        if (prop === 'clear')
          return () => {
            for (const m of s.byApp.values()) m.clear()
          }
        if (prop === 'delete')
          return (k: T) => {
            let hit = false
            for (const m of s.byApp.values()) hit = m.delete(k) || hit
            return hit
          }
      }
      const m = s.mine()
      const v = Reflect.get(m, prop, m)
      return typeof v === 'function' ? v.bind(m) : v
    }
  })
}

/** One value per app (what a module-level `let` held for the whole process). */
export interface AppBox<T> {
  value: T
  /** Back to the initial value: this app's slot inside an app, every app's outside one (a cache
   *  reset heard from another process). Use it when the initial value is an object, which a
   *  plain `value = …` outside an app would only put in the '' slot. */
  reset(): void
}

export function appBox<T>(init: () => T): AppBox<T> {
  const s = slots(() => ({ v: init() }))
  return {
    get value(): T {
      return s.mine().v
    },
    set value(v: T) {
      if (!currentTenantKey() && s.byApp.size > 0) {
        const start = init()
        const primitive =
          start === null || (typeof start !== 'object' && typeof start !== 'function')
        if (primitive && Object.is(v, start)) {
          for (const slot of s.byApp.values()) slot.v = v
          return
        }
      }
      s.mine().v = v
    },
    reset(): void {
      if (currentTenantKey()) {
        s.mine().v = init()
        return
      }
      for (const slot of s.byApp.values()) slot.v = init()
    }
  }
}

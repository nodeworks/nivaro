import { withTenant } from '../../db/tenant-context.js'
import type { TenantRecord } from './types.js'

// Hub shared deployments: hooks for "an app became ready in this process" and "an app left it".
// Per-app work (row-schedule hydration, boot passes) hangs on these instead of on a boot-time loop,
// because apps join and leave a running process.

type ReadyHook = (t: TenantRecord) => Promise<void> | void
type LeftHook = (tenantId: string) => void

// Code registries (one hook per name; registering again replaces it): the same for every app.
const readyHooks = new Map<string, ReadyHook>()
const leftHooks = new Map<string, LeftHook>()

export function onAppReady(name: string, fn: ReadyHook): void {
  readyHooks.set(name, fn)
}

export function onAppLeft(name: string, fn: LeftHook): void {
  leftHooks.set(name, fn)
}

/** The app is ready (its migrations are done). Returns at once; every hook runs inside the app,
 *  one after the other, and one that throws never stops the next. */
export function fireAppReady(t: TenantRecord): void {
  const hooks = [...readyHooks.entries()]
  if (hooks.length === 0) return
  void (async () => {
    for (const [name, fn] of hooks) {
      try {
        await withTenant(t, async () => fn(t), t.origin)
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: an operator must see a failing app hook
        console.warn(
          `[tenancy] app ${t.id}: ready hook ${name} failed — ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  })()
}

/** The app left this process. Synchronous; a hook that throws never stops the next. */
export function fireAppLeft(tenantId: string): void {
  for (const [name, fn] of [...leftHooks.entries()]) {
    try {
      fn(tenantId)
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: an operator must see a failing app hook
      console.warn(
        `[tenancy] app ${tenantId}: left hook ${name} failed — ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

export function _resetAppLifecycleForTests(): void {
  readyHooks.clear()
  leftHooks.clear()
}

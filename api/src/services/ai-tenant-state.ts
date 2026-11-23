import { registerAppKeyed } from './app-forget.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Per-tenant module state. In cloud mode one process serves many tenants, so a
 * cache or flag kept in a plain module variable would leak one tenant's prices,
 * probes or check results into another's. `tenantState(init)` returns a getter
 * that hands each tenant (`currentTenantKey()`, '' self-hosted) its own value. A tenant that
 * leaves a Hub shared deployment's process loses its value (forgetAppState, app-forget.ts).
 */
export function tenantState<T>(init: () => T): () => T {
  const byTenant = registerAppKeyed(new Map<string, T>())
  return () => {
    const key = currentTenantKey()
    let v = byTenant.get(key)
    if (v === undefined) {
      v = init()
      byTenant.set(key, v)
    }
    return v
  }
}

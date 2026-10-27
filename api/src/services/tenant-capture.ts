import { getTenantDb, getTenantId, getTenantSlug, runWithTenantDb } from '../db/tenant-context.js'

/**
 * Capture the current tenant context (cloud) so later work — a stream's heartbeat timer, a
 * delivery fired from another tenant's write — re-enters it. Self-hosted (no tenant context):
 * a pass-through.
 */
export function captureTenant(): <T>(fn: () => Promise<T>) => Promise<T> {
  const tdb = getTenantDb()
  if (!tdb) return <T>(fn: () => Promise<T>) => fn()
  const slug = getTenantSlug() ?? ''
  const id = getTenantId() ?? ''
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      runWithTenantDb(tdb, slug, () => void fn().then(resolve, reject), id)
    })
}

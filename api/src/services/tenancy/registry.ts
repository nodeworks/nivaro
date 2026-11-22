import { isMultiTenant, tenantSource } from '../deployment-mode.js'
import { cloudMetaSource } from './cloud-meta-source.js'
import { getHubTenantSource } from './hub-source.js'
import type { TenantRegistry } from './types.js'

let override: TenantRegistry | null | undefined
let cached: TenantRegistry | null = null

/** The tenant registry of this deployment, or null when one process serves one app. */
export function getTenantRegistry(): TenantRegistry | null {
  if (override !== undefined) return override
  if (!isMultiTenant()) return null
  if (tenantSource() === 'cloud-meta') {
    cached ??= cloudMetaSource()
    return cached
  }
  // A Hub shared deployment: the Hub source server.ts started at boot (null until it has).
  if (tenantSource() === 'hub') return getHubTenantSource()
  return null
}

/** Test seam: a registry replaces the real one; `null` clears the override (back to the env). */
export function setTenantRegistryForTests(r: TenantRegistry | null): void {
  override = r
  if (r === null) override = undefined
  cached = null
}

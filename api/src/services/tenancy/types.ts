import type { TenantSource } from '../deployment-mode.js'

/** One tenant (app) a multi-tenant process serves, whatever source lists it. */
export interface TenantRecord {
  id: string
  slug: string
  name: string
  status: 'active' | 'provisioning' | 'suspended' | 'maintenance' | (string & {})
  dbClient: string
  dbConnection: string
  /** The tenant pool's own size; null = the default (TENANT_POOL_MAX). */
  poolMax: number | null
  hostnames: string[]
  /** Hub source only: a non-default port the Hub listed for a hostname. It goes into the
   *  origin only; routing matches the bare hostname. */
  originPorts?: Record<string, number>
}

export interface TenantResolution {
  tenant: TenantRecord
  /** The tenant's verified origin for the host it was resolved from (verifiedTenantOrigin). */
  origin: string
}

export interface TenantRegistryStatus {
  source: TenantSource
  count: number
  loadedAt: string | null
  stale: boolean
  lastError: string | null
}

export interface TenantRegistry {
  readonly source: TenantSource
  /** The tenant behind a request host, or null (unknown, reserved host, source error). */
  resolve(host: string, customHost?: string | null): Promise<TenantResolution | null>
  /** Tenants with status active or maintenance. */
  listActive(): Promise<TenantRecord[]>
  status(): TenantRegistryStatus
}

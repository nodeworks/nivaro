import type { AppLimits } from '../capacity/limits.js'
import type { TenantSource } from '../deployment-mode.js'

/** One tenant (app) a multi-tenant process serves, whatever source lists it. */
export interface TenantRecord {
  id: string
  slug: string
  name: string
  status: 'active' | 'provisioning' | 'suspended' | 'maintenance' | (string & {})
  dbClient: string
  dbConnection: string
  /** Hub gap sqlite (H2): the Hub placed this SQLite app's database as NEW — the deployment may
   *  make its file once. Absent: a missing file is refused (SQLITE_FILE_MISSING). */
  dbCreate?: boolean
  /** Hub gap sqlite (review 4, L7): the Hub database record a SQLite app's file belongs to. A
   *  file whose `.created` marker names another record is refused (SQLITE_FILE_STALE). */
  dbRecord?: number
  /** The tenant pool's own size; null = the default (TENANT_POOL_MAX). */
  poolMax: number | null
  hostnames: string[]
  /** Hub source only: a non-default port the Hub listed for a hostname. It goes into the
   *  origin only; routing matches the bare hostname. */
  originPorts?: Record<string, number>
  /** Hub source only (phase 6): the environment's own origin (`https://host[:port]`), when the
   *  Hub listed one. */
  origin?: string
  /** Hub source only (phase 6): the app's ENCRYPTION_KEY (64 hex), when the Hub listed one. */
  encryptionKey?: string
  /** Hub source only: the app's Hub link, sealed with its key (tenancy/app-hub-links.ts). */
  hubLink?: string
  /** Hub source only (capacity): the app's limits on this deployment (services/capacity/
   *  limits.ts); absent = unlimited. */
  limits?: AppLimits
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
  /** Hub source (phase 6): one listed tenant by id, whatever its status; null when not listed. */
  byId?(id: string): Promise<TenantRecord | null>
  /** Hub source (phase 6): every listed tenant, provisioning and suspended included. */
  listAll?(): Promise<TenantRecord[]>
  status(): TenantRegistryStatus
}

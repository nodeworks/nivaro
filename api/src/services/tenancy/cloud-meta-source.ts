import knex, { type Knex } from 'knex'
import { cloudBaseDomain, verifiedTenantOrigin } from '../../db/tenant-context.js'
import { cloudMetaDbUrl } from '../deployment-mode.js'
import type {
  TenantRecord,
  TenantRegistry,
  TenantRegistryStatus,
  TenantResolution
} from './types.js'

// Single Knex connection to the Nivaro Cloud meta DB (cloud_tenants table).
// Created lazily on first request. Never used in self-hosted mode.
let _metaDb: Knex | null = null

export function getMetaDb(): Knex {
  if (!_metaDb) {
    _metaDb = knex({
      client: 'pg',
      connection: cloudMetaDbUrl()!,
      pool: { min: 1, max: 3 }
    })
  }
  return _metaDb
}

export function setMetaDbForTests(k: Knex | null): void {
  _metaDb = k
}

// Subdomains that are not tenant slugs — route through without tenant resolution.
const RESERVED = new Set(['www', 'control', 'api', 'admin', 'status', 'mail'])

type Row = Record<string, unknown>

function toRecord(row: Row, sub: string): TenantRecord {
  const hostnames = [`${sub.toLowerCase()}.${cloudBaseDomain()}`]
  if (row.custom_domain && row.custom_domain_status === 'active')
    hostnames.push(String(row.custom_domain).toLowerCase())
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    status: row.status as string,
    dbClient: row.db_client as string,
    dbConnection: row.db_connection_string as string,
    poolMax: null,
    hostnames
  }
}

/** The tenant registry over the Nivaro Cloud control-plane database (cloud_tenants). */
export function cloudMetaSource(): TenantRegistry {
  let count = 0
  let loadedAt: string | null = null
  let lastError: string | null = null
  let lastGood: TenantRecord[] | null = null
  // Code-level text only: never the driver message (it can carry the connection URL).
  const errorText = (err: unknown) => {
    const code = (err as { code?: unknown } | null)?.code
    return typeof code === 'string' ? `meta database error ${code}` : 'meta database error'
  }
  return {
    source: 'cloud-meta',
    async resolve(host: string, customHost?: string | null): Promise<TenantResolution | null> {
      // When behind Cloudflare Worker, the original host is passed via X-Forwarded-Host
      const sub = host.split('.')[0]
      if (!sub || RESERVED.has(sub)) return null

      // Every column: the custom-domain ones (meta migration 013) verify the origin, and a meta
      // DB without them still resolves.
      let failed = false
      const row = (await getMetaDb()('cloud_tenants')
        .where({ subdomain: sub })
        .first()
        .catch((err: unknown) => {
          failed = true
          lastError = errorText(err)
          return null
        })) as Row | null | undefined
      if (!failed) lastError = null
      if (!row) return null
      const origin = verifiedTenantOrigin(
        host,
        {
          slug: String(row.slug),
          subdomain: (row.subdomain as string | null) ?? sub,
          custom_domain: (row.custom_domain as string | null) ?? null,
          custom_domain_status: (row.custom_domain_status as string | null) ?? null
        },
        customHost
      )
      return { tenant: toRecord(row, String(row.subdomain ?? sub)), origin }
    },
    async listActive(): Promise<TenantRecord[]> {
      try {
        const rows = (await getMetaDb()('cloud_tenants').whereIn('status', [
          'active',
          'maintenance'
        ])) as Row[]
        lastGood = rows.map((r) => toRecord(r, String(r.subdomain ?? r.slug)))
        count = lastGood.length
        loadedAt = new Date().toISOString()
        lastError = null
        return lastGood
      } catch (err) {
        // An outage never empties the list: keep serving the last good one, marked stale.
        lastError = errorText(err)
        return lastGood ?? []
      }
    },
    status(): TenantRegistryStatus {
      return { source: 'cloud-meta', count, loadedAt, stale: lastError !== null, lastError }
    }
  }
}

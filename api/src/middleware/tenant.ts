import knex, { type Knex } from 'knex'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getOrCreateTenantPool, runWithTenantDb } from '../db/tenant-context.js'

// Single Knex connection to the Nivaro Cloud meta DB (cloud_tenants table).
// Created lazily on first request. Never used in self-hosted mode.
let _metaDb: Knex | null = null

export function getMetaDb(): Knex {
  if (!_metaDb) {
    _metaDb = knex({
      client: 'pg',
      connection: process.env.CLOUD_META_DB_URL!,
      pool: { min: 1, max: 3 }
    })
  }
  return _metaDb
}

// Subdomains that are not tenant slugs — route through without tenant resolution.
const RESERVED = new Set(['www', 'control', 'api', 'admin', 'status', 'mail'])

// Paths that work without a tenant DB (health check, Inngest, admin provision).
const TENANT_FREE_PATHS = ['/health', '/api/inngest', '/admin/provision', '/admin/migrate', '/admin/migration-status', '/admin/configure-storage']

/** Resolves the tenant Knex pool and slug from the request hostname.
 *  Returns null if the hostname is a system subdomain or tenant not found.
 *  Throws if the tenant exists but is not active. */
async function resolveTenant(hostname: string): Promise<{ db: Knex; slug: string; tenantId: string } | null> {
  // When behind Cloudflare Worker, the original host is passed via X-Forwarded-Host
  const sub = hostname.split('.')[0]
  if (!sub || RESERVED.has(sub)) return null

  const row = await getMetaDb()('cloud_tenants')
    .where({ subdomain: sub })
    .first('id', 'slug', 'status', 'db_client', 'db_connection_string')
    .catch(() => null)

  if (!row) return null
  if (row.status !== 'active') return null

  return {
    db: getOrCreateTenantPool(row.db_connection_string, row.db_client),
    slug: row.slug as string,
  }
}

/** Fastify `onRequest` hook — only registered when CLOUD_META_DB_URL is set.
 *  Resolves the tenant DB for this request and sets it in AsyncLocalStorage
 *  by calling done() from within store.run(), propagating the context to all
 *  subsequent async operations in this request's lifecycle. */
export function tenantHook(req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
  // X-Tenant-Host is set by the Cloudflare Worker and won't be overridden by Railway's proxy
  const hostname = (req.headers['x-tenant-host'] as string | undefined)
    ?? (req.headers['x-forwarded-host'] as string | undefined)
    ?? req.hostname
  // Tenant-free paths bypass resolution entirely
  if (TENANT_FREE_PATHS.some(p => req.url === p || req.url.startsWith(p + '/'))) {
    return done()
  }

  resolveTenant(hostname)
    .then((tenant) => {
      if (!tenant) {
        // No tenant resolved for this subdomain — reject rather than letting routes
        // run without a DB (they crash with undefined iteration errors in cloud mode).
        reply.code(404).send({ error: 'Tenant not found', subdomain: hostname.split('.')[0] })
        return
      }
      runWithTenantDb(tenant.db, tenant.slug, done, tenant.tenantId)
    })
    .catch((err: unknown) => done(err instanceof Error ? err : new Error(String(err))))
}

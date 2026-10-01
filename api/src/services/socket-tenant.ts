// api/src/services/socket-tenant.ts
/**
 * Cloud mode (#1132): socket.io connections reach the HTTP server directly, never through the
 * tenant onRequest hook, so a socket handler has no tenant database in scope and every query
 * silently resolves to nothing. These helpers resolve the tenant once per socket from the
 * handshake host (the same headers the hook reads) and run a handler inside that tenant's
 * AsyncLocalStorage context. Self-hosted: a straight pass-through.
 */
import { runWithTenantDb } from '../db/tenant-context.js'
import { tenantStoreId } from './traffic-taps.js'

interface SocketLike {
  handshake?: { headers?: Record<string, string | string[] | undefined> }
  data?: Record<string, unknown>
}
interface ReadyTenant {
  db: import('knex').Knex
  slug: string
  tenantId: string
}

function inCloud(): boolean {
  return !!process.env.CLOUD_META_DB_URL
}

function headerOf(socket: SocketLike, name: string): string | undefined {
  const v = socket.handshake?.headers?.[name]
  return Array.isArray(v) ? v[0] : v
}

/** The host the tenant is resolved from — X-Tenant-Host, then X-Forwarded-Host, then Host. */
export function socketTenantHost(socket: SocketLike): string | null {
  const raw =
    headerOf(socket, 'x-tenant-host') ??
    headerOf(socket, 'x-forwarded-host') ??
    headerOf(socket, 'host')
  if (!raw) return null
  return raw.split(',')[0].trim().replace(/:\d+$/, '') || null
}

/** The socket's ready tenant (resolved once, cached on socket.data), or null. */
export async function socketTenant(socket: SocketLike): Promise<ReadyTenant | null> {
  if (!inCloud()) return null
  if (!socket.data) socket.data = {}
  const data = socket.data
  const cached = data.nvrTenant as Promise<ReadyTenant | null> | undefined
  if (cached) return cached
  const host = socketTenantHost(socket)
  const p = host
    ? import('../middleware/tenant.js').then((m) => m.resolveReadyTenant(host)).catch(() => null)
    : Promise.resolve(null)
  data.nvrTenant = p
  return p
}

/** The Traffic Map store the socket's tenant records into (null self-hosted or unresolved). */
export async function socketTrafficStore(socket: SocketLike): Promise<string | null> {
  const t = await socketTenant(socket)
  return t ? tenantStoreId(t.tenantId || t.slug) : null
}

/**
 * Wrap a socket handler so it runs inside the socket's tenant context in cloud mode (a socket
 * whose host names no ready tenant is ignored). Self-hosted: the handler unchanged.
 */
export function inSocketTenant<A extends unknown[]>(
  socket: SocketLike,
  handler: (...args: A) => Promise<void> | void
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    if (!inCloud()) {
      await handler(...args)
      return
    }
    const t = await socketTenant(socket)
    if (!t) return
    await new Promise<void>((resolve) => {
      runWithTenantDb(
        t.db,
        t.slug,
        () => {
          Promise.resolve()
            .then(() => handler(...args))
            .catch(() => {})
            .finally(resolve)
        },
        t.tenantId
      )
    })
  }
}

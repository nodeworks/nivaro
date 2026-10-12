import { getTenantId } from '../db/tenant-context.js'

/**
 * Socket rooms per tenant (cloud mode). A journaled event emitted inside a
 * tenant's context goes to `t:<tenant>:<room>`, and a cloud socket joins
 * collection rooms under its own tenant's prefix, so record-change events
 * (ids + field names) never reach another tenant's sockets — live, from the
 * Redis stream, or replayed from either journal. Self-hosted (no tenant):
 * room names are unchanged.
 */

/** The current tenant's key ('' = no tenant). Matches getTenantId(). */
export function currentTenantKey(): string {
  return getTenantId() ?? ''
}

export function tenantScopedRoom(room: string, tenant: string = currentTenantKey()): string {
  return tenant ? `t:${tenant}:${room}` : room
}

import type { Server as SocketIOServer } from 'socket.io'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

/**
 * Personal rooms per tenant (cloud mode).
 *
 * Every signed-in socket sits in `user:<id>`, and dozens of producers address a person by that
 * name (notifications, chat, AI streams, force refresh). In cloud mode one process serves many
 * tenants on one Socket.io server, so a bare `user:<id>` is shared by every tenant that happens
 * to hold the same id (a copied database, a seeded fixture). Cloud sockets therefore join
 * `t:<tenant>:user:<id>`, and every broadcast to a bare `user:` room made inside a tenant's
 * context is addressed to that tenant's name — at the one place every `to()` / `in()` passes
 * (the broadcast operator), so no producer has to change.
 *
 * Self-hosted: nothing changes (no tenant, no prefix). Session-replay rooms are not personal
 * rooms and are never rewritten here.
 */

const PATCHED = Symbol.for('nivaro.cloudUserRooms')

function inCloud(): boolean {
  return !!process.env.CLOUD_META_DB_URL
}

/** The name a personal room has for the current tenant (unchanged self-hosted / untenanted). */
export function cloudUserRoom(room: string, tenant: string = currentTenantKey()): string {
  if (!inCloud() || typeof room !== 'string' || !room.startsWith('user:') || !tenant) return room
  return tenantScopedRoom(room, tenant)
}

/** The room a socket joins for its own person: per tenant in cloud mode. */
export function ownUserRoom(userId: string, tenant: string | null | undefined): string {
  const room = `user:${userId}`
  return inCloud() && tenant ? tenantScopedRoom(room, tenant) : room
}

/**
 * Cloud only: rewrite bare `user:` rooms to the current tenant's name on every broadcast
 * operator of this server (`io.to`, `io.in`, `socket.to`, chained `.to`). Idempotent.
 */
export function scopeUserRoomsPerTenant(io: SocketIOServer): void {
  if (!inCloud()) return
  const proto = Object.getPrototypeOf(io.of('/').to('nvr:probe')) as Record<
    string | symbol,
    unknown
  >
  if (!proto || proto[PATCHED]) return
  const original = proto.to as (this: unknown, room: string | string[]) => unknown
  proto.to = function scopedTo(this: unknown, room: string | string[]) {
    const mapped = Array.isArray(room) ? room.map((r) => cloudUserRoom(r)) : cloudUserRoom(room)
    return original.call(this, mapped)
  }
  proto[PATCHED] = true
}

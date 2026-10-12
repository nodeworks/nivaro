import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { Socket, Server as SocketIOServer } from 'socket.io'
import { REVOKED_PREFIX } from '../auth/session.js'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { canSeeRoom } from './chat.js'
import { getIo } from './io-holder.js'
import { can } from './permissions.js'
import { compileAccessGates, visibleIds } from './record-access.js'
import { inSocketTenant } from './socket-tenant.js'

/**
 * Socket access over a socket's whole life (#1719, #1720).
 *
 * Rooms used to be checked only at join time, and a socket authenticated once stayed
 * connected until the tab closed — after a logout, a revoked session, an expired session or a
 * suspension it kept receiving events. This module:
 *
 * - binds each socket to what signed it in (a session id, a masquerade token, or a static
 *   token) — rooms `session:<sid>` / `masq:<hash>` let a revoke reach the socket on EVERY
 *   replica through the Redis adapter;
 * - re-checks every room a socket holds with the SAME gates the HTTP routes use (collection →
 *   can(read); record → can + row filter + user scopes, the record-access gate compiler; chat
 *   → canSeeRoom; watch/pulse/presence-map/replay → the role's admin access), leaving what no
 *   longer passes and telling the client with `access:changed { rooms_left }` (room names,
 *   never values);
 * - sweeps this node's sockets every 30s, so an expired session, a deleted session key, a
 *   rotated token or a status change made by a path that triggered nothing still closes.
 */

/** What signed a socket in. Stored on socket.data.nvrBind. */
export type SocketBind =
  | { kind: 'session'; sid: string }
  | { kind: 'masq'; token: string }
  | { kind: 'token'; tokenHash: string }

/** Hooks the socket plugin hangs on socket.data so this module can act on its closure state. */
export interface SocketAccessHooks {
  user(): User | null
  applyUser(u: User): void
  leaveRoom(room: string): void
}

export function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

export function sessionRoom(sid: string): string {
  return `session:${sid}`
}
export function masqRoom(token: string): string {
  return `masq:${sha(token)}`
}

/** Pairs a ws-token stores: `{u, s?, m?}` (JSON) or a bare user id from an older API. */
export function parseWsTokenValue(raw: string): { userId: string; sid?: string; masq?: string } {
  if (raw.startsWith('{')) {
    try {
      const v = JSON.parse(raw) as { u?: string; s?: string; m?: string }
      if (v.u) return { userId: v.u, sid: v.s || undefined, masq: v.m || undefined }
    } catch {
      /* fall through */
    }
  }
  return { userId: raw }
}

// ── Gates ──────────────────────────────────────────────────────────────────

const ADMIN_ROOMS = /^(watch:|replay:)|^(pulse|presence-map|presence:admin)$/

async function roleIsAdmin(roleId: string | null | undefined): Promise<boolean> {
  if (!roleId) return false
  const role = await db('nivaro_roles').where({ id: roleId }).first('admin_access')
  return !!role?.admin_access
}

function isSystemCollection(c: string): boolean {
  return /^(nivaro_|directus_)/i.test(c)
}

/**
 * May `user` sit in a record's room? The record read gate: role read permission, then the row
 * filter and user scopes (record-access, the gate compiler every per-record route uses).
 * System tables have no row gates — role permission decides, as it always has.
 */
export async function canSeeRecordRoom(
  user: User,
  collection: string,
  item: string,
  isAdmin?: boolean
): Promise<boolean> {
  try {
    const admin = isAdmin ?? (await roleIsAdmin(user.role))
    if (admin) return true
    if (!(await can(user, 'read', collection))) return false
    if (isSystemCollection(collection)) return true
    const gates = await compileAccessGates(user, collection)
    const seen = await visibleIds(gates, [item])
    const want = String(item).toLowerCase()
    for (const id of seen) if (id.toLowerCase() === want) return true
    return false
  } catch {
    return false
  }
}

/**
 * Does `room` still pass for `user`? Rooms this module does not know stay (they are internal or
 * open by design) — the job here is to take away what a gate would now refuse.
 */
export async function roomStillAllowed(
  user: User,
  room: string,
  isAdmin: () => Promise<boolean>
): Promise<boolean> {
  try {
    if (room.startsWith('user:'))
      return room.slice(5).toLowerCase() === String(user.id).toLowerCase()
    if (room.startsWith('collection:')) return await can(user, 'read', room.slice(11))
    if (room.startsWith('record:')) {
      const m = /^record:([^:]+):(.+)$/.exec(room)
      if (!m) return false
      return await canSeeRecordRoom(user, m[1], m[2], await isAdmin())
    }
    if (room.startsWith('chat:')) return await canSeeRoom(user, room.slice(5))
    if (ADMIN_ROOMS.test(room)) return await isAdmin()
    return true
  } catch {
    return false
  }
}

function hooksOf(socket: Socket): SocketAccessHooks | null {
  return (socket.data?.nvrAccess as SocketAccessHooks | undefined) ?? null
}

/** Re-run every joined room's gate for one socket; returns the rooms it left. */
export async function recheckSocketRooms(socket: Socket, user: User): Promise<string[]> {
  const hooks = hooksOf(socket)
  let adminVerdict: Promise<boolean> | null = null
  const isAdmin = () => {
    if (!adminVerdict) adminVerdict = roleIsAdmin(user.role).catch(() => false)
    return adminVerdict
  }
  const left: string[] = []
  for (const room of [...socket.rooms]) {
    if (room === socket.id) continue
    if (await roomStillAllowed(user, room, isAdmin)) continue
    if (hooks) hooks.leaveRoom(room)
    else socket.leave(room)
    left.push(room)
  }
  return left
}

// ── Ending sockets ─────────────────────────────────────────────────────────

export type EndReason = 'signed_out' | 'expired' | 'account_inactive' | 'masquerade_ended'

/** Tell one socket its sign-in is over, then close it (the client goes to sign-in). */
export function endSocket(socket: Socket, reason: EndReason): void {
  try {
    socket.emit('session:ended', { reason })
  } catch {
    /* closing below regardless */
  }
  const t = setTimeout(() => socket.disconnect(true), 250)
  t.unref?.()
}

/** Every socket in `room` on every replica (Redis adapter): told, then closed. */
export function endRoomSockets(room: string, reason: EndReason, io = getIo()): void {
  if (!io) return
  try {
    io.to(room).emit('session:ended', { reason })
    const t = setTimeout(() => {
      try {
        io.in(room).disconnectSockets(true)
      } catch {
        /* best effort */
      }
    }, 300)
    t.unref?.()
  } catch {
    /* best effort — the sweep closes what this missed */
  }
}

export function endSessionSockets(sids: string[], reason: EndReason = 'signed_out'): void {
  for (const sid of sids) if (sid) endRoomSockets(sessionRoom(sid), reason)
}

export function endMasqueradeSockets(token: string): void {
  endRoomSockets(masqRoom(token), 'masquerade_ended')
}

export function endUserSockets(userId: string, reason: EndReason = 'account_inactive'): void {
  endRoomSockets(`user:${userId}`, reason)
}

// ── Recheck requests (#1720) ───────────────────────────────────────────────

export interface RecheckTarget {
  all?: boolean
  userIds?: string[]
}

export const RECHECK_EVENT = 'nvr:access-recheck'
const RECHECK_DEBOUNCE_MS = 1500
let pending: { all: boolean; users: Set<string> } | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Ask every replica to re-check the rooms of the named people (no target = everyone — a
 * policy, role or channel change can touch anyone). Debounced: a burst of writes is one pass.
 * A no-op before the socket server exists.
 */
export function requestAccessRecheck(target: RecheckTarget = { all: true }): void {
  if (!pending) pending = { all: false, users: new Set() }
  if (target.all || !target.userIds?.length) pending.all = true
  for (const u of target.userIds ?? []) if (u) pending.users.add(String(u).toUpperCase())
  if (pendingTimer) return
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    const p = pending
    pending = null
    const io = getIo()
    if (!io || !p) return
    const payload = { all: p.all, userIds: [...p.users] }
    void runLocalRecheck(io, payload)
    try {
      io.serverSideEmit(RECHECK_EVENT, payload)
    } catch {
      /* single node, or the adapter is down — the sweep still catches role changes */
    }
  }, RECHECK_DEBOUNCE_MS)
  pendingTimer.unref?.()
}

/** Authenticated sockets on this node, grouped by tenant (one group self-hosted). */
function authedSocketGroups(io: SocketIOServer, filter?: (u: User) => boolean): Socket[][] {
  const groups = new Map<string, Socket[]>()
  for (const socket of io.sockets.sockets.values()) {
    const user = hooksOf(socket)?.user()
    if (!user) continue
    if (filter && !filter(user)) continue
    const key = String(socket.data?.nvrTenantKey ?? '')
    const g = groups.get(key) ?? []
    g.push(socket)
    groups.set(key, g)
  }
  return [...groups.values()]
}

const USER_COLS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'role',
  'status',
  'is_redacted',
  'static_token'
]

async function freshUsers(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await db('nivaro_users')
      .whereIn('id', ids.slice(i, i + 500))
      .select(USER_COLS)) as Array<Record<string, unknown>>
    for (const r of rows) out.set(String(r.id).toUpperCase(), r)
  }
  return out
}

function isActive(row: Record<string, unknown> | undefined): boolean {
  if (!row) return false
  if (row.status !== 'active') return false
  return !(row.is_redacted === true || row.is_redacted === 1)
}

/** Run a callback for a group of sockets inside that group's tenant context (cloud). */
function inGroupTenant(group: Socket[], fn: () => Promise<void>): Promise<void> {
  return inSocketTenant(group[0], fn)()
}

/** This node's share of a recheck: fresh user rows, inactive accounts closed, rooms re-gated. */
export async function runLocalRecheck(io: SocketIOServer, target: RecheckTarget): Promise<void> {
  const wanted = new Set((target.userIds ?? []).map((u) => String(u).toUpperCase()))
  const filter = target.all ? undefined : (u: User) => wanted.has(String(u.id).toUpperCase())
  for (const group of authedSocketGroups(io, filter)) {
    await inGroupTenant(group, async () => {
      const ids = [...new Set(group.map((s) => String(hooksOf(s)?.user()?.id)))]
      const rows = await freshUsers(ids).catch(() => null)
      if (!rows) return
      for (const socket of group) {
        const hooks = hooksOf(socket)
        const old = hooks?.user()
        if (!hooks || !old) continue
        const row = rows.get(String(old.id).toUpperCase())
        if (!isActive(row)) {
          endSocket(socket, 'account_inactive')
          continue
        }
        const user = { ...old, ...row } as User
        hooks.applyUser(user)
        const left = await recheckSocketRooms(socket, user).catch(() => [] as string[])
        // Only a socket that lost something hears about it (the client re-reads on it).
        if (left.length) socket.emit('access:changed', { rooms_left: left })
      }
    })
  }
}

// ── Sweep (#1719) ──────────────────────────────────────────────────────────

export interface SweepDeps {
  redis: Redis
  /** Session policy judgement (idle / max age) over the stored session stamps. */
  judge?: (
    role: string | null,
    stamps: { loginAt?: number; lastSeenAt?: number }
  ) => Promise<'ok' | 'expired'>
}

/**
 * One pass over this node's authenticated sockets: a session that is gone, revoked or past its
 * policy, a masquerade that ended, a static token that changed, or an account no longer active
 * closes the socket; a changed role re-gates its rooms. Returns how many sockets were closed.
 */
export async function sweepSockets(io: SocketIOServer, deps: SweepDeps): Promise<number> {
  let closed = 0
  for (const group of authedSocketGroups(io)) {
    await inGroupTenant(group, async () => {
      const ids = [...new Set(group.map((s) => String(hooksOf(s)?.user()?.id)))]
      const rows = await freshUsers(ids).catch(() => null)
      if (!rows) return
      // Session keys and masquerade keys for the whole group in one round trip.
      const keys: string[] = []
      for (const s of group) {
        const b = s.data?.nvrBind as SocketBind | undefined
        if (b?.kind === 'session') keys.push(`sess:${b.sid}`, `${REVOKED_PREFIX}${b.sid}`)
        else if (b?.kind === 'masq') keys.push(`masq:${b.token}`)
      }
      const values = keys.length ? await deps.redis.mget(...keys).catch(() => null) : []
      if (values === null) return // Redis unreachable: judge nothing rather than close everyone
      const byKey = new Map<string, string | null>()
      for (let i = 0; i < keys.length; i++) byKey.set(keys[i], values[i] ?? null)

      for (const socket of group) {
        const hooks = hooksOf(socket)
        const old = hooks?.user()
        if (!hooks || !old) continue
        const row = rows.get(String(old.id).toUpperCase())
        if (!isActive(row)) {
          endSocket(socket, 'account_inactive')
          closed++
          continue
        }
        const b = socket.data?.nvrBind as SocketBind | undefined
        if (b?.kind === 'session') {
          const raw = byKey.get(`sess:${b.sid}`)
          if (!raw || byKey.get(`${REVOKED_PREFIX}${b.sid}`)) {
            endSocket(socket, 'signed_out')
            closed++
            continue
          }
          if (deps.judge) {
            let stamps: { loginAt?: number; lastSeenAt?: number } = {}
            try {
              stamps = JSON.parse(raw) as typeof stamps
            } catch {
              /* unreadable stamps never expire a session */
            }
            const verdict = await deps.judge((row?.role as string | null) ?? null, stamps)
            if (verdict === 'expired') {
              endSocket(socket, 'expired')
              closed++
              continue
            }
          }
        } else if (b?.kind === 'masq') {
          if (!byKey.get(`masq:${b.token}`)) {
            endSocket(socket, 'masquerade_ended')
            closed++
            continue
          }
        } else if (b?.kind === 'token' && b.tokenHash) {
          // An empty hash = bound to the account alone (no token behind it to rotate).
          const current = row?.static_token ? sha(String(row.static_token)) : null
          if (current !== b.tokenHash) {
            endSocket(socket, 'signed_out')
            closed++
            continue
          }
        }
        const roleChanged = String(row?.role ?? '') !== String(old.role ?? '')
        const user = { ...old, ...row } as User
        hooks.applyUser(user)
        if (roleChanged) {
          const left = await recheckSocketRooms(socket, user).catch(() => [] as string[])
          if (left.length) socket.emit('access:changed', { rooms_left: left })
        }
      }
    })
  }
  return closed
}

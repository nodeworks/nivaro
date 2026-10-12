import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { Socket, Server as SocketIOServer } from 'socket.io'
import { REVOKED_PREFIX } from '../auth/session.js'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { canSeeRoom } from './chat.js'
import { getIo } from './io-holder.js'
import { can, scopesAreOpen } from './permissions.js'
import { compileAccessGates, visibleIds } from './record-access.js'
import { inSocketTenant } from './socket-tenant.js'
import { splitTenantRoom } from './socket-transport.js'

/**
 * Socket access over a socket's whole life (#1719, #1720).
 *
 * Rooms used to be checked only at join time, and a socket authenticated once stayed
 * connected until the tab closed — after a logout, a revoked session, an expired session or a
 * suspension it kept receiving events. This module:
 *
 * - binds each socket to what signed it in (a session id, a masquerade token, a static token,
 *   or a named API key) — rooms `session:<sid>` / `masq:<hash>` let a revoke reach the socket
 *   on EVERY replica through the Redis adapter. A socket with no bind is never signed in;
 *   nothing is ever bound to "the account alone";
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
  /** A named API key (nvk_), or an admin running AS one (`sim` = the nvq_ run-as token). */
  | { kind: 'apikey'; id: number; sim?: string }

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

/** The request fields a bind is read from (a FastifyRequest has them all). */
export interface BindSource {
  authMethod?: string
  session?: unknown
  headers?: { authorization?: string }
  apiKeyId?: number | null
  apiKeySimulatedId?: number | null
}

/**
 * What signed this request in, as a socket or SSE bind (#1719): the session id, the View-as
 * token, the static token (hashed), or the named API key. Null when there is nothing to bind
 * to — and then nothing may be signed in on it.
 */
export function bindFromRequest(req: BindSource): SocketBind | null {
  const h = req.headers?.authorization
  const bearer = h?.startsWith('Bearer ') ? h.slice(7).trim() : ''
  switch (req.authMethod) {
    case 'session': {
      const sid = (req.session as { sessionId?: string } | undefined)?.sessionId
      return sid ? { kind: 'session', sid } : null
    }
    case 'masquerade':
      return bearer.startsWith('nvm_') ? { kind: 'masq', token: bearer } : null
    case 'api_key':
      return req.apiKeyId != null ? { kind: 'apikey', id: Number(req.apiKeyId) } : null
    case 'key_sim':
      return req.apiKeySimulatedId != null && bearer.startsWith('nvq_')
        ? { kind: 'apikey', id: Number(req.apiKeySimulatedId), sim: bearer }
        : null
    case 'token':
      return bearer ? { kind: 'token', tokenHash: sha(bearer) } : null
    default:
      return null
  }
}

function isBind(v: unknown): v is SocketBind {
  const b = v as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return false
  if (b.kind === 'session') return typeof b.sid === 'string' && !!b.sid
  if (b.kind === 'masq') return typeof b.token === 'string' && !!b.token
  if (b.kind === 'token') return typeof b.tokenHash === 'string' && !!b.tokenHash
  if (b.kind === 'apikey')
    return Number.isFinite(Number(b.id)) && (b.sim == null || typeof b.sim === 'string')
  return false
}

/** What a ws-token or SSE ticket stores: `{u, b}` — the user and what signed them in. */
export function encodeBoundToken(userId: string, bind: SocketBind): string {
  return JSON.stringify({ u: userId, b: bind })
}

/**
 * Read a ws-token / SSE ticket value. A value without a valid bind (a bare user id from an
 * older API) gives `bind: null`, which signs nothing in: the client simply asks for a new one.
 */
export function parseWsTokenValue(raw: string): { userId: string | null; bind: SocketBind | null } {
  if (raw.startsWith('{')) {
    try {
      const v = JSON.parse(raw) as { u?: string; b?: unknown }
      if (v.u) return { userId: v.u, bind: isBind(v.b) ? v.b : null }
    } catch {
      /* fall through */
    }
  }
  return { userId: null, bind: null }
}

/** Redis keys whose presence a bind depends on. */
export function bindRedisKeys(bind: SocketBind): string[] {
  if (bind.kind === 'session') return [`sess:${bind.sid}`, `${REVOKED_PREFIX}${bind.sid}`]
  if (bind.kind === 'masq') return [`masq:${bind.token}`]
  if (bind.kind === 'apikey' && bind.sim) return [`keysim:${bind.sim}`]
  return []
}

export interface ApiKeyState {
  id: number | string
  user: string
  is_active: boolean | number
  expires_at: Date | string | null
  scopes?: string | null
  scope_restrictions?: string | null
}

/** API key rows by id (string keys), for the binds of a group of sockets. */
export async function loadApiKeys(ids: number[]): Promise<Map<string, ApiKeyState>> {
  const out = new Map<string, ApiKeyState>()
  const unique = [...new Set(ids.filter((i) => Number.isFinite(i)))]
  for (let i = 0; i < unique.length; i += 500) {
    const rows = (await db('nivaro_api_keys')
      .whereIn('id', unique.slice(i, i + 500))
      .select(
        'id',
        'user',
        'is_active',
        'expires_at',
        'scopes',
        'scope_restrictions'
      )) as ApiKeyState[]
    for (const r of rows) out.set(String(r.id), r)
  }
  return out
}

function keyUsable(key: ApiKeyState | undefined, userId: string, now: number): boolean {
  if (!key) return false
  if (!(key.is_active === true || key.is_active === 1)) return false
  if (key.expires_at && new Date(key.expires_at).getTime() < now) return false
  return String(key.user).toUpperCase() === String(userId).toUpperCase()
}

/**
 * Is the sign-in behind a bind still good? Null = yes; otherwise why it ended. Session policy
 * (idle / max age) is judged separately (it needs the policy). No bind is never good.
 */
export function bindVerdict(
  bind: SocketBind | null | undefined,
  user: Record<string, unknown> | undefined,
  redisValues: Map<string, string | null>,
  apiKeys: Map<string, ApiKeyState>,
  now = Date.now()
): EndReason | null {
  if (!isActive(user)) return 'account_inactive'
  if (!bind || !isBind(bind)) return 'signed_out'
  switch (bind.kind) {
    case 'session':
      return !redisValues.get(`sess:${bind.sid}`) || redisValues.get(`${REVOKED_PREFIX}${bind.sid}`)
        ? 'signed_out'
        : null
    case 'masq':
      return redisValues.get(`masq:${bind.token}`) ? null : 'masquerade_ended'
    case 'token': {
      const current = user?.static_token ? sha(String(user.static_token)) : null
      return current && current === bind.tokenHash ? null : 'signed_out'
    }
    case 'apikey':
      if (!keyUsable(apiKeys.get(String(bind.id)), String(user?.id), now)) return 'key_revoked'
      if (bind.sim && !redisValues.get(`keysim:${bind.sim}`)) return 'signed_out'
      return null
  }
}

/**
 * One request-free check of a bind (the SSE stream's heartbeat): reads the account, the Redis
 * keys and the API key row itself. Null = still signed in.
 */
export async function checkBind(
  redis: Redis,
  userId: string,
  bind: SocketBind | null
): Promise<EndReason | null> {
  const rows = await freshUsers([userId])
  const keys = bind ? bindRedisKeys(bind) : []
  const values = keys.length ? await redis.mget(...keys) : []
  const byKey = new Map<string, string | null>()
  for (let i = 0; i < keys.length; i++) byKey.set(keys[i], values[i] ?? null)
  const apiKeys = bind?.kind === 'apikey' ? await loadApiKeys([bind.id]) : new Map()
  return bindVerdict(bind, rows.get(String(userId).toUpperCase()), byKey, apiKeys)
}

function parseJsonList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/**
 * A socket signed in through an API key acts with that key's narrowing, as every HTTP request
 * on it does: its scopes and row restrictions ride the user object, where can() and the user
 * scope resolver read them. Null when the key cannot be used.
 */
export async function userWithApiKey(user: User, keyId: number): Promise<User | null> {
  const key = (await loadApiKeys([keyId])).get(String(keyId))
  if (!keyUsable(key, String(user.id), Date.now())) return null
  const out = { ...user } as User & Record<string, unknown>
  const scopes = parseJsonList(key?.scopes) as Array<{ collection: string; actions: string[] }>
  if (scopes.length && !scopesAreOpen(scopes)) out.api_key_scopes = scopes
  const restrictions = parseJsonList(key?.scope_restrictions).filter(
    (r) =>
      !!r &&
      typeof (r as { dimension?: unknown }).dimension === 'string' &&
      Array.isArray((r as { values?: unknown }).values)
  )
  if (restrictions.length)
    out.api_key_scope_restrictions = restrictions as User['api_key_scope_restrictions']
  return out as User
}

// ── Gates ──────────────────────────────────────────────────────────────────

const COLLECTION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const knownTables = new Map<string, { ok: boolean; at: number }>()
const KNOWN_TTL_MS = 5 * 60_000

/**
 * Is `name` a collection a socket may ask to watch? A plain identifier (a name with `:` would
 * spell another room kind, `orders:5`) that is registered or is a real table (system tables
 * such as user_presence are not all registered). Cached per name; the read gate still runs.
 */
export async function isKnownCollection(name: string): Promise<boolean> {
  if (!COLLECTION_NAME.test(name) || name.length > 128) return false
  const hit = knownTables.get(name)
  if (hit && Date.now() - hit.at < KNOWN_TTL_MS) return hit.ok
  let ok = false
  try {
    const { getCollection } = await import('./collections.js')
    ok = !!(await getCollection(name)) || (await db.schema.hasTable(name))
  } catch {
    ok = false
  }
  if (knownTables.size > 2000) knownTables.clear()
  knownTables.set(name, { ok, at: Date.now() })
  return ok
}

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

/** What a room gate knows about the socket besides its person. */
export interface RoomContext {
  /** What signed the socket in — its own `session:` / `masq:` rooms are allowed. */
  bind?: SocketBind | null
  /** Cloud: the tenant id and slug the socket resolved to (its `tenant:` room). */
  tenantNames?: string[]
}

/**
 * Does `room` still pass for `user`? Each room kind runs the gate its join ran. A room kind
 * this module does not know stays only for administrators (H3) — a room a person is put in
 * must have a gate here.
 */
export async function roomStillAllowed(
  user: User,
  scopedRoom: string,
  isAdmin: () => Promise<boolean>,
  ctx: RoomContext = {}
): Promise<boolean> {
  // Cloud rooms carry the tenant prefix (tenant-rooms.ts); the socket only ever joins its own
  // tenant's, so the gate is the room's own.
  const room = splitTenantRoom(scopedRoom).room
  try {
    if (room.startsWith('user:'))
      return room.slice(5).toLowerCase() === String(user.id).toLowerCase()
    if (room.startsWith('session:'))
      return ctx.bind?.kind === 'session' && room === sessionRoom(ctx.bind.sid)
    if (room.startsWith('masq:'))
      return ctx.bind?.kind === 'masq' && room === masqRoom(ctx.bind.token)
    if (room.startsWith('tenant:')) {
      // Self-hosted there is no tenant to leak; in cloud only the socket's own.
      if (!process.env.CLOUD_META_DB_URL) return true
      return (ctx.tenantNames ?? []).includes(room.slice(7))
    }
    if (room.startsWith('collection:')) return await can(user, 'read', room.slice(11))
    if (room.startsWith('record:') || room.startsWith('item:')) {
      const m = /^(?:record|item):([^:]+):(.+)$/.exec(room)
      if (!m) return false
      return await canSeeRecordRoom(user, m[1], m[2], await isAdmin())
    }
    if (room.startsWith('chat:')) return await canSeeRoom(user, room.slice(5))
    if (ADMIN_ROOMS.test(room)) return await isAdmin()
    // Page presence (who is on which page): any signed-in person, as the join allows.
    if (room.startsWith('presence:')) return true
    return await isAdmin()
  } catch {
    return false
  }
}

function hooksOf(socket: Socket): SocketAccessHooks | null {
  return (socket.data?.nvrAccess as SocketAccessHooks | undefined) ?? null
}

/** Re-run every joined room's gate for one socket (or only rooms `only` accepts). */
export async function recheckSocketRooms(
  socket: Socket,
  user: User,
  only?: (room: string) => boolean
): Promise<string[]> {
  const hooks = hooksOf(socket)
  let adminVerdict: Promise<boolean> | null = null
  const isAdmin = () => {
    if (!adminVerdict) adminVerdict = roleIsAdmin(user.role).catch(() => false)
    return adminVerdict
  }
  const left: string[] = []
  const ctx: RoomContext = {
    bind: (socket.data?.nvrBind as SocketBind | undefined) ?? null,
    tenantNames: (socket.data?.nvrTenantNames as string[] | undefined) ?? []
  }
  for (const room of [...socket.rooms]) {
    if (room === socket.id) continue
    if (only && !only(splitTenantRoom(room).room)) continue
    if (await roomStillAllowed(user, room, isAdmin, ctx)) continue
    if (hooks) hooks.leaveRoom(room)
    else socket.leave(room)
    left.push(room)
  }
  return left
}

// ── Ending sockets ─────────────────────────────────────────────────────────

export type EndReason =
  | 'signed_out'
  | 'expired'
  | 'account_inactive'
  | 'masquerade_ended'
  | 'key_revoked'

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
  /** Only rooms starting with these (unprefixed) — e.g. `chat:ch:` after a channel change. */
  roomPrefixes?: string[]
}

export const RECHECK_EVENT = 'nvr:access-recheck'
const RECHECK_DEBOUNCE_MS = 1500
let pending: { all: boolean; users: Set<string>; prefixes: Set<string> } | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Ask every replica to re-check the rooms of the named people (no target = everyone — a
 * policy, role or channel change can touch anyone). Debounced: a burst of writes is one pass.
 * A no-op before the socket server exists.
 */
export function requestAccessRecheck(target: RecheckTarget = { all: true }): void {
  if (!pending) pending = { all: false, users: new Set(), prefixes: new Set() }
  if (target.roomPrefixes?.length) {
    for (const p of target.roomPrefixes) if (p) pending.prefixes.add(p)
  } else if (target.all || !target.userIds?.length) pending.all = true
  for (const u of target.userIds ?? []) if (u) pending.users.add(String(u).toUpperCase())
  if (pendingTimer) return
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    const p = pending
    pending = null
    const io = getIo()
    if (!io || !p) return
    const payload: RecheckTarget = { all: p.all, userIds: [...p.users] }
    // A full pass covers every room; prefixes only narrow a pass that is not full.
    if (!p.all && p.prefixes.size) payload.roomPrefixes = [...p.prefixes]
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
function authedSocketGroups(
  io: SocketIOServer,
  filter?: (u: User, s: Socket) => boolean
): Socket[][] {
  const groups = new Map<string, Socket[]>()
  for (const socket of io.sockets.sockets.values()) {
    const user = hooksOf(socket)?.user()
    if (!user) continue
    if (filter && !filter(user, socket)) continue
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
  const prefixes = target.all ? [] : (target.roomPrefixes ?? [])
  const inPrefix = (room: string) => prefixes.some((p) => room.startsWith(p))
  // A prefix pass reaches the named people (all their rooms) and every socket holding a
  // matching room (only those rooms); otherwise the named people, or everyone.
  const holdsPrefixRoom = (s: Socket) =>
    [...s.rooms].some((r) => r !== s.id && inPrefix(splitTenantRoom(r).room))
  const filter = target.all
    ? undefined
    : (u: User, s: Socket) =>
        wanted.has(String(u.id).toUpperCase()) || (prefixes.length > 0 && holdsPrefixRoom(s))
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
        const named = wanted.has(String(old.id).toUpperCase())
        const left = await recheckSocketRooms(socket, user, named ? undefined : inPrefix).catch(
          () => [] as string[]
        )
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
      // Every bind's Redis keys and API key rows for the whole group, one round trip each.
      const keys: string[] = []
      const keyIds: number[] = []
      for (const s of group) {
        const b = s.data?.nvrBind as SocketBind | undefined
        if (!b) continue
        keys.push(...bindRedisKeys(b))
        if (b.kind === 'apikey') keyIds.push(b.id)
      }
      const values = keys.length ? await deps.redis.mget(...keys).catch(() => null) : []
      if (values === null) return // Redis unreachable: judge nothing rather than close everyone
      const byKey = new Map<string, string | null>()
      for (let i = 0; i < keys.length; i++) byKey.set(keys[i], values[i] ?? null)
      const apiKeys = keyIds.length ? await loadApiKeys(keyIds).catch(() => null) : new Map()
      if (apiKeys === null) return

      for (const socket of group) {
        const hooks = hooksOf(socket)
        const old = hooks?.user()
        if (!hooks || !old) continue
        const row = rows.get(String(old.id).toUpperCase())
        const b = socket.data?.nvrBind as SocketBind | undefined
        const verdict = bindVerdict(b, row, byKey, apiKeys)
        if (verdict) {
          endSocket(socket, verdict)
          closed++
          continue
        }
        if (b?.kind === 'session' && deps.judge) {
          let stamps: { loginAt?: number; lastSeenAt?: number } = {}
          try {
            stamps = JSON.parse(byKey.get(`sess:${b.sid}`) ?? '{}') as typeof stamps
          } catch {
            /* unreadable stamps never expire a session */
          }
          if ((await deps.judge((row?.role as string | null) ?? null, stamps)) === 'expired') {
            endSocket(socket, 'expired')
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

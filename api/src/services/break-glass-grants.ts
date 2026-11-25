import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { appBox } from './app-state.js'
import { type GrantRow, grantEnded, roleAfterGrant } from './break-glass-role.js'
import { isMultiTenant, tenantSource } from './deployment-mode.js'
import { hubLinkToken } from './hub/mode.js'
import { getApp } from './io-holder.js'
import { appKeyPart } from './tenancy/credential-binding.js'

/**
 * Break-glass grants on the APP side (Hub enhancement 45): the table nivaro_break_glass_grants
 * and every judgement that reads it. nivaro_users is never altered for a grant beyond the role
 * swap itself (EFP production is a replication publisher: no new users column).
 *
 * The request path (middleware/authenticate.ts hydrateRole) and isActiveAdmin read the role WITH
 * the account's live grant in ONE statement (`effectiveRole`): no identity cache, no in-process
 * map. When that grant has ended (time ran out, or its end time cannot be read) the request runs
 * with the role the grant replaced whenever the current role carries admin access
 * (break-glass-role.ts), and the end is made real in the background (`endLiveGrantsOf`). So the
 * request check is the authority whether or not the app's expiry job ticks.
 *
 * Every admin count that guards "is there still an administrator" leaves grantees out
 * (`withoutLiveGrantees`): a break-glass admin never keeps the last-admin lock closed nor lets a
 * permanent admin be removed.
 *
 * Ending a grant (`endGrantInTrx`): the role comes back per the rule, the row is marked ended
 * with what happened (restored | restored_over_change | role_changed) and who changed the role
 * meanwhile; afterwards the account's sockets end (they reconnect with the new role), every
 * replica re-checks its rooms, and realtime verdict caches go stale.
 */

export const GRANTS = 'nivaro_break_glass_grants'
const ABSENT_RECHECK_MS = 60_000

// ─── The hot path: no join unless a grant may exist ──────────────────────────────────────────

/**
 * Whether a break-glass grant can exist on this install at all: only an app linked to a Nivaro
 * Hub — a dedicated app with HUB_TOKEN (the hub link is mounted) or one app of a Hub shared
 * deployment. Everywhere else the request path keeps its old, cached role read with no join, and
 * the expiry job is not registered.
 */
export function breakGlassPossible(env: NodeJS.ProcessEnv = process.env): boolean {
  if (tenantSource(env) === 'hub') return true
  return !!hubLinkToken(env) && !isMultiTenant(env)
}

/**
 * "This app has open grants" (Redis `nvr:bg-open:<app>`, set BEFORE a grant is answered,
 * cleared when its last grant ends), copied per process for MARKER_TTL_MS. `none` → the request
 * path uses the old cached role read; `some` or `unknown` (no Redis, a read error) → the joined,
 * uncached statement (fail closed). A grant written on another replica is honoured here within
 * MARKER_TTL_MS. The expiry job re-asserts it every minute while grants are open (a Redis flush
 * cannot hide one for longer).
 */
export const MARKER_TTL_MS = 5_000
const MARKER_READ_MS = 500
export type MarkerState = 'some' | 'none' | 'unknown'

export function openGrantsKey(): string {
  return `nvr:bg-open:${appKeyPart()}`
}

interface MarkerRedis {
  get(k: string): Promise<string | null>
  set(k: string, v: string): Promise<unknown>
  incr?(k: string): Promise<unknown>
  decr?(k: string): Promise<unknown>
  expire?(k: string, s: number): Promise<unknown>
  eval?(script: string, keys: number, ...args: string[]): Promise<unknown>
}

/** Grants of this app on their way (between marking and their row's commit). */
export function pendingGrantsKey(): string {
  return `nvr:bg-pending:${appKeyPart()}`
}
/** A pending count left by a process that died mid-grant lapses (the marker then clears). */
const PENDING_TTL_S = 120

const markerCopy = appBox<{ v: MarkerState; at: number } | null>(() => null)

function markerRedis(): MarkerRedis | null {
  const r = (getApp() as { redis?: MarkerRedis } | null)?.redis
  return r && typeof r.get === 'function' ? r : null
}

function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_r, reject) => {
      t = setTimeout(() => reject(new Error('marker read timed out')), ms)
    })
  ]).finally(() => clearTimeout(t))
}

/** The marker as this process sees it (see above). Never throws. */
export async function openGrantsMarker(now: number = Date.now()): Promise<MarkerState> {
  if (!breakGlassPossible()) return 'none'
  const c = markerCopy.value
  if (c && now - c.at < MARKER_TTL_MS) return c.v
  let v: MarkerState = 'unknown'
  const r = markerRedis()
  if (r) {
    try {
      v = (await bounded(r.get(openGrantsKey()), MARKER_READ_MS)) ? 'some' : 'none'
    } catch {
      v = 'unknown'
    }
  }
  markerCopy.value = { v, at: now }
  return v
}

/** Sets the marker (before a grant is answered). Throws when it cannot be stored. */
export async function markGrantsOpen(): Promise<void> {
  const r = markerRedis()
  if (!r)
    throw Object.assign(new Error('No Redis to mark the grant'), { code: 'MARKER_UNAVAILABLE' })
  await r.set(openGrantsKey(), `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
  markerCopy.value = { v: 'some', at: Date.now() }
}

/**
 * A grant starts: the app's pending count goes up, then the marker is set — a clear that runs
 * meanwhile sees the count and leaves the marker. Throws when Redis cannot record it.
 */
export async function beginGrantMark(): Promise<void> {
  const r = markerRedis()
  if (!r || typeof r.incr !== 'function')
    throw Object.assign(new Error('No Redis to mark the grant'), { code: 'MARKER_UNAVAILABLE' })
  await r.incr(pendingGrantsKey())
  await r.expire?.(pendingGrantsKey(), PENDING_TTL_S)
  await markGrantsOpen()
}

/** The grant's row committed (or the grant was refused): the marker set again, the count down. */
export async function endGrantMark(granted: boolean): Promise<void> {
  const r = markerRedis()
  if (!r) return
  try {
    if (granted) await markGrantsOpen()
  } finally {
    await r.decr?.(pendingGrantsKey())
  }
}

/** Tests: forget this process's copy of the marker. */
export function _resetMarkerForTests(): void {
  markerCopy.reset()
}

/** Deletes the marker only while no grant is pending AND it still holds the value read. */
const CLEAR_IF_SAME = [
  "if tonumber(redis.call('get', KEYS[2]) or '0') > 0 then return 0 end",
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end",
  'return 0'
].join(' ')

/**
 * Clears the marker when the app has no open grant left. The value read first is the one
 * deleted (compare-and-delete): a grant marked in between keeps its marker. Never throws.
 */
export async function clearMarkerIfNone(k: Knex = db): Promise<void> {
  try {
    const r = markerRedis()
    if (!r) return
    const seen = await r.get(openGrantsKey())
    if (!seen) return
    const open = (await k(GRANTS).whereNull('ended_at').whereNotNull('user_id').first('id')) as
      | { id: unknown }
      | undefined
    if (open) return
    if (typeof r.eval === 'function')
      await r.eval(CLEAR_IF_SAME, 2, openGrantsKey(), pendingGrantsKey(), seen)
    markerCopy.value = null
  } catch {
    // Left set: the request path keeps joining (fail closed) until the next clear.
  }
}

/** Whether this database has the grants table (true is kept; false is re-checked each minute).
 *  A failed check THROWS — never read as "no grant". Per app on a shared deployment. */
const tableState = appBox<{ ok: boolean; at: number } | null>(() => null)

export async function grantsTableReady(k: Knex = db): Promise<boolean> {
  const s = tableState.value
  if (s?.ok) return true
  if (s && Date.now() - s.at < ABSENT_RECHECK_MS) return false
  // Something that is not a database connection (no schema at all) cannot hold grants.
  if (typeof (k as { schema?: { hasTable?: unknown } }).schema?.hasTable !== 'function')
    return false
  const ok = await k.schema.hasTable(GRANTS)
  tableState.value = { ok, at: Date.now() }
  return ok
}

/** Tests: forget the cached table state. */
export function _resetGrantsTableForTests(): void {
  tableState.reset()
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

export function grantFromRow(r: Record<string, unknown>): GrantRow {
  return {
    id: Number(r.id),
    ref: String(r.ref ?? ''),
    user_id: r.user_id == null ? null : String(r.user_id),
    role: r.role == null ? null : String(r.role),
    prev_role: r.prev_role == null ? null : String(r.prev_role),
    // An unparseable stored time stays null: grantEnded reads it as ended (fail closed).
    ends_at: iso(r.ends_at),
    granted_at: iso(r.granted_at)
  }
}

export interface EffectiveRole<R> {
  /** The role row the request runs with (null = none). */
  role: R | null
  /** Its id (the account's own, or the prev role of an ended grant). */
  roleId: string | null
  /** The account's grant that holds right now, if any. */
  live: GrantRow | null
  /** A grant that has ended but is not marked yet (the caller ends it in the background). */
  ended: GrantRow | null
}

const BG = ['nvr_bg_id', 'nvr_bg_ref', 'nvr_bg_role', 'nvr_bg_prev_role', 'nvr_bg_ends_at']

/**
 * The role a request by this account runs with, and its grant — one statement (role LEFT JOIN
 * the account's unended grant). Without the table (an install before migration 578) the plain
 * role read. Throws on a read error (the request fails; it never runs as an admin by mistake).
 */
export async function effectiveRole<R extends Record<string, unknown>>(
  user: { id: unknown; role?: unknown },
  k: Knex = db,
  now: number = Date.now()
): Promise<EffectiveRole<R>> {
  const roleId = user.role == null || user.role === '' ? null : String(user.role)
  if (!roleId) return { role: null, roleId: null, live: null, ended: null }
  // The old statement (cached at the driver seam) unless a grant may exist here right now.
  if (
    !breakGlassPossible() ||
    (await openGrantsMarker(now)) === 'none' ||
    !(await grantsTableReady(k))
  ) {
    const role = (await k('nivaro_roles').where({ id: roleId }).first()) as R | undefined
    return { role: role ?? null, roleId, live: null, ended: null }
  }
  const row = (await k('nivaro_roles as r')
    .leftJoin(`${GRANTS} as g`, (j) => {
      j.on('g.user_id', '=', k.raw('?', [String(user.id)])).andOnNull('g.ended_at')
    })
    .where('r.id', roleId)
    .first(
      'r.*',
      'g.id as nvr_bg_id',
      'g.ref as nvr_bg_ref',
      'g.role as nvr_bg_role',
      'g.prev_role as nvr_bg_prev_role',
      'g.ends_at as nvr_bg_ends_at'
    )) as Record<string, unknown> | undefined
  if (!row) return { role: null, roleId, live: null, ended: null }
  const role = { ...row } as Record<string, unknown>
  for (const c of BG) delete role[c]
  if (row.nvr_bg_id == null) return { role: role as R, roleId, live: null, ended: null }
  const g = grantFromRow({
    id: row.nvr_bg_id,
    ref: row.nvr_bg_ref,
    user_id: user.id,
    role: row.nvr_bg_role,
    prev_role: row.nvr_bg_prev_role,
    ends_at: row.nvr_bg_ends_at
  })
  if (!grantEnded(g, now)) return { role: role as R, roleId, live: g, ended: null }
  if (roleAfterGrant(role as { id: unknown; admin_access?: unknown }, g) === 'keep')
    return { role: role as R, roleId, live: null, ended: g }
  const prev = g.prev_role
    ? ((await k('nivaro_roles').where({ id: g.prev_role }).first()) as R | undefined)
    : undefined
  return { role: prev ?? null, roleId: g.prev_role, live: null, ended: g }
}

/** `qb` (aliasing nivaro_users as `col`'s table) without accounts holding an unended grant. */
export async function withoutLiveGrantees<Q extends Knex.QueryBuilder>(
  qb: Q,
  k: Knex = db,
  col = 'u.id'
): Promise<Q> {
  if (!breakGlassPossible() || !(await grantsTableReady(k))) return qb
  return qb.whereNotExists(
    k(GRANTS)
      .select(k.raw('1'))
      .whereRaw('?? = ??', [`${GRANTS}.user_id`, col])
      .whereNull(`${GRANTS}.ended_at`)
  ) as Q
}

export type EndReason = 'expired' | 'revoked' | 'offboarded' | 'unreadable' | 'unlinked'
export type EndState = 'restored' | 'restored_over_change' | 'role_changed' | 'none'

export interface RevokedCredentials {
  api_keys: number
  static_tokens: number
  connections: number
}

export interface GrantEnd {
  grant: GrantRow
  state: EndState
  changed_by: string | null
  changed_to: string | null
  /** What the grantee made during the grant that the end took away (after afterGrantEnded). */
  revoked?: RevokedCredentials | null
}

function readRevoked(v: unknown): RevokedCredentials | null {
  try {
    const o = typeof v === 'string' ? JSON.parse(v) : v
    if (!o || typeof o !== 'object') return null
    const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0)
    const r = o as Record<string, unknown>
    return {
      api_keys: n(r.api_keys),
      static_tokens: n(r.static_tokens),
      connections: n(r.connections)
    }
  } catch {
    return null
  }
}

/**
 * Belt and braces (security review): every credential the grantee MADE during the grant ends
 * with it — API keys they created (for anyone), static tokens they minted (for anyone), and their
 * own OAuth / phone / MCP connections opened since the grant began. Run-as and View-as tokens
 * stop on their own: they need their issuer to be an administrator still (isActiveAdmin judges
 * the grant). Found through the activity log and the keys' own rows; never throws.
 */
export async function revokeGrantCredentials(
  k: Knex,
  userId: string,
  since: string | null | undefined
): Promise<RevokedCredentials> {
  const out: RevokedCredentials = { api_keys: 0, static_tokens: 0, connections: 0 }
  const from = since ? new Date(since) : new Date(0)
  const activityItems = async (action: string, collection: string) => {
    try {
      const rows = (await k('nivaro_activity')
        .where({ user: userId, action, collection })
        .where('timestamp', '>=', from)
        .select('item')
        .limit(1000)) as Array<{ item: unknown }>
      return [...new Set(rows.map((r) => String(r.item ?? '')).filter(Boolean))]
    } catch {
      return [] as string[]
    }
  }
  try {
    const logged = (await activityItems('api_key_created', 'nivaro_api_keys'))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
    const keys = (await k('nivaro_api_keys')
      .where('is_active', true)
      .where((w) => {
        w.where((x) => x.where('user', userId).where('created_at', '>=', from))
        if (logged.length) w.orWhereIn('id', logged)
      })
      .select('id')) as Array<{ id: unknown }>
    if (keys.length) {
      out.api_keys = await k('nivaro_api_keys')
        .whereIn(
          'id',
          keys.map((x) => Number(x.id))
        )
        .update({ is_active: false })
    }
  } catch {
    /* no keys table here */
  }
  try {
    const minted = await activityItems('token.generate', 'nivaro_users')
    if (minted.length)
      out.static_tokens = await k('nivaro_users')
        .whereIn('id', minted.slice(0, 500))
        .whereNotNull('static_token')
        .update({ static_token: null })
  } catch {
    /* best effort */
  }
  try {
    const redis = (getApp() as { redis?: unknown } | null)?.redis
    if (redis) {
      const store = await import('./oauth-store.js')
      const grants = await store.listGrants(redis as never, userId)
      for (const g of grants)
        if (
          Date.parse(g.created_at) >= from.getTime() &&
          (await store.revokeGrant(redis as never, userId, g.id))
        )
          out.connections++
    }
  } catch {
    /* best effort */
  }
  return out
}

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

/** Who last wrote the account after the grant started (the activity log), as a name. */
async function lastWriter(trx: Knex, userId: string, since: unknown): Promise<string | null> {
  try {
    const row = (await trx('nivaro_activity')
      .where({ collection: 'nivaro_users', item: userId })
      .where('timestamp', '>=', since ?? new Date(0))
      .orderBy('id', 'desc')
      .first('user')) as { user: unknown } | undefined
    if (!row?.user) return null
    const u = (await trx('nivaro_users')
      .where({ id: row.user })
      .first('first_name', 'last_name', 'email')) as Record<string, unknown> | undefined
    const name = [u?.first_name, u?.last_name].filter((x) => typeof x === 'string' && x).join(' ')
    return (name || String(u?.email ?? row.user)).slice(0, 200)
  } catch {
    return null
  }
}

/**
 * Ends one grant inside `trx` (see the header). The caller runs `afterGrantEnded` after commit.
 * A grant already ended answers its recorded end.
 */
export async function endGrantInTrx(
  trx: Knex.Transaction,
  grantId: number,
  reason: EndReason,
  now: Date = new Date()
): Promise<GrantEnd | null> {
  const r = (await trx(GRANTS).where({ id: grantId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  const g = grantFromRow(r)
  if (r.ended_at != null)
    return {
      grant: g,
      state: (String(r.end_state ?? 'none') as EndState) || 'none',
      changed_by: (r.changed_by as string | null) ?? null,
      changed_to: (r.changed_to as string | null) ?? null,
      revoked: readRevoked(r.revoked_credentials)
    }
  let state: EndState = 'none'
  let changedBy: string | null = null
  let changedTo: string | null = null
  if (g.user_id) {
    const u = (await trx('nivaro_users').where({ id: g.user_id }).first('id', 'role')) as
      | { id: unknown; role: unknown }
      | undefined
    if (u) {
      const current = u.role
        ? ((await trx('nivaro_roles').where({ id: u.role }).first('id', 'name', 'admin_access')) as
            | { id: unknown; name?: unknown; admin_access?: unknown }
            | undefined)
        : undefined
      const changed = !sameId(u.role, g.role)
      if (changed) {
        changedBy = await lastWriter(trx, String(u.id), r.granted_at)
        changedTo = current?.name
          ? String(current.name).slice(0, 200)
          : u.role
            ? String(u.role)
            : 'no role'
      }
      if (roleAfterGrant(current ?? null, g) === 'restore') {
        await trx('nivaro_users').where({ id: u.id }).update({ role: g.prev_role, updated_at: now })
        state = changed ? 'restored_over_change' : 'restored'
      } else state = 'role_changed'
    }
  }
  await trx(GRANTS).where({ id: g.id }).whereNull('ended_at').update({
    ended_at: now,
    end_reason: reason,
    end_state: state,
    changed_by: changedBy,
    changed_to: changedTo
  })
  return { grant: g, state, changed_by: changedBy, changed_to: changedTo }
}

/** After a grant ended (committed): sockets, room re-checks, verdict caches, the app's log. */
export async function afterGrantEnded(
  end: GrantEnd,
  reason: EndReason,
  why: string,
  k: Knex = db
): Promise<void> {
  const userId = end.grant.user_id
  if (userId) {
    const revoked = await revokeGrantCredentials(k, userId, end.grant.granted_at)
    end.revoked = revoked
    await k(GRANTS)
      .where({ id: end.grant.id })
      .update({ revoked_credentials: JSON.stringify(revoked) })
      .catch(() => undefined)
    try {
      const sockets = await import('./socket-access.js')
      sockets.endUserSockets(userId, 'account_inactive')
      sockets.requestAccessRecheck({ userIds: [userId] })
    } catch {
      // no socket server in this process
    }
    try {
      ;(await import('./access-stamp.js')).bumpAccessStamp()
    } catch {
      /* best effort */
    }
  }
  try {
    const { logActivity } = await import('./activity.js')
    await logActivity({
      action: 'hub-break-glass-revoke',
      user: null,
      collection: 'nivaro_users',
      item: userId ?? undefined,
      comment: (end.state === 'role_changed'
        ? `Break-glass ${end.grant.ref} ended (${why}); ${end.changed_by ?? 'someone'} had changed the role to ${end.changed_to ?? 'another role'} without admin access, which stays`
        : end.state === 'restored_over_change'
          ? `Break-glass ${end.grant.ref} ended (${why}); ${end.changed_by ?? 'someone'} had changed the role to ${end.changed_to ?? 'another admin role'} — the role the grant replaced is back`
          : `Break-glass ${end.grant.ref} ended (${why}); the role it replaced is back`
      )
        .concat(
          end.revoked && end.revoked.api_keys + end.revoked.static_tokens + end.revoked.connections
            ? `; revoked what was made during it: ${end.revoked.api_keys} API key(s), ${end.revoked.static_tokens} static token(s), ${end.revoked.connections} connection(s)`
            : ''
        )
        .slice(0, 1000),
      origin: 'integration'
    })
  } catch {
    /* the end stands */
  }
  void reason
}

/** Ends one grant (own transaction) and runs the after-steps. */
export async function endGrant(
  grantId: number,
  reason: EndReason,
  why: string,
  k: Knex = db,
  now: Date = new Date()
): Promise<GrantEnd | null> {
  const end = await k.transaction((trx) => endGrantInTrx(trx, grantId, reason, now))
  if (end && end.grant.user_id) await afterGrantEnded(end, reason, why, k)
  await clearMarkerIfNone(k)
  return end
}

/** Every unended grant of these accounts, ended inside `trx` (an offboard suspends next). */
export async function endLiveGrantsInTrx(
  trx: Knex.Transaction,
  userIds: string[],
  reason: EndReason,
  now: Date = new Date()
): Promise<GrantEnd[]> {
  if (!userIds.length || !(await grantsTableReady(trx))) return []
  const rows = (await trx(GRANTS)
    .whereIn('user_id', userIds)
    .whereNull('ended_at')
    .select('id')) as Array<{ id: unknown }>
  const out: GrantEnd[] = []
  for (const r of rows) {
    const e = await endGrantInTrx(trx, Number(r.id), reason, now)
    if (e) out.push(e)
  }
  return out
}

/** The request path saw an ended grant: make it real (idempotent; never throws). */
export function endLiveGrantsOf(grant: GrantRow, k: Knex = db): void {
  void endGrant(
    grant.id,
    grantEnded({ ends_at: grant.ends_at }) && grant.ends_at ? 'expired' : 'unreadable',
    'its time ran out',
    k
  ).catch(() => undefined)
}

/**
 * The app's own revoke (core job hub-break-glass-expire, every minute, per app on a shared
 * deployment; a cheap no-op without the table or rows): every unended grant whose time ran out
 * or whose end time cannot be read.
 */
export async function expireGrants(k: Knex = db, now: Date = new Date()): Promise<string[]> {
  if (!breakGlassPossible() || !(await grantsTableReady(k))) return []
  // Open grants keep the marker set (a Redis restart or flush cannot hide them past a minute).
  const anyOpen = (await k(GRANTS).whereNull('ended_at').whereNotNull('user_id').first('id')) as
    | { id: unknown }
    | undefined
  if (anyOpen && (await openGrantsMarker(0)) !== 'some')
    await markGrantsOpen().catch(() => undefined)
  const rows = (await k(GRANTS)
    .whereNull('ended_at')
    .whereNotNull('user_id')
    .where((w) => w.whereNull('ends_at').orWhere('ends_at', '<=', now))
    .select('id', 'ends_at')
    .limit(500)) as Array<{ id: unknown; ends_at: unknown }>
  const done: string[] = []
  for (const r of rows) {
    const reason: EndReason = iso(r.ends_at) ? 'expired' : 'unreadable'
    const end = await endGrant(Number(r.id), reason, 'its time ran out', k, now)
    if (end?.grant.user_id) done.push(end.grant.user_id)
  }
  return done
}

/** Ends every grant of these accounts whose time ran out (the socket sweep). Never throws. */
export async function endDueGrantsOf(userIds: string[], k: Knex = db): Promise<number> {
  if (!userIds.length || !breakGlassPossible()) return 0
  if ((await openGrantsMarker()) === 'none' || !(await grantsTableReady(k))) return 0
  const now = new Date()
  let n = 0
  for (let i = 0; i < userIds.length; i += 200) {
    const rows = (await k(GRANTS)
      .whereIn('user_id', userIds.slice(i, i + 200))
      .whereNull('ended_at')
      .where((w) => w.whereNull('ends_at').orWhere('ends_at', '<=', now))
      .select('id', 'ends_at')) as Array<{ id: unknown; ends_at: unknown }>
    for (const r of rows) {
      const end = await endGrant(
        Number(r.id),
        iso(r.ends_at) ? 'expired' : 'unreadable',
        'its time ran out',
        k,
        now
      ).catch(() => null)
      if (end) n++
    }
  }
  return n
}

// ─── Boot sweep: a grant never survives on an install that cannot judge it ─────────────────

export const UNLINKED_WHY = 'ended at boot: this install is not linked to the Hub'
const SWEEP_EVERY_MS = 60 * 60_000

/**
 * Once per boot on every single-app install (server.ts, background pool, never fails the boot):
 * when the grants table holds open grants, end them through the one end path (role back,
 * revocations, log). An install NOT linked to a Hub ends every open grant — nothing there would
 * judge or expire it (a database copied from a linked app); a linked install ends only the ones
 * whose time ran out (the others are live, the Hub and the expiry job end them on time).
 * Answers the account ids put back.
 */
export async function sweepOpenGrantsAtBoot(
  k: Knex = db,
  now: Date = new Date()
): Promise<string[]> {
  if (typeof (k as { schema?: { hasTable?: unknown } }).schema?.hasTable !== 'function') return []
  if (!(await k.schema.hasTable(GRANTS))) return []
  const linked = breakGlassPossible()
  const q = k(GRANTS)
    .whereNull('ended_at')
    .whereNotNull('user_id')
    .select('id', 'ends_at')
    .limit(500)
  if (linked) q.where((w) => w.whereNull('ends_at').orWhere('ends_at', '<=', now))
  const rows = (await q) as Array<{ id: unknown; ends_at: unknown }>
  const done: string[] = []
  for (const r of rows) {
    const reason: EndReason = !linked ? 'unlinked' : iso(r.ends_at) ? 'expired' : 'unreadable'
    const end = await endGrant(
      Number(r.id),
      reason,
      linked ? 'its time ran out' : UNLINKED_WHY,
      k,
      now
    ).catch(() => null)
    if (end?.grant.user_id) done.push(end.grant.user_id)
  }
  return done
}

const sweepTimer = appBox<NodeJS.Timeout | null>(() => null)

/**
 * On an install NOT linked to a Hub, while open grants remain (a sweep that could not end one),
 * the same sweep every hour as a plain in-process timer — no cron. Stops when none are left.
 */
export async function startUnlinkedGrantSweep(k: Knex = db): Promise<boolean> {
  if (breakGlassPossible() || sweepTimer.value) return false
  if (typeof (k as { schema?: { hasTable?: unknown } }).schema?.hasTable !== 'function')
    return false
  if (!(await k.schema.hasTable(GRANTS))) return false
  const open = async () =>
    !!(await k(GRANTS).whereNull('ended_at').whereNotNull('user_id').first('id'))
  if (!(await open())) return false
  const t = setInterval(() => {
    void (async () => {
      try {
        await sweepOpenGrantsAtBoot(k)
        if (!(await open())) stopUnlinkedGrantSweep()
      } catch {
        /* next hour */
      }
    })()
  }, SWEEP_EVERY_MS)
  t.unref?.()
  sweepTimer.value = t
  return true
}

export function stopUnlinkedGrantSweep(): void {
  if (sweepTimer.value) clearInterval(sweepTimer.value)
  sweepTimer.value = null
}

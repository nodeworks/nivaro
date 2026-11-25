import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { appBox } from './app-state.js'
import { type GrantRow, grantEnded, roleAfterGrant } from './break-glass-role.js'

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
    ends_at: iso(r.ends_at)
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
  if (!(await grantsTableReady(k))) {
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
  if (!(await grantsTableReady(k))) return qb
  return qb.whereNotExists(
    k(GRANTS)
      .select(k.raw('1'))
      .whereRaw('?? = ??', [`${GRANTS}.user_id`, col])
      .whereNull(`${GRANTS}.ended_at`)
  ) as Q
}

export type EndReason = 'expired' | 'revoked' | 'offboarded' | 'unreadable'
export type EndState = 'restored' | 'restored_over_change' | 'role_changed' | 'none'

export interface GrantEnd {
  grant: GrantRow
  state: EndState
  changed_by: string | null
  changed_to: string | null
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
      changed_to: (r.changed_to as string | null) ?? null
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
  why: string
): Promise<void> {
  const userId = end.grant.user_id
  if (userId) {
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
      ).slice(0, 1000),
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
  if (end && end.grant.user_id) await afterGrantEnded(end, reason, why)
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
  if (!(await grantsTableReady(k))) return []
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
  if (!userIds.length || !(await grantsTableReady(k))) return 0
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

import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'

/**
 * Keeping the assistant's ops posts with administrators (#1967/#2015/#2016).
 *
 * The ops-room test (services/ops-assistant.ts) decides what the assistant
 * may post NOW; it cannot take back what is already in the room. Two layers
 * keep earlier posts from reaching someone who is not an administrator:
 *
 *  1. Membership: the configured ops channel, and any channel that already
 *     holds assistant ops posts, only ever gains active administrators — the
 *     join, add, bulk-add and auto-join paths refuse anyone else, and the
 *     channel cannot be opened up to everyone or to a non-admin role.
 *  2. Reading: every assistant ops message carries `ops_only` (migration
 *     442), and message lists, search, mentions, pins, saved messages and the
 *     room summary drop those rows for a viewer who is not an administrator
 *     (a demoted member, a role channel changed behind our back).
 */

export const OPS_ONLY_CODE = 'OPS_CHANNEL_ADMINS_ONLY'
export const OPS_ONLY_MESSAGE =
  'Only administrators can be in this channel — it holds the assistant’s operations posts.'

const TTL_MS = 30_000
const guardCache = new Map<string, { at: number; guarded: boolean }>()

export function bustOpsGuard(): void {
  guardCache.clear()
}

/** Active (status 'active'), unredacted accounts whose current role has admin_access. */
export async function activeAdminIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.map((i) => String(i)).filter(Boolean))]
  const out = new Set<string>()
  for (let i = 0; i < unique.length; i += 1000) {
    const rows = (await db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .whereIn('u.id', unique.slice(i, i + 1000))
      .where('u.status', 'active')
      .where((w) => w.where('u.is_redacted', false).orWhereNull('u.is_redacted'))
      .where('r.admin_access', true)
      .select('u.id')
      .catch(() => [])) as Array<{ id: string }>
    for (const r of rows) out.add(String(r.id).toUpperCase())
  }
  return out
}

/**
 * Whether a room only admits administrators: it is the configured ops
 * channel, or a channel holding at least one assistant ops post.
 */
export async function isOpsGuardedRoom(room: string): Promise<boolean> {
  if (!room.startsWith('ch:')) return false
  const key = `${getTenantId() ?? ''}|${room}`
  const hit = guardCache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.guarded
  let guarded = false
  if (await hasColumn('nivaro_settings', 'ops_channel')) {
    const row = (await db('nivaro_settings')
      .orderBy('id', 'asc')
      .first('ops_channel')
      .catch(() => undefined)) as { ops_channel?: string | null } | undefined
    guarded = !!row?.ops_channel && row.ops_channel === room
  }
  if (!guarded && (await hasColumn('chat_messages', 'ops_only'))) {
    const msg = await db('chat_messages')
      .where({ room, ops_only: true })
      .first('id')
      .catch(() => undefined)
    guarded = !!msg
  }
  guardCache.set(key, { at: Date.now(), guarded })
  return guarded
}

/** The ids among `userIds` that may NOT join this room ([] when the room is not guarded). */
export async function nonAdminsFor(room: string, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0 || !(await isOpsGuardedRoom(room))) return []
  const admins = await activeAdminIds(userIds)
  return userIds.filter((u) => !admins.has(String(u).toUpperCase()))
}

/** Whether a channel patch would let non-administrators see a guarded room. */
export async function patchOpensOpsRoom(
  room: string,
  next: { visibility?: unknown; role?: unknown }
): Promise<boolean> {
  if (next.visibility === undefined && next.role === undefined) return false
  if (!(await isOpsGuardedRoom(room))) return false
  if (next.visibility === 'open') return true
  if (next.visibility === 'role' || next.role) {
    if (!next.role) return true
    const role = (await db('nivaro_roles')
      .where({ id: String(next.role) })
      .first('admin_access')
      .catch(() => undefined)) as { admin_access?: boolean | number } | undefined
    return !role?.admin_access
  }
  return false
}

/** Mark an assistant message as an ops post (admins only to read). */
export async function markOpsOnly(
  messageId: number | null | undefined,
  room: string
): Promise<void> {
  if (!messageId || !(await hasColumn('chat_messages', 'ops_only'))) return
  await db('chat_messages').where({ id: messageId }).update({ ops_only: true })
  guardCache.set(`${getTenantId() ?? ''}|${room}`, { at: Date.now(), guarded: true })
}

/**
 * The read-side layer: for a viewer who is not an administrator, drop ops
 * posts. Resolve once per request (`await opsOnlyHider(isAdmin)`) and apply
 * the returned function to each query.
 */
export async function opsOnlyHider(
  viewerIsAdmin: boolean
): Promise<(qb: Knex.QueryBuilder, col?: string) => Knex.QueryBuilder> {
  if (viewerIsAdmin || !(await hasColumn('chat_messages', 'ops_only'))) return (qb) => qb
  return (qb, col = 'ops_only') => qb.where((w) => w.whereNull(col).orWhere(col, false))
}

/**
 * One message by id, as the viewer may see it — the same rule as the lists:
 * an ops post does not exist for a viewer who is not an administrator (copy
 * to notes, attach to record, reactions, edit, delete, pin, save, thread
 * and quote targets all load through here).
 */
export async function loadVisibleMessage(
  id: number,
  viewerIsAdmin: boolean
): Promise<Record<string, any> | undefined> {
  if (!Number.isFinite(id)) return undefined
  const hide = await opsOnlyHider(viewerIsAdmin)
  return hide(db('chat_messages').where('id', id)).first()
}

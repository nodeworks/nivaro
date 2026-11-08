import { runInBackgroundPool } from '../db/pool-context.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * WHEN a person joins their role's default channels (#960, 2026-11-08).
 *
 * The join itself lives in services/chat.ts (`autoJoinDefaultChannels` for one person,
 * `joinDefaultChannelsForUsers` / `backfillDefaultRoles` for many): once per person and room,
 * recorded in nivaro_chat_auto_joins so leaving sticks; the ops-room guard keeps the
 * assistant's ops channel to administrators.
 *
 * It used to run only when the person opened Chat — production General had 12 members out of
 * 866 people in its default roles. Now it also runs:
 *  - when a person is GIVEN a role: account creation, a role change, a reactivation
 *    (`joinDefaultChannelsSoon` from every core place a role is written);
 *  - when an admin saves a channel's (or General's) default roles: everyone active in those
 *    roles (`backfillDefaultRolesSoon`);
 *  - on a signed-in person's request (`autoJoinOnRequest`), memoised ten minutes per person
 *    and role, so a role changed outside the app (raw SQL, another process) is noticed.
 *
 * Every entry point is fire-and-forget on the background pool: it never slows or fails the
 * write or request that triggered it. Leaf module — chat.ts is imported lazily, so the users
 * service and the authenticate middleware can load this without pulling the chat graph in.
 */

const MEMO_MS = 10 * 60_000
const MEMO_MAX = 50_000

/** tenant|USER|ROLE → when the default channels were last checked for that person and role.
 *  Tenant-keyed: module state is shared by every cloud tenant. */
const checked = new Map<string, number>()

function memoKey(userId: unknown, role: unknown): string {
  return `${currentTenantKey()}|${String(userId).toUpperCase()}|${String(role).toUpperCase()}`
}

/** Whether this person's default channels for this role are due a check (not seen in 10 min). */
export function autoJoinDue(userId: unknown, role: unknown): boolean {
  if (!userId || !role) return false
  const at = checked.get(memoKey(userId, role))
  return !at || Date.now() - at >= MEMO_MS
}

/** Note that this person's default channels for this role were just checked. */
export function markAutoJoinChecked(userId: unknown, role: unknown): void {
  if (!userId || !role) return
  if (checked.size >= MEMO_MAX) {
    const now = Date.now()
    for (const [k, at] of checked) if (now - at >= MEMO_MS) checked.delete(k)
    if (checked.size >= MEMO_MAX) checked.clear()
  }
  checked.set(memoKey(userId, role), Date.now())
}

/** Tests only. */
export function resetAutoJoinMemo(): void {
  checked.clear()
}

function warn(label: string, err: unknown): void {
  console.warn(
    `[chat] default-channel join (${label}) failed:`,
    (err as Error)?.message ?? String(err)
  )
}

/**
 * Run `work` on the background pool without holding the caller. The tenant context (an
 * AsyncLocalStorage) carries into the work because it starts inside the caller's context.
 * The returned promise never rejects; callers `void` it (tests await it).
 */
function inBackground(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    return Promise.resolve(runInBackgroundPool(work)).then(
      () => undefined,
      (err) => warn(label, err)
    )
  } catch (err) {
    warn(label, err)
    return Promise.resolve()
  }
}

function idList(ids: Iterable<unknown>): string[] {
  const out = new Set<string>()
  for (const id of ids) if (id != null && String(id).trim()) out.add(String(id).trim())
  return [...out]
}

/**
 * These people were just given a role (new account, role change, reactivation): join each to
 * their role's default channels now. Suspended accounts and machine accounts are skipped by
 * the join; a channel a person left before stays left.
 */
export function joinDefaultChannelsSoon(userIds: Iterable<unknown>, why: string): Promise<void> {
  const ids = idList(userIds)
  if (ids.length === 0) return Promise.resolve()
  return inBackground(why, async () => {
    const { joinDefaultChannelsForUsers } = await import('./chat.js')
    await joinDefaultChannelsForUsers(ids)
  })
}

/**
 * A channel's (or General's) default roles were saved: everyone ACTIVE in those roles joins
 * the default channels of their role. Answers at once — 900+ people never hold a request.
 */
export function backfillDefaultRolesSoon(roleIds: Iterable<unknown>, why: string): Promise<void> {
  const roles = idList(roleIds)
  if (roles.length === 0) return Promise.resolve()
  return inBackground(why, async () => {
    const { backfillDefaultRoles } = await import('./chat.js')
    await backfillDefaultRoles(roles)
  })
}

/** What the request safety net needs to know about how a request signed in. */
export interface AutoJoinRequestFacts {
  authMethod?: string
  masqueradeAdminId?: string
  apiKeyId?: number | null
  apiKeySimulatedId?: number | null
  oauthClientId?: string
  mcpInner?: boolean
  user?: { id?: unknown; role?: unknown; account_kind?: unknown; status?: unknown } | null
}

/**
 * Only a real person signed in as themselves: a browser session or the phone app. Never an
 * API key, run-as-key, static token, connected app (OAuth/MCP), an MCP tool's inner call, a
 * View-as, or a machine account.
 */
export function requestMayAutoJoin(req: AutoJoinRequestFacts): boolean {
  const u = req.user
  if (!u?.id || !u.role) return false
  if (req.authMethod !== 'session' && req.authMethod !== 'device') return false
  if (req.masqueradeAdminId || req.mcpInner || req.oauthClientId) return false
  if (req.apiKeyId != null || req.apiKeySimulatedId != null) return false
  if (u.account_kind) return false
  if (u.status != null && u.status !== 'active') return false
  return true
}

/**
 * The authenticate safety net: a Map lookup on almost every request; at most once per ten
 * minutes per person and role it checks their default channels in the background.
 */
export function autoJoinOnRequest(req: AutoJoinRequestFacts): void {
  try {
    if (!requestMayAutoJoin(req)) return
    const user = req.user as { id: unknown; role: unknown }
    if (!autoJoinDue(user.id, user.role)) return
    // Marked before the work starts, so concurrent requests start it once.
    markAutoJoinChecked(user.id, user.role)
    void inBackground('request', async () => {
      const { autoJoinDefaultChannels } = await import('./chat.js')
      await autoJoinDefaultChannels(user as never, { force: true })
    })
  } catch (err) {
    warn('request', err)
  }
}

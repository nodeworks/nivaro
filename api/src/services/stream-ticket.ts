import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import {
  type BindSource,
  bindFromRequest,
  checkBind,
  type EndReason,
  encodeBoundToken,
  parseWsTokenValue,
  type SocketBind,
  userWithApiKey
} from './socket-access.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * One-shot stream tickets (#602, #1719, #1749) and the identity behind a long-lived stream.
 *
 * A credential-less client (EventSource, a browser graphql-ws connection that cannot send the
 * session cookie's identity as a header) first asks the authenticated `GET /events/ticket` and
 * opens its stream with the ticket: 60s TTL, deleted on first use, and it records exactly what
 * signed the minting request in (session, View-as, static token, API key). Cloud: the ticket
 * also records the tenant it was minted in and opens nothing on another tenant's host.
 *
 * A stream then re-reads its identity through `streamIdentity` — the bind is still good
 * (checkBind) and the account row, role and API key narrowing are read fresh — so a revoked
 * key, an ended session or a changed role reaches a stream that is already open.
 */

const TICKET_TTL_S = 60
const TICKET_PREFIX = 'sse:ticket:'
const TICKET_SHAPE = /^[a-f0-9-]{36}$/i

export interface StreamIdentity {
  user: User
  isAdmin: boolean
}

/** Mint a ticket for the request's own sign-in. Null when that sign-in cannot open a stream. */
export async function mintStreamTicket(
  redis: Redis,
  req: BindSource & { user?: User }
): Promise<string | null> {
  const bind = bindFromRequest(req)
  if (!bind || !req.user) return null
  const ticket = randomUUID()
  const value = JSON.parse(encodeBoundToken(String(req.user.id), bind)) as Record<string, unknown>
  value.t = currentTenantKey()
  await redis.setex(`${TICKET_PREFIX}${ticket}`, TICKET_TTL_S, JSON.stringify(value))
  return ticket
}

/**
 * Redeem a ticket once (GETDEL). Returns who minted it and what signed them in, or null: an
 * unknown, used or expired ticket, one without a bind (an older API's bare user id), one minted
 * in another tenant, or a sign-in that has already ended.
 */
export async function redeemStreamTicket(
  redis: Redis,
  ticket: string | undefined | null
): Promise<{ userId: string; bind: SocketBind } | null> {
  if (!ticket || !TICKET_SHAPE.test(ticket)) return null
  const raw = (await redis.getdel(`${TICKET_PREFIX}${ticket}`).catch(() => null)) as string | null
  if (!raw) return null
  const minted = parseWsTokenValue(raw)
  if (!minted.userId || !minted.bind) return null
  let tenant = ''
  try {
    tenant = String((JSON.parse(raw) as { t?: unknown }).t ?? '')
  } catch {
    return null
  }
  if (tenant !== currentTenantKey()) return null
  if (await checkBind(redis, minted.userId, minted.bind)) return null
  return { userId: minted.userId, bind: minted.bind }
}

/**
 * The account behind a stream, read fresh: the active user row, the role's admin access and,
 * for an API key, that key's scopes, row restrictions and GraphQL depth cap. Null when the
 * account cannot act or the key is no longer usable.
 */
export async function loadStreamIdentity(
  userId: string,
  bind: SocketBind
): Promise<StreamIdentity | null> {
  let user = (await db('nivaro_users').where({ id: userId, status: 'active' }).first()) as
    | User
    | undefined
  if (!user || (user as { is_redacted?: unknown }).is_redacted) return null
  if (bind.kind === 'apikey') {
    const narrowed = await userWithApiKey(user, bind.id)
    if (!narrowed) return null
    const key = (await db('nivaro_api_keys')
      .where({ id: bind.id })
      .first('graphql_max_depth', 'sandbox')) as
      | { graphql_max_depth?: number | null; sandbox?: boolean | number | null }
      | undefined
    if (key?.graphql_max_depth != null)
      narrowed.api_key_graphql_max_depth = Number(key.graphql_max_depth)
    if (key?.sandbox === true || key?.sandbox === 1) narrowed.api_key_sandbox = true
    user = narrowed
  }
  let isAdmin = false
  if (user.role) {
    const role = (await db('nivaro_roles').where({ id: user.role }).first('admin_access')) as
      | { admin_access?: boolean | number }
      | undefined
    isAdmin = !!role?.admin_access
  }
  return { user, isAdmin }
}

/**
 * A stream's identity check: null (and why) when the sign-in ended, else the fresh identity.
 * A failed check (database or Redis briefly away) keeps the last identity — it never ends a
 * stream by itself; the next check asks again.
 */
export async function recheckStreamIdentity(
  redis: Redis,
  userId: string,
  bind: SocketBind,
  last: StreamIdentity
): Promise<{ identity: StreamIdentity | null; reason: EndReason | null }> {
  try {
    const ended = await checkBind(redis, userId, bind)
    if (ended) return { identity: null, reason: ended }
    const identity = await loadStreamIdentity(userId, bind)
    return identity
      ? { identity, reason: null }
      : { identity: null, reason: bind.kind === 'apikey' ? 'key_revoked' : 'account_inactive' }
  } catch {
    return { identity: last, reason: null }
  }
}

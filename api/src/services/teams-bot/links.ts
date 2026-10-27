import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'
import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { canSignIn, getUser } from '../users.js'

// Who is who: one nivaro_teams_links row per Teams person linked to a Nivaro user (spec §4).

const LINKS = 'nivaro_teams_links'
const CONNECT_TTL_SECONDS = 10 * 60

export type TeamsLinkStatus = 'active' | 'uninstalled' | 'blocked' | 'unlinked'

export interface TeamsLink {
  id: number
  user_id: string
  aad_object_id: string
  tenant_id: string
  conversation_id: string
  service_url: string
  status: TeamsLinkStatus
  linked_by: 'entra_oid' | 'sign_in'
  last_error: string | null
}

type LinkRow = Omit<TeamsLink, 'conversation_id' | 'service_url'> & {
  conversation_id: string | null
  service_url: string | null
}

const oidKey = (v: string) => String(v).trim().toLowerCase()

// A link made before the person ever messaged the bot has no conversation yet:
// it reads as '' so the sender treats it as not connected.
function shape(row: LinkRow): TeamsLink {
  return {
    id: Number(row.id),
    user_id: String(row.user_id),
    aad_object_id: row.aad_object_id,
    tenant_id: row.tenant_id,
    conversation_id: row.conversation_id ?? '',
    service_url: row.service_url ?? '',
    status: row.status,
    linked_by: row.linked_by,
    last_error: row.last_error ?? null
  }
}

async function byOid(aadObjectId: string): Promise<TeamsLink | null> {
  const row = (await db(LINKS)
    .where({ aad_object_id: oidKey(aadObjectId) })
    .first()) as LinkRow | undefined
  return row ? shape(row) : null
}

export async function resolveTeamsUser(
  aadObjectId: string,
  tenantId: string
): Promise<
  | { user: User; link: TeamsLink | null }
  | { user: null; reason: 'not_found' | 'inactive' | 'machine' }
> {
  const oid = oidKey(aadObjectId)
  const existing = await byOid(oid)
  let user: User | undefined
  let link: TeamsLink | null = null
  if (existing?.status === 'active') {
    link = existing
    user = await getUser(existing.user_id)
  }
  if (!user) {
    const row = (await db('nivaro_users')
      .whereRaw('LOWER(entra_oid) = ?', [oid])
      .whereRaw('LOWER(entra_tid) = ?', [oidKey(tenantId)])
      .first('id')) as { id: string } | undefined
    user = row ? await getUser(String(row.id)) : undefined
    link = null
  }
  if (!user) return { user: null, reason: 'not_found' }
  if (!canSignIn(user)) return { user: null, reason: 'inactive' }
  if ((user as { account_kind?: string | null }).account_kind)
    return { user: null, reason: 'machine' }
  return { user, link }
}

export async function upsertLink(
  userId: string,
  p: {
    aadObjectId: string
    tenantId: string
    conversationId: string | null
    serviceUrl: string | null
    linkedBy: 'entra_oid' | 'sign_in'
  }
): Promise<TeamsLink> {
  const oid = oidKey(p.aadObjectId)
  const now = new Date()
  const existing = await byOid(oid)
  if (existing) {
    // A live link belongs to its person: another account must not take it over.
    if (existing.status === 'active' && existing.user_id.toLowerCase() !== userId.toLowerCase())
      throw new Error('This Teams account is already linked to another Nivaro user')
    await db(LINKS)
      .where({ id: existing.id })
      .update({
        user_id: userId,
        tenant_id: p.tenantId,
        ...(p.conversationId ? { conversation_id: p.conversationId } : {}),
        ...(p.serviceUrl ? { service_url: p.serviceUrl } : {}),
        status: 'active',
        linked_by: p.linkedBy,
        linked_at: now,
        last_error: null
      })
  } else {
    await db(LINKS).insert({
      user_id: userId,
      aad_object_id: oid,
      tenant_id: p.tenantId,
      conversation_id: p.conversationId,
      service_url: p.serviceUrl,
      status: 'active',
      linked_by: p.linkedBy,
      installed_at: p.conversationId ? now : null,
      linked_at: now
    })
  }
  return (await byOid(oid)) as TeamsLink
}

export async function markLink(
  aadObjectId: string,
  status: 'uninstalled' | 'blocked' | 'unlinked',
  error?: string
): Promise<void> {
  await db(LINKS)
    .where({ aad_object_id: oidKey(aadObjectId) })
    .update({ status, last_error: error ? error.slice(0, 500) : null })
}

/** The person's working link (active), newest first; null = never connected. */
export async function linkForUser(userId: string): Promise<TeamsLink | null> {
  const row = (await db(LINKS)
    .where({ user_id: userId, status: 'active' })
    .orderBy('linked_at', 'desc')
    .first()) as LinkRow | undefined
  return row ? shape(row) : null
}

/** Bookkeeping after a send: stamps last_sent_at (and clears a stale error). */
export async function noteLinkSent(aadObjectId: string): Promise<void> {
  await db(LINKS)
    .where({ aad_object_id: oidKey(aadObjectId) })
    .update({ last_sent_at: new Date(), last_error: null })
}

export async function noteLinkError(aadObjectId: string, error: string): Promise<void> {
  await db(LINKS)
    .where({ aad_object_id: oidKey(aadObjectId) })
    .update({ last_error: error.slice(0, 500) })
}

// ─── Connect token: proves "this Teams person" through the sign-in round trip ───

const b64url = (buf: Buffer) => buf.toString('base64url')
const hmac = (data: string) => createHmac('sha256', config.SESSION_SECRET).update(data).digest()

export function signConnectToken(aadObjectId: string, tenantId: string): string {
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        o: oidKey(aadObjectId),
        t: tenantId,
        exp: Math.floor(Date.now() / 1000) + CONNECT_TTL_SECONDS
      }),
      'utf8'
    )
  )
  return `${body}.${b64url(hmac(body))}`
}

export function readConnectToken(t: string): { aadObjectId: string; tenantId: string } | null {
  const dot = String(t ?? '').lastIndexOf('.')
  if (dot <= 0) return null
  const body = t.slice(0, dot)
  let given: Buffer
  try {
    given = Buffer.from(t.slice(dot + 1), 'base64url')
  } catch {
    return null
  }
  const expected = hmac(body)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      o?: string
      t?: string
      exp?: number
    }
    if (!p.o || !p.t || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null
    return { aadObjectId: p.o, tenantId: p.t }
  } catch {
    return null
  }
}

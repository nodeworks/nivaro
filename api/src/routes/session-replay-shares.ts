import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { notifyUser } from '../services/notification-channels.js'
import { cutSource, parseRange } from '../services/session-replay-clips.js'

/**
 * Shareable replay links (#1362) — never public.
 *
 * An admin shares a window of a recording with ONE named person:
 *
 *   POST   /session-recordings/:id/share {from_ms, to_ms, expires_hours, user_id}
 *     mints a token (only its sha256 is stored), notifies the person and
 *     answers the link once: /session-replays?share=<token>.
 *   GET    /session-recordings/:id/shares — who shared what with whom, until when.
 *   DELETE /session-replay-shares/:id — revoke (the row goes).
 *
 * The person opens it signed in, admin or not:
 *
 *   GET /session-replay-shares/view/:token — who shared it, the window, expiry.
 *   GET /session-replay-shares/view/:token/events — only the window's events,
 *     cut on the fly from the recording (a snapshot to start from plus the
 *     window). Every open is activity-logged; refusals are too.
 *
 * A share opens only for the signed-in person it names, before it expires,
 * and never from a masquerade session (that is the admin, not the person).
 */

export const SHARE_DEFAULT_HOURS = 72
export const SHARE_MAX_HOURS = 24 * 30

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Hours a share lives: default 72, whole hours from 1 to 30 days. */
export function shareHours(raw: unknown): number {
  const n = Number(raw)
  if (raw == null || raw === '' || !Number.isFinite(n)) return SHARE_DEFAULT_HOURS
  return Math.min(SHARE_MAX_HOURS, Math.max(1, Math.round(n)))
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase() && String(a ?? '') !== ''

const nameOf = (alias: string, as: string) =>
  db.raw(
    `LTRIM(RTRIM(CONCAT(COALESCE(${alias}.first_name, ''), ' ', COALESCE(${alias}.last_name, '')))) as ${as}`
  )

interface ShareRow {
  id: string
  recording: string
  from_ms: number
  to_ms: number
  user_id: string
  shared_by: string | null
  expires_at: Date | string
  created_at: Date | string
  shared_by_name?: string | null
}

/**
 * The share a token opens for this request, or the refusal already sent.
 * Order: unknown (404) → someone else / masquerade (403) → expired (410).
 */
async function openableShare(
  req: FastifyRequest,
  reply: FastifyReply,
  token: string
): Promise<ShareRow | null> {
  const share = (await db('nivaro_replay_shares as s')
    .leftJoin('nivaro_users as sb', 'sb.id', 's.shared_by')
    .where('s.token_hash', hashShareToken(String(token)))
    .first(
      's.id',
      's.recording',
      's.from_ms',
      's.to_ms',
      's.user_id',
      's.shared_by',
      's.expires_at',
      's.created_at',
      nameOf('sb', 'shared_by_name')
    )) as ShareRow | undefined
  if (!share) {
    reply.code(404).send({ error: 'This replay link was revoked or never existed' })
    return null
  }
  if (req.masqueradeAdminId || !sameId(share.user_id, req.user?.id)) {
    await logActivity({
      action: 'session-replay-share-denied',
      collection: 'nivaro_replay_shares',
      item: String(share.id),
      user: req.user?.id,
      comment: req.masqueradeAdminId ? 'masquerade session' : 'not the person it was shared with',
      req
    })
    reply.code(403).send({ error: 'This replay was shared with someone else' })
    return null
  }
  if (new Date(share.expires_at).getTime() <= Date.now()) {
    reply.code(410).send({ error: 'This replay link has expired' })
    return null
  }
  return share
}

export async function sessionReplayShareRoutes(app: FastifyInstance) {
  // ── Admin: mint, list, revoke ──────────────────────────────────────────────

  app.post<{
    Params: { id: string }
    Body: { from_ms?: number; to_ms?: number; expires_hours?: number; user_id?: string }
  }>('/session-recordings/:id/share', { preHandler: requireAdmin }, async (req, reply) => {
    const range = parseRange(req.body)
    if (!range) {
      return reply.code(400).send({ error: 'from_ms and to_ms are required, at least 1 s apart' })
    }
    const userId = typeof req.body?.user_id === 'string' ? req.body.user_id.trim() : ''
    // uuid-shaped first: SQL Server refuses to compare a uniqueidentifier with junk.
    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      return reply.code(400).send({ error: 'user_id is required' })
    }
    const person = (await db('nivaro_users')
      .where({ id: userId })
      .first('id', 'first_name', 'last_name', 'email')) as
      | { id: string; first_name?: string | null; last_name?: string | null; email?: string | null }
      | undefined
    if (!person) return reply.code(400).send({ error: 'No such person' })

    // The window must replay — checked now, not when the person opens it.
    const cut = await cutSource(req.params.id, range.fromMs, range.toMs)
    if ('status' in cut) return reply.code(cut.status).send({ error: cut.error })

    const token = randomBytes(24).toString('base64url')
    const hours = shareHours(req.body?.expires_hours)
    const now = new Date()
    const row = {
      id: randomUUID(),
      token_hash: hashShareToken(token),
      recording: cut.source.id,
      from_ms: Math.round(cut.cut.fromMs),
      to_ms: Math.round(cut.cut.toMs),
      user_id: person.id,
      shared_by: req.user!.id,
      expires_at: new Date(now.getTime() + hours * 3_600_000),
      created_at: now,
      open_count: 0
    }
    await db('nivaro_replay_shares').insert(row)
    const who =
      [person.first_name, person.last_name].filter(Boolean).join(' ') || person.email || person.id
    await logActivity({
      action: 'session-replay-share-create',
      collection: 'nivaro_replay_shares',
      item: row.id,
      user: req.user?.id,
      comment: `recording ${row.recording} (${row.from_ms}–${row.to_ms} ms) with ${who} until ${row.expires_at.toISOString()}`,
      req
    })

    const path = `/session-replays?share=${encodeURIComponent(token)}`
    const base = adminBaseUrl()
    try {
      await notifyUser(app, person.id, {
        subject: 'A session replay was shared with you',
        message: `A replay clip was shared with you until ${row.expires_at.toUTCString()}. Open it signed in as yourself: ${base ? `${base}${path}` : path}`,
        sender: req.user!.id,
        category: 'system',
        always_inbox: true,
        ...(base ? { target: { kind: 'external' as const, url: `${base}${path}` } } : {}),
        source: { kind: 'session_replay_share', id: row.id },
        why: 'Someone shared a session replay with you.'
      })
    } catch (err) {
      app.log.warn({ err }, 'Failed to notify the person a replay was shared with')
    }

    const { token_hash: _hash, ...out } = row
    return reply.code(201).send({ data: { ...out, token, url: path } })
  })

  app.get<{ Params: { id: string } }>(
    '/session-recordings/:id/shares',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const rows = (await db('nivaro_replay_shares as s')
        .leftJoin('nivaro_users as u', 'u.id', 's.user_id')
        .leftJoin('nivaro_users as sb', 'sb.id', 's.shared_by')
        .where('s.recording', req.params.id)
        .orderBy('s.created_at', 'desc')
        .select(
          's.id',
          's.from_ms',
          's.to_ms',
          's.user_id',
          's.shared_by',
          's.expires_at',
          's.created_at',
          's.open_count',
          's.last_opened_at',
          nameOf('u', 'user_name'),
          'u.email as user_email',
          nameOf('sb', 'shared_by_name')
        )) as Array<Record<string, unknown>>
      const now = Date.now()
      return reply.send({
        data: rows.map((r) => ({
          ...r,
          expired: new Date(r.expires_at as string).getTime() <= now
        }))
      })
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/session-replay-shares/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const share = (await db('nivaro_replay_shares')
        .where({ id: req.params.id })
        .first('id', 'recording', 'user_id')) as
        | { id: string; recording: string; user_id: string }
        | undefined
      if (!share) return reply.code(404).send({ error: 'Share not found' })
      await db('nivaro_replay_shares').where({ id: share.id }).del()
      await logActivity({
        action: 'session-replay-share-revoke',
        collection: 'nivaro_replay_shares',
        item: share.id,
        user: req.user?.id,
        comment: `recording ${share.recording}, shared with ${share.user_id}`,
        req
      })
      return reply.send({ data: { revoked: true } })
    }
  )

  // ── The person it was shared with ──────────────────────────────────────────

  app.get<{ Params: { token: string } }>(
    '/session-replay-shares/view/:token',
    { preHandler: requireAuth },
    async (req, reply) => {
      const share = await openableShare(req, reply, req.params.token)
      if (!share) return reply
      return reply.send({
        data: {
          id: share.id,
          from_ms: share.from_ms,
          to_ms: share.to_ms,
          duration_ms: Math.max(0, Number(share.to_ms) - Number(share.from_ms)),
          expires_at: share.expires_at,
          created_at: share.created_at,
          shared_by_name: share.shared_by_name || null
        }
      })
    }
  )

  app.get<{ Params: { token: string } }>(
    '/session-replay-shares/view/:token/events',
    { preHandler: requireAuth },
    async (req, reply) => {
      const share = await openableShare(req, reply, req.params.token)
      if (!share) return reply
      const cut = await cutSource(share.recording, Number(share.from_ms), Number(share.to_ms))
      if ('status' in cut) {
        return reply.code(404).send({ error: 'The recording behind this link is no longer kept' })
      }
      await db('nivaro_replay_shares')
        .where({ id: share.id })
        .update({ open_count: db.raw('open_count + 1'), last_opened_at: new Date() })
      await logActivity({
        action: 'session-replay-share-open',
        collection: 'nivaro_replay_shares',
        item: String(share.id),
        user: req.user?.id,
        comment: `recording ${share.recording} (${share.from_ms}–${share.to_ms} ms)`,
        req
      })
      return reply.send({ data: { events: cut.cut.events } })
    }
  )
}

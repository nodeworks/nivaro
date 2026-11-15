import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { getIo } from '../services/io-holder.js'
import {
  endShare,
  forgetShareTicket,
  loadShareTicket,
  personName,
  readShare,
  resolveTarget,
  SHARE_MAX_MS,
  type ShareRedis,
  type ShareState,
  START_REFUSAL_TEXT,
  screenShareEnabled,
  shareLiveness,
  shareOutlived,
  startRefusal,
  ticketOpen,
  watchRefusal,
  writeShare
} from '../services/screen-share.js'
import { announceShareState, screenShareEndDeps } from '../services/screen-share-socket.js'
import {
  DEFAULT_REPLAY_MASKING,
  parseReplayMasking,
  type ReplayMaskingRules
} from '../services/session-replay-masking.js'
import { canSeeTicket, logTicketEvent, viewerOf } from '../services/support-tickets.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { viewAsAdminOf } from '../services/view-as-attribution.js'

/**
 * /api/support/tickets/:id/screen-share — start, read and stop a live screen share
 * (services/screen-share.ts has the rules; screen-share-socket.ts carries the frames).
 *
 *   GET    → { active, share?, can_start, start_refusal?, can_watch, to_name }
 *   POST   → start (the requester, on their own browser session) → { share, masking }
 *   DELETE → stop (the requester; ?share=<id> or { share } — also sent by the page as it closes)
 */

const up = (v: unknown) => String(v ?? '').toUpperCase()

/** The sign-in kind of a request, in the socket's words. */
function requestKind(req: FastifyRequest): string | null {
  if (req.authMethod === 'session') return 'session'
  return req.authMethod ?? null
}

function isViewAs(req: FastifyRequest): boolean {
  return req.authMethod === 'masquerade' || !!viewAsAdminOf(req) || !!req.masqueradeAdminId
}

async function instanceMasking(): Promise<ReplayMaskingRules> {
  try {
    const row = (await db('nivaro_settings').where({ id: 1 }).first('replay_masking')) as
      | { replay_masking?: unknown }
      | undefined
    return parseReplayMasking(row?.replay_masking)
  } catch {
    return DEFAULT_REPLAY_MASKING
  }
}

const log =
  (req?: FastifyRequest) =>
  async (ticket: number, userId: string | null, comment: string, action: string) => {
    await logTicketEvent(ticket, userId, comment, req, action)
  }

function publicShare(s: ShareState) {
  return {
    id: s.id,
    ticket: s.ticket,
    sharer_name: s.sharer_name,
    to: { kind: s.to.kind, name: s.to.name },
    started_at: s.started_at,
    expires_at: s.expires_at,
    max_ms: SHARE_MAX_MS
  }
}

/**
 * A ticket was reassigned, claimed or closed: end its share when it now goes to someone else
 * (exported for routes/support.ts). Best-effort.
 */
export async function screenShareTicketChanged(app: FastifyInstance, ticketId: number) {
  try {
    forgetShareTicket(ticketId)
    const redis = app.redis as unknown as ShareRedis
    const tenant = currentTenantKey()
    const share = await readShare(redis, tenant, ticketId)
    if (!share) return
    const t = await loadShareTicket(ticketId, tenant)
    if (!shareOutlived(share, t)) return
    await endShare(
      screenShareEndDeps(getIo(), { redis, log: log(), now: Date.now }),
      tenant,
      ticketId,
      t && ticketOpen(t) ? 'moved' : 'closed',
      null,
      share.id
    )
  } catch (err) {
    app.log.debug({ err, ticketId }, 'screen share: ticket change check failed')
  }
}

export async function supportScreenShareRoutes(app: FastifyInstance) {
  const redis = () => app.redis as unknown as ShareRedis
  const endDeps = (req: FastifyRequest) =>
    screenShareEndDeps(getIo(), { redis: redis(), log: log(req), now: Date.now })

  /** The ticket, when this caller may see it (else null = 404). */
  async function seenTicket(req: FastifyRequest, raw: string) {
    const id = Number(raw)
    if (!Number.isSafeInteger(id) || id <= 0) return null
    const t = await loadShareTicket(id, currentTenantKey())
    if (!t) return null
    const full = (await db('nivaro_tasks').where({ id }).first()) as never
    if (!full || !(await canSeeTicket(viewerOf(req), full))) return null
    return t
  }

  /** The running share, ending it first when it outlived its page, time or ticket. */
  async function liveShare(req: FastifyRequest, ticket: number): Promise<ShareState | null> {
    const tenant = currentTenantKey()
    const share = await readShare(redis(), tenant, ticket)
    if (!share) return null
    const live = shareLiveness(share, Date.now())
    if (live !== 'live') {
      await endShare(endDeps(req), tenant, ticket, live, null, share.id)
      return null
    }
    return share
  }

  app.get<{ Params: { id: string } }>('/tickets/:id/screen-share', async (req, reply) => {
    const t = await seenTicket(req, req.params.id)
    if (!t) return reply.code(404).send({ error: 'Not found' })
    const me = up(req.user!.id)
    const share = await liveShare(req, t.id)
    const refusal = startRefusal({
      enabled: screenShareEnabled(),
      actor: {
        id: me,
        kind: requestKind(req),
        viewAs: isViewAs(req),
        mcp: !!(req as { mcpInner?: boolean }).mcpInner
      },
      ticket: t
    })
    const isRequester = up(t.created_by) === me
    const target = isRequester || share ? await resolveTarget(t) : null
    let canWatch = false
    if (share && !isRequester) {
      const teams = (await db('nivaro_user_group_members')
        .where('user', me)
        .select('group_id')) as Array<{ group_id: number }>
      canWatch =
        watchRefusal({
          enabled: screenShareEnabled(),
          viewer: { id: me, kind: requestKind(req), active: true },
          ticket: t,
          share,
          viewerTeams: () => teams.map((r) => Number(r.group_id))
        }) === null
    }
    return reply.send({
      data: {
        enabled: screenShareEnabled(),
        active: !!share,
        mine: !!share && up(share.sharer) === me,
        share: share ? publicShare(share) : null,
        can_start: isRequester && !share && refusal === null,
        start_refusal: isRequester && refusal ? START_REFUSAL_TEXT[refusal] : null,
        start_code: isRequester ? refusal : null,
        can_watch: canWatch,
        to_name: share?.to.name ?? target?.name ?? null
      }
    })
  })

  app.post<{ Params: { id: string } }>('/tickets/:id/screen-share', async (req, reply) => {
    const t = await seenTicket(req, req.params.id)
    if (!t) return reply.code(404).send({ error: 'Not found' })
    const me = up(req.user!.id)
    const refusal = startRefusal({
      enabled: screenShareEnabled(),
      actor: {
        id: me,
        kind: requestKind(req),
        viewAs: isViewAs(req),
        mcp: !!(req as { mcpInner?: boolean }).mcpInner
      },
      ticket: t
    })
    if (refusal) {
      const status = refusal === 'NOT_FOUND' ? 404 : refusal === 'CLOSED' ? 409 : 403
      return reply
        .code(refusal === 'NO_SUPPORT_PERSON' ? 409 : status)
        .send({ error: START_REFUSAL_TEXT[refusal], code: `SCREEN_SHARE_${refusal}` })
    }
    const target = await resolveTarget(t)
    if (!target) return reply.code(409).send({ error: START_REFUSAL_TEXT.NO_SUPPORT_PERSON })
    const tenant = currentTenantKey()
    // One share per ticket: a share left by a reloaded page (or another tab) is replaced.
    const prior = await readShare(redis(), tenant, t.id)
    if (prior) await endShare(endDeps(req), tenant, t.id, 'replaced', me, prior.id)
    const now = Date.now()
    const share: ShareState = {
      id: randomBytes(16).toString('hex'),
      ticket: t.id,
      sharer: me,
      sharer_name: await personName(me),
      to: target,
      started_at: now,
      expires_at: now + SHARE_MAX_MS,
      beat_at: now,
      socket: null
    }
    await writeShare(redis(), tenant, share, now)
    await logTicketEvent(
      t.id,
      me,
      `Started sharing their screen with ${target.name}`,
      req,
      'screen-share-start'
    )
    announceShareState(getIo(), share)
    return reply
      .code(201)
      .send({ data: { share: publicShare(share), masking: await instanceMasking() } })
  })

  app.delete<{
    Params: { id: string }
    Querystring: { share?: string; reason?: string }
    Body: { share?: string }
  }>('/tickets/:id/screen-share', async (req, reply) => {
    const t = await seenTicket(req, req.params.id)
    if (!t) return reply.code(404).send({ error: 'Not found' })
    const me = up(req.user!.id)
    // Only the person sharing stops it (the support side cannot start or stop it for them).
    if (up(t.created_by) !== me) return reply.code(403).send({ error: 'Not your screen share' })
    const shareId =
      (typeof req.query?.share === 'string' && req.query.share) ||
      (typeof (req.body as { share?: unknown } | null)?.share === 'string'
        ? (req.body as { share: string }).share
        : null)
    const tenant = currentTenantKey()
    const share = await readShare(redis(), tenant, t.id)
    if (share && up(share.sharer) === me && (!shareId || share.id === shareId))
      await endShare(
        endDeps(req),
        tenant,
        t.id,
        // The page sends `reason=page` as it closes and `reason=expired` at its time limit;
        // the Stop button sends nothing.
        req.query?.reason === 'page'
          ? 'page'
          : req.query?.reason === 'expired' && Date.now() >= share.expires_at - 5_000
            ? 'expired'
            : 'stopped',
        me,
        share.id
      )
    return reply.code(204).send()
  })
}

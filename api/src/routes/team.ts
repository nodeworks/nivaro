import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  buildOnboarding,
  buildOneOnOne,
  buildTeamAccess,
  buildTeamCoverage,
  buildTeamOnboarding,
  buildTeamTasks,
  buildTeamTrend,
  buildTeamWeek,
  buildTeamWins,
  flagAccess,
  isManagerOf,
  remindToDelegate,
  reportsOf,
  summarizeOneOnOne,
  TeamError,
  type Viewer,
  vouchForRequest
} from '../services/team.js'

// A manager's view of their direct reports (#1030–#1043). Everything answers
// for the CALLER's reports; a route about one person (1:1 prep, onboarding)
// needs the caller to be that person's manager, or an admin.

const viewerOf = (req: FastifyRequest): Viewer => ({
  id: req.user!.id,
  isAdmin: !!req.isAdmin,
  role: (req.user as { role?: string | null } | undefined)?.role ?? null,
  ...(req.user as object)
})

const clampDays = (raw: unknown, def: number, min: number, max: number) => {
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : def
}

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof TeamError) {
    return reply
      .code(e.status)
      .send({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.extra ?? {}) })
  }
  throw e
}

async function mayManage(req: FastifyRequest, userId: string): Promise<boolean> {
  return !!req.isAdmin || (await isManagerOf(req.user!.id, userId))
}

/** Registered at /users. */
export async function teamUserRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { days?: string } }>(
    '/me/team-week',
    { preHandler: authenticate },
    async (req, reply) => reply.send({ data: await buildTeamWeek(req.user!.id, viewerOf(req)) })
  )

  app.get('/me/team-tasks', { preHandler: authenticate }, async (req, reply) =>
    reply.send({ data: await buildTeamTasks(req.user!.id, viewerOf(req)) })
  )

  app.get<{ Querystring: { days?: string } }>(
    '/me/team-trend',
    { preHandler: authenticate },
    async (req, reply) =>
      reply.send({ data: await buildTeamTrend(req.user!.id, clampDays(req.query.days, 30, 7, 90)) })
  )

  app.get<{ Querystring: { days?: string } }>(
    '/me/team-wins',
    { preHandler: authenticate },
    async (req, reply) => {
      const days = clampDays(req.query.days, 7, 1, 90)
      return reply.send({
        data: { days, people: await buildTeamWins(req.user!.id, viewerOf(req), days) }
      })
    }
  )

  // Kudos go out as the caller through the one chat send path: the room's
  // visibility and announce-only rules apply exactly as when typing it.
  app.post<{ Body: { room?: string; message?: string } }>(
    '/me/team-wins/kudos',
    { preHandler: authenticate },
    async (req, reply) => {
      const room = String(req.body?.room ?? '').trim()
      const message = String(req.body?.message ?? '').trim()
      if (!room || !message) return reply.code(400).send({ error: 'room and message are required' })
      const { postChatMessage, ChatSendError } = await import('../services/chat-send.js')
      try {
        const row = await postChatMessage(
          app,
          {
            user: req.user!,
            isAdmin: !!req.isAdmin,
            masqueradeAdminId: req.masqueradeAdminId ?? null
          },
          { room, message: message.slice(0, 4000) }
        )
        await logActivity({
          action: 'team-kudos',
          collection: 'chat_messages',
          item: String((row as { id?: unknown }).id ?? ''),
          user: req.user!.id,
          req
        })
        return reply.send({ data: { sent: true } })
      } catch (e) {
        if (e instanceof ChatSendError)
          return reply.code(e.statusCode).send({ error: e.message, code: e.code })
        throw e
      }
    }
  )

  app.get<{ Querystring: { days?: string } }>(
    '/me/team-onboarding',
    { preHandler: authenticate },
    async (req, reply) =>
      reply.send({
        data: {
          people: await buildTeamOnboarding(req.user!.id, clampDays(req.query.days, 60, 7, 365))
        }
      })
  )

  app.get('/me/team-access', { preHandler: authenticate }, async (req, reply) =>
    reply.send({ data: { people: await buildTeamAccess(req.user!.id) } })
  )

  app.post<{ Body: { user_id?: string; kind?: string; note?: string } }>(
    '/me/team-access/flag',
    { preHandler: authenticate },
    async (req, reply) => {
      const kind = req.body?.kind
      if (kind !== 'scope' && kind !== 'departure') {
        return reply.code(400).send({ error: 'kind must be scope or departure' })
      }
      const userId = String(req.body?.user_id ?? '')
      if (!userId) return reply.code(400).send({ error: 'user_id is required' })
      try {
        await flagAccess(app, viewerOf(req), userId, kind, String(req.body?.note ?? ''))
        return reply.send({ data: { flagged: true } })
      } catch (e) {
        return fail(reply, e)
      }
    }
  )

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/:id/one-on-one',
    { preHandler: authenticate },
    async (req, reply) => {
      const id = req.params.id
      if (!(await mayManage(req, id)))
        return reply.code(403).send({ error: 'Only their manager can see this' })
      const since = parseSince(req.query.since)
      const data = await buildOneOnOne(req.user!.id, viewerOf(req), id, since)
      if (!data) return reply.code(404).send({ error: 'Not found' })
      return reply.send({ data })
    }
  )

  app.post<{ Params: { id: string }; Body: { since?: string } }>(
    '/:id/one-on-one/summary',
    { preHandler: authenticate },
    async (req, reply) => {
      const id = req.params.id
      if (!(await mayManage(req, id)))
        return reply.code(403).send({ error: 'Only their manager can see this' })
      const data = await buildOneOnOne(req.user!.id, viewerOf(req), id, parseSince(req.body?.since))
      if (!data) return reply.code(404).send({ error: 'Not found' })
      const summary = await summarizeOneOnOne(data)
      if (summary == null) {
        return reply
          .code(503)
          .send({ error: 'AI is not set up on this portal', code: 'AI_NOT_CONFIGURED' })
      }
      await logActivity({
        action: 'ai-one-on-one',
        collection: 'nivaro_users',
        item: id,
        user: req.user!.id,
        req
      })
      return reply.send({ data: { summary } })
    }
  )

  app.get<{ Params: { id: string } }>(
    '/:id/onboarding',
    { preHandler: authenticate },
    async (req, reply) => {
      const id = req.params.id
      if (!(await mayManage(req, id)))
        return reply.code(403).send({ error: 'Only their manager can see this' })
      const row = (
        await reportsOf(
          String(
            (
              (await db('nivaro_users').where('id', id).first('manager_id')) as
                | { manager_id?: string }
                | undefined
            )?.manager_id ?? ''
          )
        )
      ).find((r) => r.id.toUpperCase() === id.toUpperCase())
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const [data] = await buildOnboarding([row])
      return reply.send({ data })
    }
  )
}

function parseSince(raw: unknown): Date {
  const fallback = new Date(Date.now() - 14 * 86_400_000)
  if (typeof raw !== 'string' || !raw) return fallback
  const d = new Date(raw)
  if (!Number.isFinite(d.getTime())) return fallback
  // Never more than a year back: the history reads grow with the window.
  return new Date(Math.max(d.getTime(), Date.now() - 365 * 86_400_000))
}

/** Registered with no prefix (full paths, beside /delegation/* and /access-requests/*). */
export async function teamMiscRoutes(app: FastifyInstance) {
  // #1032 — reports whose time off starts soon or who are out now.
  app.get<{ Querystring: { days?: string } }>(
    '/delegation/team',
    { preHandler: authenticate },
    async (req, reply) => {
      const days = clampDays(req.query.days, 14, 1, 60)
      return reply.send({
        data: { days, entries: await buildTeamCoverage(req.user!.id, viewerOf(req), days) }
      })
    }
  )

  app.post<{ Params: { userId: string } }>(
    '/delegation/:userId/remind',
    { preHandler: authenticate },
    async (req, reply) => {
      const { userId } = req.params
      if (!(await mayManage(req, userId))) {
        return reply.code(403).send({ error: 'Only their manager can ask this' })
      }
      try {
        await remindToDelegate(app, req.user!.id, userId)
        return reply.send({ data: { sent: true } })
      } catch (e) {
        return fail(reply, e)
      }
    }
  )

  // #1041 — a manager vouches for a report's pending access request.
  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/access-requests/:id/vouch',
    { preHandler: authenticate },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid id' })
      try {
        await vouchForRequest(app, viewerOf(req), id, req.body?.note ?? null)
        return reply.send({ data: { vouched: true } })
      } catch (e) {
        return fail(reply, e)
      }
    }
  )
}

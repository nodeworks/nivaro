import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { userHasSocket } from '../services/ai-stream-delivery.js'
import {
  cleanLine,
  cleanSentView,
  describeForRecipient,
  FALLBACK_MS,
  loadSentView,
  newSentView,
  SEND_VIEW_PER_HOUR,
  SEND_VIEW_PER_MINUTE,
  type SendViewRedis,
  type StoredSentView,
  saveSentView,
  sentViewLine
} from '../services/send-view.js'
import { emitToUserRoom } from '../services/user-sync.js'
import { overWindowLimit } from '../services/windowed-limit.js'
import type { User } from '../types.js'

/**
 * /api/send-view — "Send my view to Beth" (services/send-view.ts).
 *
 *   POST /           {to, view: {kind, collection?, item?, queue?, lv?, tab?, summary?}, note?}
 *                    → {data: {id, mode: 'live' | 'notification'}}
 *   GET  /:id        the recipient only (404 for anyone else): the view resolved AS THEM,
 *                    and marks it delivered so no notification follows.
 *
 * Only a person on their own sign-in sends (session or phone app): never an API key, a
 * token, a connected app or View-as — a view sent "from Beth" must be Beth.
 */

const SENDER_METHODS = new Set(['session', 'device'])

function displayName(u: Pick<User, 'first_name' | 'last_name' | 'email'>): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || 'Someone'
}

export function senderRefusal(req: Pick<FastifyRequest, 'authMethod'>): string | null {
  return SENDER_METHODS.has(String(req.authMethod ?? '')) ? null : 'SEND_VIEW_PEOPLE_ONLY'
}

export async function sendViewRoutes(app: FastifyInstance) {
  const redis = (app as unknown as { redis?: SendViewRedis }).redis ?? null

  /** Notify the recipient the ordinary way unless a tab of theirs already opened the card. */
  const fallBackToNotification = async (id: string, force = false) => {
    const row = await loadSentView(redis, id)
    if (!row || (row.delivered && !force)) return
    const recipient = (await db('nivaro_users').where({ id: row.to }).first()) as User | undefined
    if (!recipient) return
    const d = await describeForRecipient(row, recipient)
    const { notifyUser } = await import('../services/notification-channels.js')
    await notifyUser(app, row.to, {
      subject: sentViewLine(d),
      message: row.note ? `“${row.note}”` : 'Open it to see the same screen, with your own access.',
      category: 'views',
      sender: row.from.id,
      target: d.target,
      why: `${row.from.name} used Send my view`,
      source: { kind: 'send-view', label: row.from.name }
    })
  }

  app.post<{ Body: { to?: unknown; view?: unknown; note?: unknown } }>(
    '/',
    { preHandler: requireAuth },
    async (req, reply) => {
      const me = req.user!
      const refusal = senderRefusal(req)
      if (refusal)
        return reply
          .code(403)
          .send({ error: 'Only a signed-in person can send their view', code: refusal })
      const to = typeof req.body?.to === 'string' ? req.body.to.trim() : ''
      if (!/^[0-9A-Za-z-]{1,64}$/.test(to))
        return reply.code(400).send({ error: 'Choose who to send it to', code: 'BAD_RECIPIENT' })
      if (to.toUpperCase() === String(me.id).toUpperCase())
        return reply
          .code(400)
          .send({ error: 'Choose someone other than yourself', code: 'BAD_RECIPIENT' })
      const view = cleanSentView(req.body?.view)
      if (typeof view === 'string') return reply.code(400).send({ error: view, code: 'BAD_VIEW' })
      const note = cleanLine(req.body?.note, 280)

      const recipient = (await db('nivaro_users')
        .where({ id: to })
        .first(
          'id',
          'status',
          'is_redacted',
          'account_kind',
          'first_name',
          'last_name',
          'email'
        )) as
        | (Pick<User, 'id' | 'status' | 'account_kind' | 'first_name' | 'last_name' | 'email'> & {
            is_redacted?: boolean | number | null
          })
        | undefined
      const { isMachineAccount } = await import('../services/machine-accounts.js')
      if (
        !recipient ||
        recipient.status === 'suspended' ||
        recipient.is_redacted ||
        isMachineAccount(recipient as never)
      )
        return reply
          .code(404)
          .send({ error: 'That person cannot receive views', code: 'BAD_RECIPIENT' })

      const key = `send-view:${String(me.id).toUpperCase()}`
      if (
        (await overWindowLimit(redis as never, `${key}:m`, SEND_VIEW_PER_MINUTE, 60)) ||
        (await overWindowLimit(redis as never, `${key}:h`, SEND_VIEW_PER_HOUR, 3600))
      )
        return reply.code(429).send({
          error: 'You have sent a lot of views just now — try again in a minute',
          code: 'RATE_LIMITED'
        })

      const row = newSentView(
        { id: String(me.id), name: displayName(me) },
        String(recipient.id),
        view,
        note
      )
      await saveSentView(redis, row)
      const live = await userHasSocket(app.io, String(recipient.id)).catch(() => false)
      if (live) {
        // A poke on their own room — no content; their tab reads it as them.
        emitToUserRoom(String(recipient.id), 'view:sent', { id: row.id })
        const t = setTimeout(() => {
          fallBackToNotification(row.id).catch((err) =>
            app.log.warn({ err }, 'send-view notification fallback failed')
          )
        }, FALLBACK_MS)
        t.unref?.()
      } else {
        await fallBackToNotification(row.id)
      }
      return { data: { id: row.id, mode: live ? 'live' : 'notification' } }
    }
  )

  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const me = req.user!
    const row = await loadSentView(redis, req.params.id)
    // Only the person it was sent to; anyone else gets the same answer as a missing id.
    if (!row || row.to.toUpperCase() !== String(me.id).toUpperCase())
      return reply.code(404).send({ error: 'Not found' })
    // An administrator viewing as the recipient reads it without taking it from them.
    if (!row.delivered && req.authMethod !== 'masquerade') {
      const next: StoredSentView = { ...row, delivered: true }
      await saveSentView(redis, next)
    }
    return { data: await describeForRecipient(row, me) }
  })

  /** "Later" on the card: keep it as an ordinary notification (once). */
  app.post<{ Params: { id: string } }>(
    '/:id/later',
    { preHandler: requireAuth },
    async (req, reply) => {
      const row = await loadSentView(redis, req.params.id)
      if (!row || row.to.toUpperCase() !== String(req.user!.id).toUpperCase())
        return reply.code(404).send({ error: 'Not found' })
      if (req.authMethod === 'masquerade') return { data: { kept: false } }
      if (row.kept) return { data: { kept: true } }
      await saveSentView(redis, { ...row, delivered: true, kept: true })
      await fallBackToNotification(row.id, true)
      return { data: { kept: true } }
    }
  )
}

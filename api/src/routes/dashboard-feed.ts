import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import {
  CHANGED_SINCE_CAP,
  changedSince,
  listOwnerAbsence,
  listSendBacks
} from '../services/dashboard-feed.js'

/**
 * /api/dashboard/* — per-viewer reads behind the dashboard canvas. Every
 * handler answers for the signed-in person only; the service re-checks read
 * permission on every record before it leaves.
 */
export async function dashboardFeedRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { dir?: string; days?: string } }>(
    '/send-backs',
    { preHandler: requireAuth },
    async (req, reply) => {
      const dir = req.query.dir ?? 'to_me'
      if (dir !== 'to_me' && dir !== 'by_me') {
        return reply.code(400).send({ error: 'dir must be to_me or by_me' })
      }
      const raw = Number(req.query.days ?? 14)
      const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.floor(raw))) : 14
      const data = await listSendBacks({
        user: req.user!,
        isAdmin: !!req.isAdmin,
        dir,
        days
      }).catch((err) => {
        req.log.warn({ err }, 'dashboard send-backs failed')
        return []
      })
      return reply.send({ data })
    }
  )

  app.get('/owner-absence', { preHandler: requireAuth }, async (req, reply) => {
    const data = await listOwnerAbsence({ user: req.user!, isAdmin: !!req.isAdmin }).catch(
      (err) => {
        req.log.warn({ err }, 'dashboard owner-absence failed')
        return []
      }
    )
    return reply.send({ data })
  })

  app.post<{ Body: { items?: unknown } }>(
    '/changed-since',
    { preHandler: requireAuth },
    async (req, reply) => {
      const items = req.body?.items
      if (!Array.isArray(items)) {
        return reply.code(400).send({ error: 'items must be an array of {collection, item}' })
      }
      if (items.length > CHANGED_SINCE_CAP) {
        return reply.code(400).send({ error: `At most ${CHANGED_SINCE_CAP} items per request` })
      }
      const parsed: Array<{ collection: string; item: string }> = []
      for (const i of items) {
        const row = i as { collection?: unknown; item?: unknown } | null
        if (!row || typeof row.collection !== 'string' || row.item == null || row.item === '') {
          return reply.code(400).send({ error: 'Each item needs a collection and an item id' })
        }
        parsed.push({ collection: row.collection, item: String(row.item) })
      }
      const data = await changedSince({
        user: req.user!,
        isAdmin: !!req.isAdmin,
        items: parsed
      }).catch((err) => {
        req.log.warn({ err }, 'dashboard changed-since failed')
        return {}
      })
      return reply.send({ data })
    }
  )
}

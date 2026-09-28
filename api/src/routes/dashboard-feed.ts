import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import {
  CHANGED_SINCE_CAP,
  changedSince,
  integrationsSummary,
  listMyIntegrity,
  listOwnerAbsence,
  listSendBacks,
  myThroughput,
  onboardingState,
  READINESS_ID_CAP,
  submissionReadiness,
  zonePulse
} from '../services/dashboard-feed.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const SYSTEM = /^(nivaro_|directus_)/i

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

  app.get('/my-integrity', { preHandler: requireAuth }, async (req, reply) => {
    const data = await listMyIntegrity({ user: req.user!, isAdmin: !!req.isAdmin }).catch((err) => {
      req.log.warn({ err }, 'dashboard my-integrity failed')
      return { records: [], totals: { records: 0, findings: 0, lines: 0 } }
    })
    return reply.send({ data })
  })

  app.get<{ Querystring: { collection?: string; ids?: string } }>(
    '/submission-readiness',
    { preHandler: requireAuth },
    async (req, reply) => {
      const collection = req.query.collection ?? ''
      if (!collection || !IDENT.test(collection) || SYSTEM.test(collection)) {
        return reply.code(400).send({ error: 'collection is required' })
      }
      const ids = [
        ...new Set(
          String(req.query.ids ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
      ]
      if (ids.length > READINESS_ID_CAP) {
        return reply.code(400).send({ error: `At most ${READINESS_ID_CAP} ids per request` })
      }
      const data = await submissionReadiness({
        user: req.user!,
        isAdmin: !!req.isAdmin,
        collection,
        ids
      }).catch((err) => {
        req.log.warn({ err }, 'dashboard submission-readiness failed')
        return {}
      })
      return reply.send({ data })
    }
  )

  app.get<{ Querystring: { weeks?: string } }>(
    '/my-throughput',
    { preHandler: requireAuth },
    async (req, reply) => {
      const raw = Number(req.query.weeks ?? 4)
      const weeks = Number.isFinite(raw) ? Math.min(12, Math.max(1, Math.floor(raw))) : 4
      const data = await myThroughput({ user: req.user!, weeks }).catch((err) => {
        req.log.warn({ err }, 'dashboard my-throughput failed')
        return {
          this_week: { transitions: 0, send_backs: 0, completions: 0 },
          median: { transitions: 0, send_backs: 0, completions: 0 },
          time_to_action_hours: { this_week: null, median: null },
          send_back_ratio: null
        }
      })
      return reply.send({ data })
    }
  )

  app.get('/onboarding', { preHandler: requireAuth }, async (req, reply) => {
    const data = await onboardingState({ user: req.user! }).catch((err) => {
      req.log.warn({ err }, 'dashboard onboarding failed')
      return null
    })
    return reply.send({ data })
  })

  app.get('/integrations', { preHandler: requireAuth }, async (req, reply) => {
    const data = await integrationsSummary().catch((err) => {
      req.log.warn({ err }, 'dashboard integrations failed')
      return []
    })
    return reply.send({ data })
  })

  app.get<{ Querystring: { dimension?: string } }>(
    '/zone-pulse',
    { preHandler: requireAuth },
    async (req, reply) => {
      const dimension = req.query.dimension?.trim() || undefined
      const data = await zonePulse({ user: req.user!, isAdmin: !!req.isAdmin, dimension }).catch(
        (err) => {
          req.log.warn({ err }, 'dashboard zone-pulse failed')
          return undefined
        }
      )
      if (data === null) return reply.code(400).send({ error: 'Unknown scope dimension' })
      return reply.send({ data: data ?? null })
    }
  )
}

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
import { headlineZoneAllowance, readHeadlineHistory } from '../services/headline-snapshots.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A failed read is never an empty or zero answer: the client shows its
 *  error state instead of telling the viewer "nothing here". */
const UNAVAILABLE = { error: 'Could not load this right now', code: 'DASHBOARD_FEED_UNAVAILABLE' }
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
      try {
        const data = await listSendBacks({ user: req.user!, isAdmin: !!req.isAdmin, dir, days })
        return reply.send({ data })
      } catch (err) {
        req.log.warn({ err }, 'dashboard send-backs failed')
        return reply.code(503).send(UNAVAILABLE)
      }
    }
  )

  app.get('/owner-absence', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const data = await listOwnerAbsence({ user: req.user!, isAdmin: !!req.isAdmin })
      return reply.send({ data })
    } catch (err) {
      req.log.warn({ err }, 'dashboard owner-absence failed')
      return reply.code(503).send(UNAVAILABLE)
    }
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
      try {
        const data = await changedSince({ user: req.user!, isAdmin: !!req.isAdmin, items: parsed })
        return reply.send({ data })
      } catch (err) {
        req.log.warn({ err }, 'dashboard changed-since failed')
        return reply.code(503).send(UNAVAILABLE)
      }
    }
  )

  app.get('/my-integrity', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const data = await listMyIntegrity({ user: req.user!, isAdmin: !!req.isAdmin })
      return reply.send({ data })
    } catch (err) {
      req.log.warn({ err }, 'dashboard my-integrity failed')
      return reply.code(503).send(UNAVAILABLE)
    }
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
      try {
        const data = await myThroughput({ user: req.user!, weeks })
        return reply.send({ data })
      } catch (err) {
        req.log.warn({ err }, 'dashboard my-throughput failed')
        return reply.code(503).send(UNAVAILABLE)
      }
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
    try {
      const data = await integrationsSummary()
      return reply.send({ data })
    } catch (err) {
      req.log.warn({ err }, 'dashboard integrations failed')
      return reply.code(503).send(UNAVAILABLE)
    }
  })

  // Headline snapshots (#851): the recorded daily figures for one year and
  // one zone (absent = every zone), oldest first — deltas + sparklines.
  app.get<{ Querystring: { year?: string; zone?: string; days?: string } }>(
    '/headline-history',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rawYear = Number(req.query.year ?? new Date().getFullYear())
      if (!Number.isInteger(rawYear) || rawYear < 1900 || rawYear > 3000) {
        return reply.code(400).send({ error: 'year must be a four-digit year' })
      }
      const zone = req.query.zone?.trim() || null
      if (zone && zone.length > 80) return reply.code(400).send({ error: 'zone is too long' })
      const rawDays = Number(req.query.days ?? 30)
      const days = Number.isFinite(rawDays) ? Math.min(366, Math.max(1, Math.floor(rawDays))) : 30
      try {
        // The figures were written by a cron with no user — the viewer's
        // zone restriction is applied here: a zone outside it, or the
        // all-zones row for a restricted person, reads as no history.
        const allowed = await headlineZoneAllowance(req.user!, !!req.isAdmin)
        if (allowed && (zone == null || !allowed.has(zone))) return reply.send({ data: [] })
        const data = await readHeadlineHistory({ year: rawYear, zone, days })
        return reply.send({ data })
      } catch (err) {
        req.log.warn({ err }, 'dashboard headline-history failed')
        return reply.code(503).send(UNAVAILABLE)
      }
    }
  )

  app.get<{ Querystring: { dimension?: string } }>(
    '/zone-pulse',
    { preHandler: requireAuth },
    async (req, reply) => {
      const dimension = req.query.dimension?.trim() || undefined
      try {
        const data = await zonePulse({ user: req.user!, isAdmin: !!req.isAdmin, dimension })
        if (data === null) return reply.code(400).send({ error: 'Unknown scope dimension' })
        return reply.send({ data })
      } catch (err) {
        req.log.warn({ err }, 'dashboard zone-pulse failed')
        return reply.code(503).send(UNAVAILABLE)
      }
    }
  )
}

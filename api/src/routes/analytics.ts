import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'

function periodStart(period: string): Date {
  const ms = period === '1d' ? 86_400_000 : period === '30d' ? 30 * 86_400_000 : 7 * 86_400_000
  return new Date(Date.now() - ms)
}

export async function analyticsRoutes(app: FastifyInstance) {
  // ── POST /pageview ─────────────────────────────────────────────────────────
  // Public — called from external sites via the embedded tracker script.
  app.post<{
    Body: {
      sessionId: string
      userId?: string | null
      userEmail?: string | null
      userName?: string | null
      pageUrl: string
      pageTitle?: string | null
      referrer?: string | null
      deviceType?: string | null
      previousViewId?: number | null
      previousDuration?: number | null
    }
  }>(
    '/pageview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['sessionId', 'pageUrl'],
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string', maxLength: 64 },
            userId: { type: ['string', 'null'], maxLength: 128 },
            userEmail: { type: ['string', 'null'], maxLength: 254 },
            userName: { type: ['string', 'null'], maxLength: 128 },
            pageUrl: { type: 'string', maxLength: 2048 },
            pageTitle: { type: ['string', 'null'], maxLength: 256 },
            referrer: { type: ['string', 'null'], maxLength: 2048 },
            deviceType: { type: ['string', 'null'], maxLength: 16 },
            previousViewId: { type: ['number', 'null'] },
            previousDuration: { type: ['number', 'null'] }
          }
        }
      }
    },
    async (req, reply) => {
      const b = req.body

      if (b.previousViewId && b.previousDuration != null) {
        await db('nivaro_page_views')
          .where({ id: b.previousViewId })
          .whereNull('duration_seconds')
          .update({
            duration_seconds: Math.min(Math.max(0, Math.round(b.previousDuration)), 86400)
          })
      }

      // user_id / user_email / user_name are client-asserted — same pattern as
      // presence ping. They cannot be verified for public tracker requests.
      // Surface as "self-reported" in the admin UI rather than treating as authoritative.
      const [id] = await db('nivaro_page_views').insert({
        session_id: b.sessionId.slice(0, 64),
        user_id: b.userId ?? null,
        user_email: b.userEmail ?? null,
        user_name: b.userName ?? null,
        page_url: b.pageUrl,
        page_title: b.pageTitle ?? null,
        referrer: b.referrer ?? null,
        device_type: b.deviceType ?? null,
        ip: req.ip ?? null,
        user_agent: ((req.headers['user-agent'] as string) ?? '').slice(0, 500) || null,
        viewed_at: new Date()
      })

      return reply.code(201).send({ id })
    }
  )

  // ── PATCH /pageview/:id ────────────────────────────────────────────────────
  // Public — tracker calls this to record how long the user was on the page.
  // sessionId is required and matched against the stored row to prevent IDOR
  // (a random caller knowing an ID cannot mutate another session's duration).
  app.patch<{ Params: { id: string }; Body: { duration: number; sessionId: string } }>(
    '/pageview/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['duration', 'sessionId'],
          properties: {
            duration: { type: 'number', minimum: 0, maximum: 86400 },
            sessionId: { type: 'string', maxLength: 64 }
          }
        }
      }
    },
    async (req, reply) => {
      await db('nivaro_page_views')
        .where({ id: Number(req.params.id), session_id: req.body.sessionId })
        .whereNull('duration_seconds')
        .update({ duration_seconds: Math.round(req.body.duration) })
      return reply.code(204).send()
    }
  )

  // ── GET /pageviews/stats ────────────────────────────────────────────────────
  app.get<{ Querystring: { period?: string } }>(
    '/pageviews/stats',
    { preHandler: requireAuth },
    async (req, reply) => {
      const since = periodStart(req.query.period ?? '7d')

      const [totals] = await db('nivaro_page_views')
        .where('viewed_at', '>=', since)
        .count({ total_views: '*' })
        .countDistinct({ unique_sessions: 'session_id', unique_pages: 'page_url' })

      const topPages = await (db('nivaro_page_views')
        .where('viewed_at', '>=', since)
        .groupBy('page_url')
        .select('page_url')
        .count({ views: '*' })
        .countDistinct({ unique_sessions: 'session_id' })
        .orderBy('views', 'desc')
        .limit(10) as unknown as Promise<
        Array<{ page_url: string; views: string | number; unique_sessions: string | number }>
      >)

      return {
        total_views: Number(totals.total_views),
        unique_sessions: Number(totals.unique_sessions),
        unique_pages: Number(totals.unique_pages),
        top_pages: topPages.map((p) => ({
          page_url: p.page_url as string,
          views: Number(p.views),
          unique_sessions: Number(p.unique_sessions)
        }))
      }
    }
  )

  // ── GET /pageviews ──────────────────────────────────────────────────────────
  app.get<{
    Querystring: {
      period?: string
      page?: string
      limit?: string
      search?: string
      session_id?: string
    }
  }>('/pageviews', { preHandler: requireAuth }, async (req, reply) => {
    const since = periodStart(req.query.period ?? '7d')
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10)))
    const offset = (page - 1) * limit

    let q = db('nivaro_page_views').where('viewed_at', '>=', since)

    if (req.query.search) {
      const s = `%${req.query.search}%`
      q = q.where((b) =>
        b
          .whereRaw('page_url LIKE ?', [s])
          .orWhereRaw('user_email LIKE ?', [s])
          .orWhereRaw('user_name LIKE ?', [s])
      )
    }
    if (req.query.session_id) {
      q = q.where('session_id', req.query.session_id)
    }

    const [{ total }] = await q.clone().count({ total: '*' })
    const rows = await q
      .orderBy('viewed_at', 'desc')
      .offset(offset)
      .limit(limit)
      .select(
        'id',
        'session_id',
        'user_email',
        'user_name',
        'page_url',
        'page_title',
        'device_type',
        'ip',
        'viewed_at',
        'duration_seconds'
      )

    return { data: rows, total: Number(total), page, limit }
  })
}

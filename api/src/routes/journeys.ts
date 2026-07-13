import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

/**
 * Journey trail — per-session admin route breadcrumbs, persisted by the
 * page:at socket handler. Admin-only: this is user tracking; keep it out of
 * regular hands.
 */

interface JourneyRow {
  id: number
  user: string
  session_id: string
  path: string
  entered_at: Date
  duration_seconds: number | null
}

export async function journeyRoutes(app: FastifyInstance) {
  // GET /journeys/user/:id?date=YYYY-MM-DD  (defaults to today)
  app.get<{ Params: { id: string }; Querystring: { date?: string } }>(
    '/user/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const dateStr = req.query.date ?? new Date().toISOString().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return reply.code(400).send({ error: 'date must be YYYY-MM-DD' })
      }
      const dayStart = new Date(`${dateStr}T00:00:00`)
      const dayEnd = new Date(dayStart.getTime() + 86_400_000)

      const rows = (await db('nivaro_admin_journeys')
        .where({ user: req.params.id })
        .where('entered_at', '>=', dayStart)
        .where('entered_at', '<', dayEnd)
        .orderBy('entered_at', 'asc')
        .limit(2000)) as JourneyRow[]

      // Group into sessions, ordered by first entry
      const sessions = new Map<string, JourneyRow[]>()
      for (const r of rows) {
        const list = sessions.get(r.session_id) ?? []
        list.push(r)
        sessions.set(r.session_id, list)
      }

      return reply.send({
        data: {
          date: dateStr,
          sessions: [...sessions.values()].map((steps) => ({
            session_id: steps[0].session_id,
            started_at: steps[0].entered_at,
            steps: steps.map((s) => ({
              path: s.path,
              entered_at: s.entered_at,
              duration_seconds: s.duration_seconds
            }))
          }))
        }
      })
    }
  )

  // GET /journeys/days/:id — which days have data (for the day picker), last 30
  app.get<{ Params: { id: string } }>(
    '/days/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const cutoff = new Date(Date.now() - 30 * 86_400_000)
      const rows = (await db('nivaro_admin_journeys')
        .where({ user: req.params.id })
        .where('entered_at', '>', cutoff)
        .select(db.raw('CAST(entered_at AS DATE) as day'))
        .count({ n: '*' })
        .groupByRaw('CAST(entered_at AS DATE)')
        .orderBy('day', 'desc')) as Array<{ day: string | Date; n: number | string }>
      return reply.send({
        data: rows.map((r) => ({
          date:
            r.day instanceof Date
              ? `${r.day.getFullYear()}-${String(r.day.getMonth() + 1).padStart(2, '0')}-${String(r.day.getDate()).padStart(2, '0')}`
              : String(r.day).slice(0, 10),
          steps: Number(r.n)
        }))
      })
    }
  )
}

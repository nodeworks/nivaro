import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { cleanAppLabel } from '../services/page-at.js'

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
  app?: string | null
}

/**
 * #1391 — journeys cover the admin AND the portal (each page:at ping carries
 * its app). `?app=` narrows to one: 'admin' also matches rows written before
 * the column existed (NULL), which were always the admin. An unusable label
 * filters nothing rather than everything.
 */
export function journeyAppFilter(raw: unknown): { app: string; includeNull: boolean } | null {
  const app = cleanAppLabel(raw)
  if (!app) return null
  return { app, includeNull: app === 'admin' }
}

async function applyAppFilter(q: Knex.QueryBuilder, raw: unknown): Promise<void> {
  const f = journeyAppFilter(raw)
  if (!f || !(await hasColumn('nivaro_admin_journeys', 'app'))) return
  q.where((qb) => {
    qb.where('app', f.app)
    if (f.includeNull) qb.orWhereNull('app')
  })
}

export async function journeyRoutes(app: FastifyInstance) {
  // #42 — live "who else is here": the page-presence pings admin pages send
  // (page:at), filtered to one path. The caller is excluded client-side.
  app.get<{ Querystring: { path?: string } }>(
    '/here',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const path = String(req.query.path ?? '').slice(0, 200)
      if (!/^\/(?!\/)[A-Za-z0-9/_\-?=&.%~]*$/.test(path))
        return reply.code(400).send({ error: 'Bad path' })
      const { usersOnPath } = await import('../plugins/socketio.js')
      return { data: usersOnPath(path) }
    }
  )
  // GET /journeys/user/:id?date=YYYY-MM-DD&app=  (defaults to today, every app)
  app.get<{ Params: { id: string }; Querystring: { date?: string; app?: string } }>(
    '/user/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const dateStr = req.query.date ?? new Date().toISOString().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return reply.code(400).send({ error: 'date must be YYYY-MM-DD' })
      }
      const dayStart = new Date(`${dateStr}T00:00:00`)
      const dayEnd = new Date(dayStart.getTime() + 86_400_000)

      const q = db('nivaro_admin_journeys')
        .where({ user: req.params.id })
        .where('entered_at', '>=', dayStart)
        .where('entered_at', '<', dayEnd)
        .orderBy('entered_at', 'asc')
        .limit(2000)
      await applyAppFilter(q, req.query.app)
      const rows = (await q) as JourneyRow[]

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
            // One socket is one tab of one front end, so a session has one app.
            app: steps[0].app ?? 'admin',
            steps: steps.map((s) => ({
              path: s.path,
              entered_at: s.entered_at,
              duration_seconds: s.duration_seconds,
              app: s.app ?? 'admin'
            }))
          }))
        }
      })
    }
  )

  // GET /journeys/days/:id?app= — which days have data (for the day picker),
  // last 30; `apps` lists the front ends seen in that window (the app filter).
  app.get<{ Params: { id: string }; Querystring: { app?: string } }>(
    '/days/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const cutoff = new Date(Date.now() - 30 * 86_400_000)
      const q = db('nivaro_admin_journeys')
        .where({ user: req.params.id })
        .where('entered_at', '>', cutoff)
        .select(db.raw('CAST(entered_at AS DATE) as day'))
        .count({ n: '*' })
        .groupByRaw('CAST(entered_at AS DATE)')
        .orderBy('day', 'desc')
      await applyAppFilter(q, req.query.app)
      const rows = (await q) as Array<{ day: string | Date; n: number | string }>
      let apps: string[] = []
      if (await hasColumn('nivaro_admin_journeys', 'app')) {
        const appRows = (await db('nivaro_admin_journeys')
          .where({ user: req.params.id })
          .where('entered_at', '>', cutoff)
          .distinct('app')) as Array<{ app: string | null }>
        apps = [...new Set(appRows.map((r) => r.app ?? 'admin'))].sort()
      }
      return reply.send({
        apps,
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

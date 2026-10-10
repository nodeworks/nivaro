import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import {
  readFrame,
  readFrameEvents,
  readHeat,
  readHeatRoutes,
  utcDay,
  viewportClass
} from '../services/session-replay-heat.js'

/**
 * Session replay insights — what recordings add up to, rather than one
 * recording at a time. Admin-only, like every read of replay data.
 *
 *  GET /heat/routes  routes with heat in a date range (the picker)
 *  GET /heat         one route's click cells, top elements, scroll depth
 *  GET /heat/frame   the events that render that route's stored frame
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 366

/** ?from=&to= as UTC days; defaults to the last 30 days, refuses nonsense. */
export function dayRange(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  now = Date.now()
): { from: string; to: string } | { error: string } {
  const to = toRaw ?? utcDay(now)
  const from = fromRaw ?? utcDay(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000)
  for (const d of [from, to]) {
    if (!DAY.test(d) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) {
      return { error: 'from and to must be YYYY-MM-DD' }
    }
  }
  if (from > to) return { error: 'from must not be after to' }
  if (
    Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) >
    MAX_RANGE_DAYS * 86_400_000
  ) {
    return { error: `a range spans at most ${MAX_RANGE_DAYS} days` }
  }
  return { from, to }
}

const VIEWPORTS = new Set(['xs', 'sm', 'md', 'lg', 'xl'])

function routeParams(q: { app?: string; route?: string }): { app: string; route: string } | null {
  const app = String(q.app ?? 'admin').slice(0, 100)
  const route = String(q.route ?? '')
  if (!route.startsWith('/') || route.length > 140) return null
  return { app, route }
}

export async function sessionReplayInsightRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/heat/routes',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const r = dayRange(req.query.from, req.query.to)
      if ('error' in r) return reply.code(400).send({ error: r.error })
      return reply.send({ data: await readHeatRoutes(r.from, r.to), ...r })
    }
  )

  app.get<{
    Querystring: { app?: string; route?: string; from?: string; to?: string; viewport?: string }
  }>('/heat', { preHandler: requireAdmin }, async (req, reply) => {
    const p = routeParams(req.query)
    if (!p) return reply.code(400).send({ error: 'route must be a route pattern' })
    const r = dayRange(req.query.from, req.query.to)
    if ('error' in r) return reply.code(400).send({ error: r.error })
    const viewport =
      req.query.viewport && VIEWPORTS.has(req.query.viewport) ? req.query.viewport : null
    return reply.send({ data: await readHeat({ ...p, ...r, viewport }) })
  })

  /**
   * The newest stored frame of a route: a full snapshot and what changed
   * after it, up to the moment the fold picked. The Heat tab hands these to a
   * paused rrweb Replayer — a live render of the route, cheap, and the same
   * for admin and portal routes.
   */
  app.get<{ Querystring: { app?: string; route?: string } }>(
    '/heat/frame',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const p = routeParams(req.query)
      if (!p) return reply.code(400).send({ error: 'route must be a route pattern' })
      const frame = await readFrame(p.app, p.route)
      if (!frame) return reply.code(404).send({ error: 'No stored frame for this route' })
      const events = await readFrameEvents(frame.recording_id, frame.at_ms)
      if (!events) return reply.code(404).send({ error: 'The frame’s recording has no events' })
      return reply.send({
        data: {
          ...frame,
          viewport: frame.width ? viewportClass(frame.width) : null,
          events
        }
      })
    }
  )
}

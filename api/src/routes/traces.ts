import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import {
  clearTraces,
  getTrace,
  listTraces,
  traceConfig,
  unaccountedMs
} from '../services/request-trace.js'

/**
 * Slow-request traces. Admin-only: a trace carries the full request URL, which
 * routinely contains filter values, and the id of the user who made it.
 *
 * The buffer is per-process, so on a multi-replica deployment these are the
 * traces of whichever instance answered — same limitation as presence and
 * journeys, and preferable to persisting a table nobody prunes.
 */
export async function traceRoutes(app: FastifyInstance) {
  app.get('/traces', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { limit?: string; route?: string }
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200)
    let traces = listTraces(limit)
    if (q.route) traces = traces.filter((t) => t.route.includes(q.route as string))

    return reply.send({
      data: {
        config: traceConfig(),
        traces: traces.map((t) => ({
          ...t,
          unaccounted_ms: unaccountedMs(t),
          // The single most expensive top-level phase, so a list row can say
          // what happened without expanding into the full waterfall.
          slowest_phase:
            t.spans.length > 0 ? t.spans.reduce((a, b) => (b.ms > a.ms ? b : a)).phase : null
        }))
      }
    })
  })

  app.get('/traces/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const trace = getTrace(id)
    if (!trace) return reply.code(404).send({ error: 'Trace not found' })
    return reply.send({ data: { ...trace, unaccounted_ms: unaccountedMs(trace) } })
  })

  app.delete('/traces', { preHandler: requireAdmin }, async (_req, reply) => {
    clearTraces()
    return reply.send({ data: { cleared: true } })
  })
}

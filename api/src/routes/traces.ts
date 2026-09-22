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

  // #509 — the estimated plan for one of a trace's statements, replayed
  // through sp_executesql with the SAME bindings, so it is the plan the route
  // got, not the plan a literal rewrite would get.
  app.post('/traces/:id/explain', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { index } = (req.body ?? {}) as { index?: number }
    const trace = getTrace(id)
    if (!trace) return reply.code(404).send({ error: 'Trace not found' })
    const stmt = trace.top_sql[Number(index) || 0]
    if (!stmt) return reply.code(404).send({ error: 'No such statement on this trace' })
    if (!/^\s*select\b/i.test(stmt.sql)) {
      return reply.code(400).send({ error: 'Only SELECT statements are explained' })
    }
    if (stmt.sql.endsWith('…')) {
      return reply
        .code(400)
        .send({ error: 'Statement was truncated when captured — too long to replay' })
    }
    const { planForStatement } = await import('../services/custom-query-exec.js')
    try {
      const result = await planForStatement(stmt.sql, stmt.bindings)
      return reply.send({ data: { ...result, sql: stmt.sql, bindings: stmt.bindings } })
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/traces', { preHandler: requireAdmin }, async (_req, reply) => {
    clearTraces()
    return reply.send({ data: { cleared: true } })
  })
}

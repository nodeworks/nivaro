import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import type { HealthStore } from '../services/infra-swarm/health.js'
import { clientGoneSignal } from '../services/read-gate.js'
import { type AskTurn, askTelemetry, TelemetryAskError } from '../services/telemetry-ai.js'
import { telemetryStatus } from '../services/telemetry-status.js'
import { storeEnabled } from '../services/telemetry-store.js'
import { listStoredTraces } from '../services/telemetry-traces.js'

/**
 * The external telemetry stack, seen from Nivaro (#2544): settings, what this process sends,
 * what arrived, the stack's own health, recent slow traces, and asking AI about it.
 * Administrators only.
 */
export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/status', async () => ({ data: await telemetryStatus() }))

  // The slowest (or failed) traced requests of the last `minutes` (default 60, up to a week).
  app.get<{ Querystring: { minutes?: string; errors_only?: string; limit?: string } }>(
    '/traces',
    async (req, reply) => {
      if (!storeEnabled())
        return reply
          .code(409)
          .send({ error: 'The telemetry store is not configured', code: 'STORE_OFF' })
      const minutes = Math.min(7 * 1440, Math.max(5, Number(req.query.minutes) || 60))
      const now = Date.now()
      try {
        const rows = await listStoredTraces({
          from: now - minutes * 60_000,
          to: now,
          errorsOnly: req.query.errors_only === 'true',
          limit: Math.min(25, Math.max(1, Number(req.query.limit) || 10))
        })
        return { data: { minutes, traces: rows } }
      } catch (err) {
        req.log.warn({ err }, 'telemetry traces read failed')
        return reply
          .code(503)
          .send({ error: 'The traces store did not answer', code: 'STORE_UNAVAILABLE' })
      }
    }
  )

  // Ask AI about the telemetry: a few questions a minute per person (each runs several tools).
  const recent = new Map<string, number[]>()
  app.post<{ Body: { question?: string; history?: AskTurn[] } }>('/ask', async (req, reply) => {
    const who = String(req.user?.id ?? '')
    const now = Date.now()
    const mine = (recent.get(who) ?? []).filter((t) => now - t < 60_000)
    if (mine.length >= 6)
      return reply
        .code(429)
        .send({ error: 'Too many questions in a minute; try again shortly', code: 'RATE_LIMITED' })
    mine.push(now)
    recent.set(who, mine)
    try {
      const out = await askTelemetry(String(req.body?.question ?? ''), req.user!, {
        history: Array.isArray(req.body?.history) ? req.body.history : [],
        signal: clientGoneSignal(reply.raw),
        redis: app.redis as unknown as HealthStore
      })
      return { data: out }
    } catch (err) {
      if (err instanceof TelemetryAskError)
        return reply.code(err.status).send({ error: err.message, code: 'TELEMETRY_ASK' })
      throw err
    }
  })
}

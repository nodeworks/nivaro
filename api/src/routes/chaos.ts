import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'

/**
 * Chaos drills (#333): controlled fault injection to VERIFY the degradation
 * claims (Redis fail-open, mail no-op, slow-request honesty). Registered only
 * when CHAOS_ENABLED=true — never on an unflagged production box. Faults are
 * time-boxed and self-heal; every run is a job run.
 */

let slowUntil = 0
let slowMs = 0
let mailDownUntil = 0

export function chaosSlowDelayMs(): number {
  return Date.now() < slowUntil ? slowMs : 0
}

export function chaosMailDown(): boolean {
  return Date.now() < mailDownUntil
}

export async function chaosRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.post<{ Body: { fault?: string; seconds?: number; delay_ms?: number } }>(
    '/run',
    async (req, reply) => {
      const fault = String(req.body?.fault ?? '')
      const seconds = Math.min(300, Math.max(5, Number(req.body?.seconds) || 30))
      const { startJobRun } = await import('../services/job-runs.js')
      const run = await startJobRun('chaos', `chaos:${fault}`, {
        triggeredBy: req.user?.id ?? null
      })
      try {
        if (fault === 'slow_requests') {
          slowMs = Math.min(5000, Math.max(100, Number(req.body?.delay_ms) || 1500))
          slowUntil = Date.now() + seconds * 1000
          await run.complete(`every request delayed ${slowMs}ms for ${seconds}s`)
          return { data: { fault, seconds, delay_ms: slowMs } }
        }
        if (fault === 'mail_down') {
          mailDownUntil = Date.now() + seconds * 1000
          await run.complete(`mail sends fail for ${seconds}s`)
          return { data: { fault, seconds } }
        }
        if (fault === 'redis_pause') {
          const redis = app.redis
          redis.disconnect()
          setTimeout(() => {
            void redis.connect().catch(() => {})
          }, seconds * 1000)
          await run.complete(`redis disconnected for ${seconds}s`)
          return { data: { fault, seconds } }
        }
        await run.fail(new Error(`unknown fault: ${fault}`))
        return reply
          .code(400)
          .send({ error: 'fault must be slow_requests | mail_down | redis_pause' })
      } catch (err) {
        await run.fail(err)
        throw err
      }
    }
  )
}

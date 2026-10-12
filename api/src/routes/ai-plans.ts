import type { FastifyInstance, FastifyReply } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import { listPlanStepKinds } from '../services/ai-plan-steps.js'
import { cancelPlan, getPlan, recheckPlan, runPlan } from '../services/ai-plans.js'

/**
 * Ask AI multi-step plans (#1807) — the plan card's routes, mounted under
 * /api/ai. Plans are PROPOSED only by the chat (the propose_plan tool); these
 * read, run, retry and stop them. Only the person who asked runs, retries or
 * stops a plan; an administrator may read one. Every step runs as that
 * person through the normal services.
 *
 *   GET  /ai/plans/step-kinds      the step kinds the model may use
 *   GET  /ai/plans/:id             the plan with each step's state
 *   POST /ai/plans/:id/run         {mode?: 'all' | 'next'} → 202, runs in the background
 *   POST /ai/plans/:id/retry       re-check the failed + remaining steps → paused
 *   POST /ai/plans/:id/cancel      discard (not started) or stop before the next step
 */
export async function aiPlanRoutes(app: FastifyInstance) {
  const fail = (reply: FastifyReply, err: unknown) => {
    const status = (err as { statusCode?: number }).statusCode ?? 400
    return reply.code(status).send({ error: err instanceof Error ? err.message : 'Failed' })
  }

  app.get('/plans/step-kinds', { preHandler: authenticate }, async () => ({
    data: listPlanStepKinds().map((k) => ({ kind: k.kind, label: k.label, describe: k.describe }))
  }))

  app.get<{ Params: { id: string } }>(
    '/plans/:id',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await getPlan(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { mode?: string } | undefined }>(
    '/plans/:id/run',
    { preHandler: authenticate },
    async (req, reply) => {
      const mode = req.body?.mode === 'next' ? 'next' : 'all'
      try {
        return reply.code(202).send({ data: await runPlan(req.user!, req.params.id, { mode }) })
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/plans/:id/retry',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await recheckPlan(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/plans/:id/cancel',
    { preHandler: authenticate },
    async (req, reply) => {
      try {
        return { data: await cancelPlan(req.user!, req.params.id) }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )
}

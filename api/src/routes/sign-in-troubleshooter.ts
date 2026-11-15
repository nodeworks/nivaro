import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { withReadGate } from '../services/read-gate.js'
import { readSignInRefusals, readSignInTroubleshooter } from '../services/sign-in-troubleshooter.js'

/**
 * The person page's sign-in troubleshooter (idea 32), administrators only, read-only:
 *
 *   GET /users/:userId/sign-in-troubleshooter            30 days of sign-in attempts with a
 *       plain reason + what to do per failure, the account's standing, last sign-in, phones
 *   GET /users/:userId/sign-in-troubleshooter/refusals   ?days=1–14 (default 7): requests made
 *       as the person that the API refused (401/403), by code — from the request log (NOLOCK)
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BAD_ID = { error: 'Not a user id', code: 'USER_ID_INVALID' }
const NOT_FOUND = { error: 'No such person', code: 'NOT_FOUND' }

export async function signInTroubleshooterRoutes(app: FastifyInstance) {
  app.get<{ Params: { userId: string } }>(
    '/users/:userId/sign-in-troubleshooter',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!UUID.test(req.params.userId)) return reply.code(400).send(BAD_ID)
      const data = await readSignInTroubleshooter(app.redis, req.params.userId)
      if (!data) return reply.code(404).send(NOT_FOUND)
      return { data }
    }
  )

  app.get<{ Params: { userId: string }; Querystring: { days?: string } }>(
    '/users/:userId/sign-in-troubleshooter/refusals',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!UUID.test(req.params.userId)) return reply.code(400).send(BAD_ID)
      const days = Math.min(14, Math.max(1, Number(req.query.days) || 7))
      // Days of the request log: an expensive read, so it holds a read-gate slot.
      const data = await withReadGate(
        String(req.user!.id),
        () => readSignInRefusals(req.params.userId, days),
        { label: 'sign-in-refusals' }
      )
      return { data, days }
    }
  )
}

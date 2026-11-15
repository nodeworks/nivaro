import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { withReadGate } from '../services/read-gate.js'
import {
  forAudience,
  isDeskRefusedTarget,
  readSignInRefusals,
  readSignInTroubleshooter,
  type SignInHelpAudience,
  signInHelpAudience
} from '../services/sign-in-troubleshooter.js'

/**
 * The person page's sign-in troubleshooter (idea 32), read-only. Administrators get the full
 * view; support-desk members (canWorkDesk) get the same reasons and advice with every IP address
 * removed (the "probably them" match still runs on the server). Anyone else: 403.
 *
 *   GET /users/:userId/sign-in-troubleshooter            30 days of sign-in attempts with a
 *       plain reason + what to do per failure, the account's standing, last sign-in, phones
 *   GET /users/:userId/sign-in-troubleshooter/refusals   ?days=1–14 (default 7): requests made
 *       as the person that the API refused (401/403), by code — from the request log (NOLOCK)
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BAD_ID = { error: 'Not a user id', code: 'USER_ID_INVALID' }
const NOT_FOUND = { error: 'No such person', code: 'NOT_FOUND' }
const FORBIDDEN = {
  error: 'Only administrators and the support desk can see why someone cannot sign in.',
  code: 'FORBIDDEN'
}
const DESK_TARGET_FORBIDDEN = {
  error: 'Only administrators can see sign-in history for administrators and machine accounts.',
  code: 'FORBIDDEN'
}

/** The caller's audience, or null after answering 403 / 400. */
async function gate(
  req: FastifyRequest<{ Params: { userId: string } }>,
  reply: FastifyReply
): Promise<SignInHelpAudience | null> {
  if (!UUID.test(req.params.userId)) {
    void reply.code(400).send(BAD_ID)
    return null
  }
  const audience = await signInHelpAudience({ id: String(req.user!.id), isAdmin: !!req.isAdmin })
  if (!audience) {
    void reply.code(403).send(FORBIDDEN)
    return null
  }
  // The desk helps people sign in; administrators' and machine accounts' history is admin-only.
  if (audience !== 'admin' && (await isDeskRefusedTarget(req.params.userId))) {
    void reply.code(403).send(DESK_TARGET_FORBIDDEN)
    return null
  }
  return audience
}

export async function signInTroubleshooterRoutes(app: FastifyInstance) {
  app.get<{ Params: { userId: string } }>(
    '/users/:userId/sign-in-troubleshooter',
    { preHandler: requireAuth },
    async (req, reply) => {
      const audience = await gate(req, reply)
      if (!audience) return reply
      const data = await readSignInTroubleshooter(app.redis, req.params.userId)
      if (!data) return reply.code(404).send(NOT_FOUND)
      return { data: forAudience(data, audience), audience }
    }
  )

  app.get<{ Params: { userId: string }; Querystring: { days?: string } }>(
    '/users/:userId/sign-in-troubleshooter/refusals',
    { preHandler: requireAuth },
    async (req, reply) => {
      const audience = await gate(req, reply)
      if (!audience) return reply
      const days = Math.min(14, Math.max(1, Number(req.query.days) || 7))
      // Days of the request log: an expensive read, so it holds a read-gate slot. Codes and
      // messages only — nothing network-identifying, so both audiences get the same answer.
      const data = await withReadGate(
        String(req.user!.id),
        () => readSignInRefusals(req.params.userId, days),
        { label: 'sign-in-refusals' }
      )
      return { data, days }
    }
  )
}

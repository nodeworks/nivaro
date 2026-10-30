import type { FastifyReply, FastifyRequest } from 'fastify'
import { requireAuth } from '../../middleware/authenticate.js'

/**
 * Command Center sign-in gates.
 *   ccReadAuth  — every Command Center GET. Today: a signed-in person. A wallboard (kiosk) link
 *                 may later resolve to its creator here, for GETs only.
 *   ccWriteAuth — every Command Center write (nudges, actions): always a real signed-in person,
 *                 never a kiosk link.
 */
export async function ccReadAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  return requireAuth(req, reply)
}

export async function ccWriteAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  return requireAuth(req, reply)
}

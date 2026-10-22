import type { FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin } from '../../middleware/authenticate.js'

/**
 * Who may run faults (#2827). Administrators for now; #2862 turns this into the chaos-operator
 * permission with per-environment fault allowlists and blast-radius caps. Every chaos route
 * that arms, stops or records a run goes through this hook — never bare requireAdmin — so the
 * change lands in one place.
 */
export async function requireChaosOperator(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await requireAdmin(req, reply)
}

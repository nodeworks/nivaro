import type { FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { getChaosSettings } from './settings.js'

/**
 * Who may run faults (#2827, #2862): administrators, plus members of the roles named in this
 * instance's chaos settings (`operator_roles`). Every chaos route that arms, stops or records a
 * run goes through this hook — never bare requireAdmin — so the rule lives in one place. What an
 * operator may arm, and how far, is the caps' job (caps.ts), enforced in the run start path.
 *
 * Only administrators change the settings themselves (routes/chaos-ops.ts uses requireAdmin), so
 * an operator can never widen their own reach. A key limited to named collections stays out,
 * like every administration route.
 */
export async function isChaosOperator(
  user:
    | {
        role?: string | null
        admin_access?: boolean
      }
    | null
    | undefined,
  isAdmin: boolean
): Promise<boolean> {
  if (isAdmin) return true
  const role = user?.role ? String(user.role).toLowerCase() : null
  if (!role) return false
  const settings = await getChaosSettings()
  return settings.operator_roles.includes(role)
}

export async function requireChaosOperator(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await authenticate(req, reply)
  if (reply.sent) return
  if (!req.user) throw httpError(401, 'Sign in first', 'UNAUTHENTICATED')
  if (req.user.api_key_scopes)
    throw httpError(
      403,
      'This API key is limited to named collections and cannot run chaos drills',
      'API_KEY_SCOPE_MISSING'
    )
  if (!(await isChaosOperator(req.user, !!req.isAdmin)))
    throw httpError(
      403,
      'Running faults needs the chaos operator permission (administrators, or a role named in Chaos → Settings)',
      'CHAOS_OPERATOR'
    )
}

function httpError(statusCode: number, message: string, code: string) {
  return Object.assign(new Error(message), { statusCode, code })
}

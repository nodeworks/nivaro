import type { FastifyReply, FastifyRequest } from 'fastify'
import { isMultiTenant, tenantSource } from './deployment-mode.js'

/**
 * Process-wide operator routes on a Hub shared deployment (Hub phase 6 Task 22, ruling P6-13).
 *
 * One process of a shared deployment serves many apps. A route that shows or acts on the whole
 * process — its heap, a restart, its environment, its caches, its metrics — would hand one app's
 * administrator every other app's data or let them disrupt every app. There, those routes answer
 * 403 SHARED_OPERATOR_ONLY; the deployment's operator reads them through the Nivaro Hub.
 *
 * Self-hosted (no tenant source) and Nivaro Cloud (the cloud tenant source) are unchanged.
 */

export const SHARED_OPERATOR_ONLY = 'SHARED_OPERATOR_ONLY'

/** True on a Hub shared deployment, where process-wide operator routes are refused. */
export function sharedOperatorOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return isMultiTenant(env) && tenantSource(env) === 'hub'
}

/** preHandler (after requireAdmin): refuse a process-wide operator route on a shared deployment. */
export async function refuseOnSharedDeployment(
  _req: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply | undefined> {
  if (reply.sent || !sharedOperatorOnly()) return undefined
  // Returning the reply ends the hook chain (an async hook that sent must return it).
  return reply.code(403).send({
    error:
      'This shows or changes the whole shared deployment, not just your app. The deployment operator uses it from the Nivaro Hub.',
    code: SHARED_OPERATOR_ONLY
  })
}

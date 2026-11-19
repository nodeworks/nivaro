import type { FastifyRequest } from 'fastify'
import type { User } from '../types.js'
import { maintenanceExemptCaller } from './maintenance-freeze.js'

/**
 * Ask AI for ADMINISTRATORS on their own session (Rob 2026-11-18: "for admins this
 * AI should not be a restriction … just log it and make it reversible").
 *
 * Who qualifies is the one caller the maintenance freeze lets write: an administrator
 * (role), signed in with a SESSION as themselves — never View-as, an API key (scoped or
 * not), a static token, a phone/device token, an OAuth/MCP connection or an MCP tool call,
 * and never a machine account. Everyone else keeps today's limits (200 records a
 * proposal, no deletes).
 *
 * The mark rides a COPY of the user object under a module-private symbol: it cannot come
 * from JSON, the database or a request body, and the request's own `req.user` (which an
 * identity cache may share with the next request) is never mutated. What an unbounded
 * proposal changes always runs as a plan — background, chunked, progress, cancellable —
 * and keeps what it needs to be undone (services/ai-undo-store.ts).
 */

const UNBOUNDED: unique symbol = Symbol('nivaro.aiAdminUnbounded')

type Marked = User & { [UNBOUNDED]?: true }

/** Records one proposal may touch for everyone else (the old cap, unchanged). */
export const AI_PROPOSAL_MAX = 200

/**
 * Records one administrator proposal may resolve — a memory guard for the id list the
 * plan keeps (≈10 bytes an id), not a policy. Past it the AI is told to split the change
 * (by a field such as region), never to "ask an administrator" or "use an import".
 */
export const AI_ADMIN_PROPOSAL_MAX = 1_000_000

/** A real administrator on their own session (see the module comment). */
export function aiAdminUnboundedRequest(req: FastifyRequest | null | undefined): boolean {
  if (!req?.user) return false
  if (!maintenanceExemptCaller(req)) return false
  const r = req as FastifyRequest & {
    apiKeyId?: unknown
    apiKeySimulatedId?: unknown
    masqueradeAdminId?: unknown
  }
  if (r.apiKeyId != null || r.apiKeySimulatedId != null || r.masqueradeAdminId) return false
  return true
}

/** A copy of `user` carrying the administrator mark. */
export function withAiAdminUnbounded(user: User): User {
  return { ...(user as Marked), [UNBOUNDED]: true } as User
}

/** True only for a user object marked by this module (spread copies keep the mark). */
export function isAiAdminUnbounded(user: User | null | undefined): boolean {
  return (user as Marked | null | undefined)?.[UNBOUNDED] === true
}

/** The user Ask AI should act as for this request: marked when the request qualifies. */
export function aiUserFor(req: FastifyRequest): User {
  const user = req.user as User
  return aiAdminUnboundedRequest(req) ? withAiAdminUnbounded(user) : user
}

/** How many records a proposal by this user may name. */
export function proposalCap(user: User | null | undefined): number {
  return isAiAdminUnbounded(user) ? AI_ADMIN_PROPOSAL_MAX : AI_PROPOSAL_MAX
}

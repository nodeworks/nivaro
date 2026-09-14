import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { buildDelegationOverview } from '../services/delegation.js'

/**
 * Delegation console — one read model over OOO windows, delegate chains and
 * the approval load they touch (services/delegation.ts). Authenticated: who
 * is out and who covers them is org-visible (the same OOO flag every user
 * chip shows). The per-record coverage-gap list stays behind /coverage-gaps
 * (admin) and is fetched by the console separately.
 */
export async function delegationRoutes(app: FastifyInstance) {
  app.get('/delegation/overview', { preHandler: requireAuth }, async (req, reply) => {
    const days = Math.min(60, Math.max(1, Number((req.query as { days?: string }).days) || 14))
    return reply.send({ data: await buildDelegationOverview(days) })
  })

  /** Admin: set (or clear) someone else's delegate + expiry, and optionally
   *  flip their OOO flag — the "assign a delegate for them" action on the
   *  console. Self-serve stays on POST /users/me/delegate. */
  app.post<{
    Params: { userId: string }
    Body: {
      delegate_id?: string | null
      delegate_expires_at?: string | null
      is_out_of_office?: boolean
    }
  }>('/delegation/:userId/delegate', { preHandler: requireAdmin }, async (req, reply) => {
    const { userId } = req.params
    const b = req.body ?? {}
    const target = await db('nivaro_users').where({ id: userId }).first('id')
    if (!target) return reply.code(404).send({ error: 'User not found' })
    if (b.delegate_id && String(b.delegate_id).toUpperCase() === String(userId).toUpperCase())
      return reply.code(400).send({ error: 'A person cannot delegate to themselves' })
    if (b.delegate_id) {
      const d = await db('nivaro_users').where({ id: b.delegate_id }).first('id', 'status')
      if (!d) return reply.code(400).send({ error: 'Delegate not found' })
      if (String(d.status ?? '').toLowerCase() === 'suspended')
        return reply.code(400).send({ error: 'That delegate is suspended' })
    }
    const patch: Record<string, unknown> = {}
    if ('delegate_id' in b) patch.delegate_id = b.delegate_id ?? null
    if ('delegate_expires_at' in b)
      patch.delegate_expires_at = b.delegate_expires_at ? new Date(b.delegate_expires_at) : null
    if (typeof b.is_out_of_office === 'boolean') patch.is_out_of_office = b.is_out_of_office
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'Nothing to change' })
    await db('nivaro_users').where({ id: userId }).update(patch)
    if (patch.is_out_of_office === true && patch.delegate_id) {
      const { delegateOpenTasks } = await import('../services/task-delegation.js')
      void delegateOpenTasks(userId, app)
    }
    await logActivity({
      action: 'delegation-assign',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: String(userId),
      comment: `delegate → ${patch.delegate_id ?? 'none'}${patch.delegate_expires_at ? ` until ${new Date(patch.delegate_expires_at as Date).toISOString().slice(0, 10)}` : ''}`,
      req
    })
    return reply.send({ data: { ok: true } })
  })
}

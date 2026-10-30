import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'

// ─── Permission summary in words (#12) ───────────────────────────────────────
// GET /api/access/summary?role=<id> | ?user=<id>
// "Buyers can see and edit POs in their own Zones, can't delete, can't see
// the Cost field." Built by services/access-summary.ts from can(),
// getAllowedFields(), getRowFilter() and the scope routing the read path
// runs, so the words match enforcement. Administrators ask about any role or
// person; anyone else only about themselves (?user=<own id>), and their own
// answer never names a field their role hides from them.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function accessSummaryRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { role?: string; user?: string } }>(
    '/access/summary',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { role, user } = req.query ?? {}
      if ((role ? 1 : 0) + (user ? 1 : 0) !== 1)
        return reply.code(400).send({ error: 'Pass exactly one of role or user' })
      const id = String(role ?? user)
      if (!UUID_RE.test(id))
        return reply.code(404).send({ error: role ? 'Role not found' : 'User not found' })
      const self = !!user && id.toLowerCase() === String(req.user!.id).toLowerCase()
      if (!req.isAdmin && !self) return reply.code(403).send({ error: 'Admin only' })
      const { summarizeAccess } = await import('../services/access-summary.js')
      const data = await summarizeAccess(role ? { role: id } : { user: id }, {
        viewerIsAdmin: !!req.isAdmin,
        self
      })
      if (!data) return reply.code(404).send({ error: role ? 'Role not found' : 'User not found' })
      return reply.send({ data })
    }
  )
}

import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { explainAccess, UnknownCollectionError } from '../services/access-explain.js'

// ─── Access explain ──────────────────────────────────────────────────────────
// "Why can't I see this record?" — a scoped user hitting a record outside
// their User Scopes (or an RLS row filter) gets a bare 404 from /items, which
// reads as a broken app. This route re-runs each access gate SEPARATELY for
// one (collection, id) and names the one(s) that hid the record, so the
// record form can explain instead of shrugging.
//
// Deliberate trade-off: telling a user "this record exists but your Region
// filter excludes it" confirms the record's existence — acceptable for an
// internal operator console where the alternative is a support ticket.
// The route only ever returns REASONS, never record data.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function accessExplainRoutes(app: FastifyInstance): Promise<void> {
  app.get('/access-explain/:collection/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }
    if (
      !IDENT_RE.test(collection) ||
      /^nivaro_/i.test(collection) ||
      /^directus_/i.test(collection)
    ) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    // Admin access explain (#120): ?user_id= evaluates AS another user —
    // "why can't Beth see this record" without masquerading. Admin-only;
    // the impersonated evaluation is read-only by construction.
    const asUserId = (req.query as { user_id?: string } | undefined)?.user_id
    let user = req.user!
    let actingAdmin = !!req.isAdmin
    if (asUserId && String(asUserId) !== String(req.user!.id)) {
      if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
      const target = await db('nivaro_users').where({ id: asUserId }).first()
      if (!target) return reply.code(404).send({ error: 'User not found' })
      user = target as typeof user
      const targetRole = target.role
        ? await db('nivaro_roles').where({ id: target.role }).first('admin_access')
        : null
      actingAdmin = !!(targetRole as { admin_access?: boolean } | null)?.admin_access
    }
    try {
      const result = await explainAccess(user, actingAdmin, collection, id)
      // trash_id is an admin affordance — strip it for everyone else.
      if (!actingAdmin) for (const r of result.reasons) delete r.trash_id
      return reply.send({ data: result })
    } catch (err) {
      if (err instanceof UnknownCollectionError)
        return reply.code(400).send({ error: 'Unknown collection' })
      throw err
    }
  })
}

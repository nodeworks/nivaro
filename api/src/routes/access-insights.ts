import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { explainAccess, UnknownCollectionError } from '../services/access-explain.js'
import type { DeniedAction } from '../services/denied-explain.js'
import type { User } from '../types.js'

// ─── Access insights (#1867 #1956 #1907 #1958 #1959) ────────────────────────
// Plain-language answers to "why was I refused", "why does Kim own this",
// "who can act on this now", "what would this role change do" and "what can
// Beth see". Every answer is built by the deterministic services (the same
// gates and resolvers the rest of the app runs) and only phrased here.
//
// Disclosure rules:
// - Denied: about the caller only, the same facts /access-explain already
//   gives them (their role, their filters, the lock holder).
// - Owners / act-now: only for a record the caller can see (else 404, the
//   same answer /items gives). A non-admin never sees the record's value for
//   a field their role cannot read — the group's filter is shown, the
//   record's value is blanked.
// - Role change / person access: administrators only (a person may ask
//   about their own access).

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DENIED_ACTIONS = new Set<DeniedAction>(['read', 'update', 'delete', 'transition'])

function businessCollection(c: string): boolean {
  return IDENT_RE.test(c) && !/^(nivaro|directus)_/i.test(c)
}

/** The caller can see the record (role, row filter, scopes) — else 404. */
async function canSeeRecord(
  user: User,
  isAdmin: boolean,
  collection: string,
  id: string
): Promise<boolean> {
  try {
    return (await explainAccess(user, isAdmin, collection, id)).access
  } catch (err) {
    if (err instanceof UnknownCollectionError) return false
    throw err
  }
}

export async function accessInsightRoutes(app: FastifyInstance): Promise<void> {
  // #1867 — why the caller was refused a read, save, delete or move.
  app.get<{
    Params: { collection: string; id: string }
    Querystring: { action?: string; transition?: string }
  }>('/access-insights/denied/:collection/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, id } = req.params
    if (!businessCollection(collection))
      return reply.code(400).send({ error: 'Invalid collection' })
    const action = (req.query.action ?? 'update') as DeniedAction
    if (!DENIED_ACTIONS.has(action)) return reply.code(400).send({ error: 'Invalid action' })
    const { explainDenied, TransitionNotFoundError } = await import('../services/denied-explain.js')
    try {
      const data = await explainDenied(req.user!, !!req.isAdmin, {
        collection,
        id,
        action,
        transitionId: req.query.transition ?? null
      })
      return reply.send({ data })
    } catch (err) {
      if (err instanceof UnknownCollectionError)
        return reply.code(400).send({ error: 'Unknown collection' })
      if (err instanceof TransitionNotFoundError)
        return reply.code(404).send({ error: 'Transition not found for this record' })
      throw err
    }
  })

  // #1956 — why each person owns the record's current step.
  app.get<{ Params: { collection: string; id: string } }>(
    '/access-insights/owners/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!businessCollection(collection))
        return reply.code(400).send({ error: 'Invalid collection' })
      if (!(await canSeeRecord(req.user!, !!req.isAdmin, collection, id)))
        return reply.code(404).send({ error: 'Not found' })
      const { explainRecordOwners, redactOwnerFacts } = await import('../services/owner-explain.js')
      const ex = await explainRecordOwners(collection, id)
      if (!ex) return reply.code(404).send({ error: 'This record is not in a workflow' })
      return reply.send({ data: await redactOwnerFacts(ex, req.user!, !!req.isAdmin) })
    }
  )

  // #1907 — who can act on the current step right now.
  app.get<{ Params: { collection: string; id: string } }>(
    '/access-insights/act-now/:collection/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!businessCollection(collection))
        return reply.code(400).send({ error: 'Invalid collection' })
      if (!(await canSeeRecord(req.user!, !!req.isAdmin, collection, id)))
        return reply.code(404).send({ error: 'Not found' })
      const { whoCanActNow } = await import('../services/who-can-act.js')
      const data = await whoCanActNow(req.user!, !!req.isAdmin, collection, id)
      if (!data) return reply.code(404).send({ error: 'This record is not in a workflow' })
      return reply.send({ data })
    }
  )

  // #1958 — a role's pending permission changes, in words, before saving.
  app.post<{ Params: { id: string }; Body: { changes?: unknown } }>(
    '/access-insights/roles/:id/explain-change',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Role not found' })
      const { explainRoleChange } = await import('../services/role-change-impact.js')
      const data = await explainRoleChange(req.params.id, req.body?.changes)
      if (!data) return reply.code(404).send({ error: 'Role not found' })
      return reply.send({ data })
    }
  )

  // #1959 — what a person can see and change, in words.
  app.get<{ Params: { id: string } }>(
    '/access-insights/people/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: 'User not found' })
      const self = String(req.params.id).toUpperCase() === String(req.user!.id).toUpperCase()
      if (!self && !req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
      const exists = await db('nivaro_users').where({ id: req.params.id }).first('id')
      if (!exists) return reply.code(404).send({ error: 'User not found' })
      const { summarizePersonAccess } = await import('../services/person-access.js')
      const data = await summarizePersonAccess(req.params.id, { selfView: !req.isAdmin })
      if (!data) return reply.code(404).send({ error: 'User not found' })
      return reply.send({ data })
    }
  )
}

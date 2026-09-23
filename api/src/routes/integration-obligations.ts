/**
 * Integration obligations — read routes.
 *
 * The BOARD (summary + list) is an operational view across every record on
 * the instance and is admin, same posture as /integration-health. The
 * per-RECORD read is gated on the caller's own read permission for that
 * collection instead — exactly like /config-conformance/record/:c/:id —
 * because the record banner and Ask AI have to work for whoever owns the
 * record, not just admins.
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { listObligationKinds, summariseObligations } from '../services/integration-obligations.js'
import { can } from '../services/permissions.js'

const MAX_LIMIT = 200
const RECORD_CAP = 50

export async function integrationObligationsRoutes(app: FastifyInstance): Promise<void> {
  // The board: admin-only, matching /integration-health.
  app.get('/integration-obligations/summary', { preHandler: requireAdmin }, async () => {
    const rows = (await db('nivaro_integration_obligations')
      .select('api', 'outcome')
      .count({ c: '*' })
      .min({ oldest: 'due_at' })
      .groupBy('api', 'outcome')) as Array<{
      api: string
      outcome: string
      c: number
      oldest: Date | null
    }>
    const apiRows = (await db('nivaro_external_apis').select('name', 'owner_user')) as Array<{
      name: string
      owner_user: string | null
    }>
    const owners: Record<string, string | null> = {}
    for (const a of apiRows) owners[a.name] = a.owner_user
    return { data: { apis: summariseObligations(rows, owners), kinds: listObligationKinds() } }
  })

  app.get<{
    Querystring: {
      api?: string
      kind?: string
      collection?: string
      outcome?: string
      age_hours?: string
      page?: string
      limit?: string
    }
  }>('/integration-obligations', { preHandler: requireAdmin }, async (req) => {
    const q = req.query
    const page = Math.max(1, Number(q.page) || 1)
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || 50))
    const base = db('nivaro_integration_obligations')
    // `api` is filtered by name — the ledger stores the resolved name, never
    // the numeric id an action may have been configured with.
    if (q.api) base.where({ api: q.api })
    if (q.kind) base.where({ kind: q.kind })
    if (q.collection) base.where({ collection: q.collection })
    if (q.outcome) {
      const list = q.outcome
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (list.length > 0) base.whereIn('outcome', list)
    }
    if (q.age_hours) {
      const hours = Number(q.age_hours)
      if (Number.isFinite(hours) && hours > 0) {
        base.where('due_at', '<', new Date(Date.now() - hours * 3_600_000))
      }
    }
    const [{ total }] = (await base.clone().count({ total: '*' })) as Array<{ total: number }>
    const rows = await base
      .clone()
      .orderBy('due_at', 'desc')
      .offset((page - 1) * limit)
      .limit(limit)
      .select(
        'id',
        'api',
        'kind',
        'collection',
        'item',
        'trigger',
        'trigger_ref',
        'due_at',
        'outcome',
        'reason',
        'submission_id',
        'resolved_at'
      )
    return { data: rows, total: Number(total) || 0, page, limit }
  })

  // One record's ledger, newest first. NOT admin-only — gated on the
  // caller's read permission for the record's own collection, so it works
  // for whoever the record belongs to.
  app.get<{ Params: { collection: string; item: string } }>(
    '/integration-obligations/record/:collection/:item',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      // Rides ix_integration_obligations_record (collection, item, kind, id
      // DESC) — order by id, not due_at, so the index actually serves it.
      const rows = await db('nivaro_integration_obligations')
        .where({ collection, item: String(item) })
        .orderBy('id', 'desc')
        .limit(RECORD_CAP)
        .select(
          'id',
          'api',
          'kind',
          'trigger',
          'due_at',
          'outcome',
          'reason',
          'submission_id',
          'resolved_at'
        )
      return { data: rows }
    }
  )
}

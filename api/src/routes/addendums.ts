import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

function formatAddendum(row: Record<string, unknown>) {
  return {
    ...row,
    fields_schema: parseJsonSafe(row.fields_schema),
    data: parseJsonSafe(row.data)
  }
}

export async function addendumsRoutes(app: FastifyInstance) {
  // ─── Change orders (must be before /:id routes) ───────────────────────────────

  // GET /addendums/change-orders/:collection/:itemId
  app.get(
    '/change-orders/:collection/:itemId',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, itemId } = req.params as { collection: string; itemId: string }

      const rows = (await db('nivaro_change_orders as co')
        .leftJoin('nivaro_addendums as a', 'co.addendum_id', 'a.id')
        .where({ 'co.parent_collection': collection, 'co.parent_id': itemId })
        .select(
          'co.*',
          'a.title as addendum_title',
          'a.description as addendum_description',
          'a.cost_impact',
          'a.timeline_impact_days'
        )
        .orderBy('co.created_at', 'desc')) as Record<string, unknown>[]

      return reply.send({ data: rows })
    }
  )

  // ─── Addendum CRUD ────────────────────────────────────────────────────────────

  // GET /addendums/:collection/:itemId — list addendums for a parent record
  app.get('/:collection/:itemId', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId } = req.params as { collection: string; itemId: string }

    if (!(await can(req.user!, 'read', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const rows = (await db('nivaro_addendums')
      .where({ parent_collection: collection, parent_id: itemId })
      .orderBy('created_at', 'desc')) as Record<string, unknown>[]

    return reply.send({ data: rows.map(formatAddendum) })
  })

  // GET /addendums/:id — get single addendum
  app.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const row = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })

    return reply.send({ data: formatAddendum(row) })
  })

  // POST /addendums — create
  app.post('/', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      parent_collection: string
      parent_id: string
      title: string
      description?: string
      workflow_template_id?: string | null
      fields_schema?: unknown
      data?: Record<string, unknown>
      cost_impact?: number | null
      timeline_impact_days?: number | null
    }

    if (!body.parent_collection || !body.parent_id || !body.title) {
      return reply.code(400).send({ error: 'parent_collection, parent_id, and title are required' })
    }

    const col = (await db('nivaro_collections')
      .where({ collection: body.parent_collection })
      .select('addendums_enabled')
      .first()) as { addendums_enabled: number | boolean } | undefined

    const enabled = col?.addendums_enabled === 1 || col?.addendums_enabled === true
    if (!enabled) {
      return reply.code(403).send({ error: 'Addendums are not enabled for this collection' })
    }

    const now = new Date()
    const [row] = await db('nivaro_addendums')
      .insert({
        parent_collection: body.parent_collection,
        parent_id: body.parent_id,
        title: body.title,
        description: body.description ?? null,
        workflow_template_id: body.workflow_template_id ?? null,
        fields_schema: body.fields_schema != null ? JSON.stringify(body.fields_schema) : null,
        data: body.data != null ? JSON.stringify(body.data) : null,
        cost_impact: body.cost_impact ?? null,
        timeline_impact_days: body.timeline_impact_days ?? null,
        status: 'draft',
        created_by: req.user!.id,
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = (await db('nivaro_addendums').where({ id: insertedId }).first()) as Record<
      string,
      unknown
    >

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: String(insertedId),
      req
    })

    // Start workflow instance if template specified
    if (body.workflow_template_id) {
      try {
        const template = await db('nivaro_workflow_templates')
          .where({ id: body.workflow_template_id })
          .first()
        if (template) {
          const initialState = await db('nivaro_workflow_states')
            .where({ template: body.workflow_template_id, is_initial: 1 })
            .first()
          if (initialState) {
            await db('nivaro_workflow_instances').insert({
              template: body.workflow_template_id,
              collection: 'nivaro_addendums',
              item: String(insertedId),
              current_state: initialState.id,
              started_at: now
            })
          }
        }
      } catch (err) {
        console.error('Failed to start workflow for addendum:', err)
      }
    }

    return reply.code(201).send({ data: formatAddendum(created) })
  })

  // PATCH /addendums/:id — update (owner or admin)
  app.patch('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = req.body as Partial<{
      title: string
      description: string | null
      fields_schema: unknown
      data: Record<string, unknown>
      cost_impact: number | null
      timeline_impact_days: number | null
    }>

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.title !== undefined) patch.title = body.title
    if ('description' in body) patch.description = body.description ?? null
    if ('fields_schema' in body)
      patch.fields_schema = body.fields_schema != null ? JSON.stringify(body.fields_schema) : null
    if ('data' in body) patch.data = body.data != null ? JSON.stringify(body.data) : null
    if ('cost_impact' in body) patch.cost_impact = body.cost_impact ?? null
    if ('timeline_impact_days' in body)
      patch.timeline_impact_days = body.timeline_impact_days ?? null

    await db('nivaro_addendums').where({ id }).update(patch)
    const updated = (await db('nivaro_addendums').where({ id }).first()) as Record<string, unknown>

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    return reply.send({ data: formatAddendum(updated) })
  })

  // DELETE /addendums/:id — delete (admin only)
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = await db('nivaro_addendums').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_addendums').where({ id }).delete()

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // ─── Status transitions ───────────────────────────────────────────────────────

  // POST /addendums/:id/submit — set status='review'
  app.post('/:id/submit', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (existing.status !== 'draft') {
      return reply.code(409).send({ error: 'Only draft addendums can be submitted for review' })
    }

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_addendums').where({ id }).update({ status: 'review', updated_at: new Date() })

    await logActivity({
      action: 'submit_review',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    return reply.send({ data: { id, status: 'review' } })
  })

  // POST /addendums/:id/approve — set status='approved', create change order
  app.post('/:id/approve', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (existing.status !== 'review') {
      return reply.code(409).send({ error: 'Only review-status addendums can be approved' })
    }

    // Check approval rights: admin access or role-based approval
    const isAdmin = req.isAdmin ?? false
    const userRole = req.userRole
    const hasApprovalRights = isAdmin || (userRole?.admin_access ?? false)
    if (!hasApprovalRights) {
      return reply.code(403).send({ error: 'You do not have approval rights' })
    }

    const now = new Date()
    await db('nivaro_addendums')
      .where({ id })
      .update({ status: 'approved', approved_by: req.user!.id, approved_at: now, updated_at: now })

    // Create change order log entry if not already exists
    const existingOrder = await db('nivaro_change_orders').where({ addendum_id: id }).first()

    if (!existingOrder) {
      await db('nivaro_change_orders').insert({
        addendum_id: id,
        parent_collection: existing.parent_collection,
        parent_id: existing.parent_id,
        approved_by: req.user!.id,
        approved_at: now,
        created_at: now,
        updated_at: now
      })
    }

    await logActivity({
      action: 'approve',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    return reply.send({ data: { id, status: 'approved' } })
  })

  // POST /addendums/:id/reject — set status='rejected'
  app.post('/:id/reject', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_addendums').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (!['review', 'draft'].includes(existing.status as string)) {
      return reply.code(409).send({ error: 'Cannot reject an already approved addendum' })
    }

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_addendums')
      .where({ id })
      .update({ status: 'rejected', updated_at: new Date() })

    await logActivity({
      action: 'reject',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      req
    })

    return reply.send({ data: { id, status: 'rejected' } })
  })
}

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

// Columns blocked on the nivaro_addendums table write path
const RESERVED_COLUMNS = new Set([
  'id', 'created_at', 'updated_at', 'created_by', 'status',
  'parent_collection', 'parent_id', 'title', 'description',
  'cost_impact', 'timeline_impact_days', 'workflow_template_id',
  'addendum_layout_id', 'approved_by', 'approved_at',
  'fields_schema', 'data'
])

// Columns blocked on the PARENT business table write path (apply-back on approve)
const PARENT_WRITE_BLOCKED_COLUMNS = new Set([
  'id', 'created_at', 'updated_at', 'created_by',
  'password', 'password_hash', 'totp_secret', 'totp_enabled',
  'static_token', 'admin_access', 'app_access',
  'tenant_id', 'workspace_id', 'workspace', 'owner_id',
  'deleted_at', 'is_deleted', 'is_redacted', 'redacted_at',
  'external_id', 'role',
])

async function getAllowedAddendumFields(
  collection: string,
  addendumLayoutId: number | null | undefined
): Promise<Set<string>> {
  let layoutId = addendumLayoutId

  if (layoutId) {
    // Verify the provided layout belongs to this collection and is an addendum-type layout
    const layout = await db('nivaro_collection_layouts')
      .where({ id: layoutId })
      .select('id', 'collection', 'layout_type')
      .first() as { id: number; collection: string; layout_type: string } | undefined
    if (!layout || layout.collection !== collection || layout.layout_type !== 'addendum') {
      return new Set()
    }
  } else {
    // Find the default addendum-type layout for this collection
    const defaultLayout = await db('nivaro_collection_layouts')
      .where({ collection, layout_type: 'addendum' })
      .orderBy('sort', 'asc')
      .first() as { id: number } | undefined
    if (!defaultLayout) return new Set()
    layoutId = defaultLayout.id
  }

  const assignments = await db('nivaro_layout_field_assignments')
    .where({ layout_id: layoutId })
    .select('field') as Array<{ field: string }>

  // Exclude sentinel fields and reserved columns
  return new Set(
    assignments
      .map((a) => a.field)
      .filter((k) => !k.startsWith('__') && !RESERVED_COLUMNS.has(k))
  )
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

      const rows = (await db('nivaro_addendum_approvals as co')
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
      addendum_layout_id?: number | null
    }

    if (!body.parent_collection || !body.parent_id || !body.title) {
      return reply.code(400).send({ error: 'parent_collection, parent_id, and title are required' })
    }

    const col = (await db('nivaro_collections')
      .where({ collection: body.parent_collection })
      .select('addendums_enabled', 'addendum_allowed_roles', 'addendum_allowed_states')
      .first()) as { addendums_enabled: number | boolean; addendum_allowed_roles: string | null; addendum_allowed_states: string | null } | undefined

    const enabled = col?.addendums_enabled === 1 || col?.addendums_enabled === true
    if (!enabled) {
      return reply.code(403).send({ error: 'Addendums are not enabled for this collection' })
    }

    // Role restriction check
    if (!req.isAdmin && col?.addendum_allowed_roles) {
      const allowedRoles = parseJsonSafe(col.addendum_allowed_roles) as string[] | null
      if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
        const userRole = req.user?.role ?? null
        if (!userRole || !allowedRoles.includes(userRole)) {
          return reply.code(403).send({ error: 'Your role is not allowed to create addendums for this collection' })
        }
      }
    }

    // State restriction check
    if (col?.addendum_allowed_states) {
      const stateRules = parseJsonSafe(col.addendum_allowed_states) as Array<{ pipeline_id: string; state_keys: string[] }> | null
      if (Array.isArray(stateRules) && stateRules.length > 0) {
        // Find the pipeline instance for this item
        const binding = await db('nivaro_workflow_bindings')
          .whereIn('template', stateRules.map((r) => r.pipeline_id))
          .where({ collection: body.parent_collection })
          .first() as { template: string } | undefined
        if (binding) {
          const instance = await db('nivaro_workflow_instances')
            .where({ collection: body.parent_collection, item: String(body.parent_id) })
            .first() as { current_state: string | null } | undefined
          const currentState = instance?.current_state ?? null
          if (currentState) {
            const stateRow = await db('nivaro_workflow_states').where({ id: currentState }).select('key').first() as { key: string } | undefined
            const currentKey = stateRow?.key ?? null
            const rule = stateRules.find((r) => r.pipeline_id === binding.template)
            if (rule && rule.state_keys.length > 0 && currentKey && !rule.state_keys.includes(currentKey)) {
              return reply.code(403).send({ error: 'Addendums cannot be created in the current pipeline state' })
            }
          }
        }
      }
    }

    // Validate that the provided addendum_layout_id belongs to this collection
    if (body.addendum_layout_id != null) {
      const layout = await db('nivaro_collection_layouts')
        .where({ id: body.addendum_layout_id, collection: body.parent_collection, layout_type: 'addendum' })
        .first()
      if (!layout) {
        return reply.code(400).send({ error: 'Invalid addendum_layout_id for this collection' })
      }
    }

    // Sanitize data to only allowed fields from the addendum layout.
    // Deny-all when no layout configured (no valid addendum layout = no writable fields).
    let sanitizedData: Record<string, unknown> | null = null
    if (body.data != null) {
      const allowedFields = await getAllowedAddendumFields(body.parent_collection, body.addendum_layout_id ?? null)
      sanitizedData = Object.fromEntries(
        Object.entries(body.data).filter(([k]) => allowedFields.has(k))
      )
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
        data: sanitizedData != null ? JSON.stringify(sanitizedData) : null,
        cost_impact: body.cost_impact ?? null,
        timeline_impact_days: body.timeline_impact_days ?? null,
        addendum_layout_id: body.addendum_layout_id ?? null,
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

    // Apply addendum data back to parent record
    if (existing.data) {
      const data = parseJsonSafe(existing.data) as Record<string, unknown> | null
      if (data && typeof data === 'object') {
        const allowedKeys = await getAllowedAddendumFields(
          existing.parent_collection as string,
          existing.addendum_layout_id as number | null
        )
        const fieldMeta = await db('nivaro_fields')
          .where({ collection: existing.parent_collection as string })
          .select('field', 'interface', 'type') as Array<{ field: string; interface: string | null; type: string | null }>
        const subRowFields = new Set(
          fieldMeta.filter((f) => f.interface === 'sub-rows').map((f) => f.field)
        )
        // O2M and M2M relations are stored in related tables — cannot be set as scalar columns; skip on apply-back
        const relationFields = await db('nivaro_relations')
          .where({ one_collection: existing.parent_collection as string })
          .select('one_field') as Array<{ one_field: string | null }>
        const relationFieldSet = new Set(relationFields.map((r) => r.one_field).filter(Boolean) as string[])
        const scalarPatch: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(data)) {
          if (PARENT_WRITE_BLOCKED_COLUMNS.has(key)) continue
          if (!allowedKeys.has(key)) continue
          if (relationFieldSet.has(key)) continue
          if (subRowFields.has(key)) {
            const rows = Array.isArray(value) ? value : []
            await db('nivaro_sub_rows')
              .where({ parent_collection: existing.parent_collection, parent_id: existing.parent_id, sub_row_field: key })
              .delete()
            if (rows.length > 0) {
              await db('nivaro_sub_rows').insert(
                rows.map((row: unknown, idx: number) => ({
                  parent_collection: existing.parent_collection,
                  parent_id: existing.parent_id,
                  sub_row_field: key,
                  sort: idx,
                  data: JSON.stringify(row),
                  created_at: now,
                  updated_at: now,
                }))
              )
            }
          } else {
            scalarPatch[key] = value
          }
        }
        if (Object.keys(scalarPatch).length > 0) {
          await db(existing.parent_collection as string)
            .where({ id: existing.parent_id })
            .update({ ...scalarPatch, updated_at: now })
        }
      }
    }

    await db('nivaro_addendums')
      .where({ id })
      .update({ status: 'approved', approved_by: req.user!.id, approved_at: now, updated_at: now })

    // Create change order log entry if not already exists
    const existingOrder = await db('nivaro_addendum_approvals').where({ addendum_id: id }).first()

    if (!existingOrder) {
      const approvalCount = await db('nivaro_addendum_approvals')
        .where({ parent_collection: existing.parent_collection, parent_id: existing.parent_id })
        .count('id as cnt')
        .then((r) => Number((r[0] as { cnt: number }).cnt))
      await db('nivaro_addendum_approvals').insert({
        addendum_id: id,
        parent_collection: existing.parent_collection,
        parent_id: existing.parent_id,
        order_number: approvalCount + 1,
        approved_by: req.user!.id,
        approved_at: now,
        created_at: now,
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

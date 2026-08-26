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
    data: parseJsonSafe(row.data),
    attachments: parseJsonSafe(row.attachments)
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
      attachments?: unknown
    }

    if (!body.parent_collection || !body.parent_id || !body.title) {
      return reply.code(400).send({ error: 'parent_collection, parent_id, and title are required' })
    }

    const col = (await db('nivaro_collections')
      .where({ collection: body.parent_collection })
      .select('addendums_enabled', 'addendum_allowed_roles', 'addendum_allowed_states', 'addendum_start_states')
      .first()) as { addendums_enabled: number | boolean; addendum_allowed_roles: string | null; addendum_allowed_states: string | null; addendum_start_states: string | null } | undefined

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
        // Supporting files uploaded from the create form — file ids only.
        attachments:
          Array.isArray(body.attachments) && body.attachments.length > 0
            ? JSON.stringify(body.attachments.map(String).slice(0, 50))
            : null,
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
          // Configured start state (Settings → Addendums) wins over the
          // template's is_initial state; a stale key falls back to is_initial.
          let startState: { id: string } | undefined
          const startRules = parseJsonSafe(col?.addendum_start_states ?? null) as
            | Array<{ pipeline_id: string; state_key: string }>
            | null
          const startRule = Array.isArray(startRules)
            ? startRules.find((r) => r.pipeline_id === body.workflow_template_id)
            : null
          if (startRule?.state_key) {
            startState = await db('nivaro_workflow_states')
              .where({ template: body.workflow_template_id, key: startRule.state_key })
              .first() as { id: string } | undefined
          }
          if (!startState) {
            startState = await db('nivaro_workflow_states')
              .where({ template: body.workflow_template_id, is_initial: 1 })
              .first() as { id: string } | undefined
          }
          if (startState) {
            await db('nivaro_workflow_instances').insert({
              template: body.workflow_template_id,
              collection: 'nivaro_addendums',
              item: String(insertedId),
              current_state: startState.id,
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

    // Apply-back + status + change order + line changes + auto-PDF all live in
    // the shared service (the pipeline terminal-state sync uses the same one).
    const { applyAddendumApproval } = await import('../services/addendum-approve.js')
    const result = await applyAddendumApproval(id, req.user!.id, {
      allowedFromStatuses: ['review'],
      app,
      pdfAuthHeaders: {
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        ...(req.headers['x-workspace']
          ? { 'x-workspace': String(req.headers['x-workspace']) }
          : {})
      }
    })
    if (!result.ok) {
      return reply.code(result.status ?? 400).send({ error: result.error ?? 'Approve failed' })
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

  // POST /addendums/:id/revert — ADMIN ONLY: roll an approved addendum back
  // so its changes never landed. The addendum row survives as status
  // 'reverted', the change-order row is removed, and every restored value
  // rides the normal revision trail — fully visible in history and logs.
  app.post('/:id/revert', { preHandler: authenticate }, async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { id } = req.params as { id: string }
    const { revertAddendumApproval } = await import('../services/addendum-approve.js')
    const result = await revertAddendumApproval(id, req.user!.id)
    if (!result.ok) {
      return reply.code(result.status ?? 400).send({ error: result.error ?? 'Revert failed' })
    }
    await logActivity({
      action: 'addendum-revert',
      user: req.user?.id,
      collection: 'nivaro_addendums',
      item: id,
      comment: `restored ${result.line_changes_applied ?? 0} line change(s)${(result.line_changes_failed ?? 0) > 0 ? `, ${result.line_changes_failed} failed` : ''}`,
      req
    })
    return reply.send({ data: { id, status: 'reverted' } })
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

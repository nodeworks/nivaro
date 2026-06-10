import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { applyFieldRules } from '../services/items.js'

interface FieldRuleBody {
  collection?: string
  trigger_field?: string
  trigger_op?: string
  trigger_value?: string | null
  target_field?: string
  target_type?: string
  target_value?: string | null
  sort?: number
  is_active?: boolean
}

const VALID_OPS = new Set(['eq', 'neq', 'null', 'nnull', 'in', 'contains'])
const VALID_TARGET_TYPES = new Set(['set', 'clear'])

export async function fieldRulesRoutes(app: FastifyInstance) {
  // GET /field-rules?collection=xxx — list rules for a collection
  app.get<{ Querystring: { collection?: string } }>(
    '/',
    { preHandler: authenticate },
    async (req, reply) => {
      const collection = req.query.collection
      const q = db('nivaro_field_rules').orderBy('sort', 'asc').orderBy('id', 'asc')
      if (collection) q.where({ collection })
      const rows = await q.select('*')
      return reply.send({ data: rows })
    }
  )

  // POST /field-rules — create rule (admin only)
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as FieldRuleBody

    if (!body.collection || body.trigger_field == null || body.target_field == null) {
      return reply
        .code(400)
        .send({ error: 'collection, trigger_field and target_field are required' })
    }

    const trigger_op = body.trigger_op ?? 'eq'
    if (!VALID_OPS.has(trigger_op)) {
      return reply.code(400).send({ error: `Invalid trigger_op "${trigger_op}"` })
    }

    const target_type = body.target_type ?? 'set'
    if (!VALID_TARGET_TYPES.has(target_type)) {
      return reply.code(400).send({ error: `Invalid target_type "${target_type}"` })
    }

    const insert = {
      collection: body.collection,
      trigger_field: body.trigger_field,
      trigger_op,
      trigger_value: body.trigger_value ?? null,
      target_field: body.target_field,
      target_type,
      target_value: target_type === 'clear' ? null : (body.target_value ?? null),
      sort: body.sort ?? 0,
      is_active: body.is_active ?? true,
      created_by: req.user?.id ?? null,
      created_at: new Date()
    }

    const rows = (await db('nivaro_field_rules').insert(insert).returning('id')) as unknown[]
    const idRow = rows[0] as { id: number } | number
    const id = typeof idRow === 'object' && idRow !== null ? (idRow as { id: number }).id : idRow

    const created = await db('nivaro_field_rules').where({ id }).first()
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_field_rules',
      item: String(id),
      req
    })
    return reply.code(201).send({ data: created })
  })

  // PATCH /field-rules/:id — update rule (admin only)
  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_field_rules').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = req.body as FieldRuleBody
      const patch: Record<string, unknown> = {}

      if (body.trigger_field != null) patch.trigger_field = body.trigger_field
      if (body.trigger_op != null) {
        if (!VALID_OPS.has(body.trigger_op)) {
          return reply.code(400).send({ error: `Invalid trigger_op "${body.trigger_op}"` })
        }
        patch.trigger_op = body.trigger_op
      }
      if ('trigger_value' in body) patch.trigger_value = body.trigger_value ?? null
      if (body.target_field != null) patch.target_field = body.target_field
      if (body.target_type != null) {
        if (!VALID_TARGET_TYPES.has(body.target_type)) {
          return reply.code(400).send({ error: `Invalid target_type "${body.target_type}"` })
        }
        patch.target_type = body.target_type
      }
      if ('target_value' in body) patch.target_value = body.target_value ?? null
      if (body.sort != null) patch.sort = body.sort
      if (body.is_active != null) patch.is_active = body.is_active

      // Clearing target type means no literal value is stored
      const effectiveType = (patch.target_type ?? existing.target_type) as string
      if (effectiveType === 'clear') patch.target_value = null

      if (Object.keys(patch).length > 0) {
        await db('nivaro_field_rules').where({ id }).update(patch)
      }

      const updated = await db('nivaro_field_rules').where({ id }).first()
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_field_rules',
        item: String(id),
        req
      })
      return reply.send({ data: updated })
    }
  )

  // DELETE /field-rules/:id — delete rule (admin only)
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_field_rules').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_field_rules').where({ id }).delete()
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_field_rules',
        item: String(id),
        req
      })
      return reply.code(204).send()
    }
  )

  // POST /field-rules/evaluate — evaluate rules for a payload without saving
  app.post('/evaluate', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      collection?: string
      data?: Record<string, unknown>
      changed_field?: string
    }

    if (!body.collection || !body.data || typeof body.data !== 'object') {
      return reply.code(400).send({ error: 'collection and data are required' })
    }

    const before = { ...body.data }
    const working = { ...body.data }
    await applyFieldRules(body.collection, working, body.changed_field)

    // Return only the fields that the rules actually changed.
    const updates: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(working)) {
      if (value !== before[key]) updates[key] = value
    }

    return reply.send({ updates })
  })
}

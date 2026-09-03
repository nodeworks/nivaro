import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  evaluateRowRules,
  evaluateRulesForTrigger,
  type RowRule,
  VALID_OPS,
  VALID_TARGET_TYPES,
  validateDynamicConfig
} from '../services/field-rules.js'
import { applyFieldRules } from '../services/items.js'
import { can } from '../services/permissions.js'

interface FieldRuleBody {
  collection?: string
  trigger_field?: string
  trigger_op?: string
  trigger_value?: string | null
  target_field?: string
  target_type?: string
  target_value?: string | null
  only_when_empty?: boolean
  dynamic_config?: string | Record<string, unknown> | null
  sort?: number
  is_active?: boolean
}

// dynamic_config may arrive as an object (admin UI) or a JSON string — always
// stored as text.
function normalizeDynamicConfig(v: FieldRuleBody['dynamic_config']): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

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

    const dynamicConfigError = validateDynamicConfig(target_type, body.dynamic_config)
    if (dynamicConfigError) {
      return reply.code(400).send({ error: dynamicConfigError })
    }

    const insert = {
      collection: body.collection,
      trigger_field: body.trigger_field,
      trigger_op,
      trigger_value: body.trigger_value ?? null,
      target_field: body.target_field,
      target_type,
      target_value: target_type === 'clear' ? null : (body.target_value ?? null),
      only_when_empty: body.only_when_empty ?? false,
      dynamic_config: normalizeDynamicConfig(body.dynamic_config),
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
      if (body.only_when_empty != null) patch.only_when_empty = body.only_when_empty
      if (body.sort != null) patch.sort = body.sort
      if (body.is_active != null) patch.is_active = body.is_active

      // Clearing target type means no literal value is stored
      const effectiveType = (patch.target_type ?? existing.target_type) as string
      if (effectiveType === 'clear') patch.target_value = null

      // Validate dynamic_config against the effective (patched or existing) target_type.
      // Required+shape-checked for set_lookup/set_from_trigger; forbidden (and cleared) otherwise.
      if (effectiveType === 'set_lookup' || effectiveType === 'set_from_trigger') {
        const effectiveDynamicConfig = 'dynamic_config' in body ? body.dynamic_config : existing.dynamic_config
        const dynamicConfigError = validateDynamicConfig(effectiveType, effectiveDynamicConfig)
        if (dynamicConfigError) {
          return reply.code(400).send({ error: dynamicConfigError })
        }
        if ('dynamic_config' in body) patch.dynamic_config = normalizeDynamicConfig(body.dynamic_config)
      } else {
        patch.dynamic_config = null
      }

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

  // POST /field-rules/evaluate — evaluate rules for a payload without saving.
  //
  // Two request shapes share this path: the legacy row_rules/data shape (below)
  // used by ItemEditForm's O2M/repeater row cascades, and the newer
  // trigger_field/trigger_value/draft shape used for dynamic (set_lookup /
  // set_from_trigger) cascading auto-fill against stored nivaro_field_rules.
  // The two never overlap on required keys, so dispatch is unambiguous.
  app.post('/evaluate', { preHandler: authenticate }, async (req, reply) => {
    const rawBody = req.body as Record<string, unknown>

    if ('trigger_field' in rawBody || 'draft' in rawBody) {
      const evalBody = rawBody as {
        collection?: string
        trigger_field?: string
        trigger_value?: unknown
        draft?: Record<string, unknown>
      }
      const { collection, trigger_field } = evalBody
      if (!collection || !trigger_field) {
        return reply.code(400).send({ error: 'collection and trigger_field are required' })
      }

      // Registry gate: collection must be a REGISTERED nivaro_collections entry —
      // never db(<caller-string>) against an unregistered table. Mirrors
      // collection-layouts.ts's /active gate (never getCollection's synthetic-
      // collection allowance, which leaves a real-table-without-registry-row hole).
      const registered = await db('nivaro_collections').where({ collection }).first()
      if (!registered) {
        return reply.code(400).send({ error: `Unknown collection "${collection}"` })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const draft = evalBody.draft ?? {}
      const data = await evaluateRulesForTrigger(
        db,
        collection,
        trigger_field,
        evalBody.trigger_value,
        draft,
        req.log
      )
      return reply.send({ data })
    }

    const body = req.body as {
      collection?: string
      data?: Record<string, unknown>
      changed_field?: string
      /** Evaluate only 'lock' rules (row editor open) — no value changes. */
      locks_only?: boolean
      parent_context?: Record<string, unknown>
      row_rules?: Array<{
        trigger_field?: string | null
        trigger_fields?: string[] | null
        trigger_related_field?: string | null
        trigger_op?: string
        trigger_value?: string | null
        target_field: string
        target_type: 'set' | 'clear' | 'relation_field' | 'precedence' | 'pick' | 'lock'
        target_value?: string | null
        sources?: Array<{ source_type: string; source_field: string; source_related_field: string; source_hop?: string; o2m_collection?: string; filter_field?: string; filter_value?: string; source_one_collection?: string }>
        only_if_empty?: boolean
        sort?: number
      }>
    }

    if (!body.collection || !body.data || typeof body.data !== 'object') {
      return reply.code(400).send({ error: 'collection and data are required' })
    }

    const before = { ...body.data }
    const working = { ...body.data }
    const parentContext = body.parent_context ?? {}
    const locks = new Set<string>()

    if (Array.isArray(body.row_rules) && body.row_rules.length > 0) {
      // The full evaluator lives in services/field-rules.ts now — createOne
      // runs the same rules for direct API child-row creates, so the logic
      // must not fork between the live-edit path and the write path.
      await evaluateRowRules(
        db,
        body.collection,
        working,
        parentContext,
        body.row_rules as RowRule[],
        body.changed_field,
        { locks, locksOnly: body.locks_only === true }
      )
    } else {
      await applyFieldRules(body.collection, working, body.changed_field)
    }

    // Return only the fields that the rules actually changed.
    const updates: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(working)) {
      if (value !== before[key]) updates[key] = value
    }

    return reply.send({ updates, locks: [...locks] })
  })
}

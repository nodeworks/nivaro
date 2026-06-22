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
      parent_context?: Record<string, unknown>
      row_rules?: Array<{
        trigger_field?: string | null
        trigger_fields?: string[] | null
        trigger_related_field?: string | null
        trigger_op?: string
        trigger_value?: string | null
        target_field: string
        target_type: 'set' | 'clear' | 'relation_field' | 'precedence'
        target_value?: string | null
        sources?: Array<{ source_type: string; source_field: string; source_related_field: string }>
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

    if (Array.isArray(body.row_rules) && body.row_rules.length > 0) {
      const sorted = [...body.row_rules].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      for (const rule of sorted) {
        const triggerField = rule.trigger_field ?? null
        const isParentTrigger = !!triggerField && triggerField.startsWith('$parent.')
        const extraTriggerFields = Array.isArray(rule.trigger_fields) ? rule.trigger_fields.filter(Boolean) : []
        const allTriggerFields = triggerField ? [triggerField, ...extraTriggerFields] : extraTriggerFields

        if (!isParentTrigger) {
          if (body.changed_field && allTriggerFields.length > 0 && !allTriggerFields.includes(body.changed_field)) continue
          if (triggerField && !(triggerField in working)) continue
        }

        let val: unknown
        if (isParentTrigger) {
          const parentKey = triggerField!.slice(8) // strip '$parent.'
          val = parentContext[parentKey] ?? null
        } else {
          // val = the field that actually changed (for OR triggers), falling back to trigger_field
          const activeField = (body.changed_field && allTriggerFields.includes(body.changed_field))
            ? body.changed_field
            : triggerField
          val = activeField ? working[activeField] : null
        }

        // When trigger_related_field is set, resolve the M2O related record and compare that field.
        // Supports dot-path (e.g. "category_type.type") for multi-hop traversal.
        if (rule.trigger_related_field && triggerField && val != null) {
          try {
            const trigRel = await db('nivaro_relations')
              .where({ many_collection: body.collection, many_field: triggerField })
              .whereNull('junction_field')
              .first() as { one_collection: string } | undefined
            if (trigRel?.one_collection) {
              let currentRecord = await db(trigRel.one_collection)
                .where({ id: String(val) })
                .first() as Record<string, unknown> | undefined
              let currentCollection = trigRel.one_collection
              let lastFkId: string | null = String(val)
              const parts = rule.trigger_related_field.split('.')
              for (let i = 0; i < parts.length - 1; i++) {
                const hop = parts[i]
                const fkId = currentRecord?.[hop]
                if (fkId == null) { currentRecord = undefined; lastFkId = null; break }
                lastFkId = String(fkId)
                const hopRel = await db('nivaro_relations')
                  .where({ many_collection: currentCollection, many_field: hop })
                  .whereNull('junction_field')
                  .first() as { one_collection: string } | undefined
                if (!hopRel?.one_collection) { currentRecord = undefined; lastFkId = null; break }
                currentRecord = await db(hopRel.one_collection)
                  .where({ id: String(fkId) })
                  .first() as Record<string, unknown> | undefined
                currentCollection = hopRel.one_collection
              }
              const lastPart = parts[parts.length - 1]
              val = (lastPart === '__id__' || lastPart === '__entity__')
                ? lastFkId
                : (currentRecord?.[lastPart] ?? null)
            } else {
              val = null
            }
          } catch {
            val = null
          }
        }

        const op = rule.trigger_op ?? 'nnull'
        const rawTriggerValue = rule.trigger_value?.replace(/\$parent\.(\w+)/g, (_, f) => {
          const v = parentContext[f]; return v != null ? String(v) : ''
        }) ?? null

        let triggered = false
        switch (op) {
          case 'eq': triggered = String(val) === String(rawTriggerValue ?? ''); break
          case 'neq': triggered = String(val) !== String(rawTriggerValue ?? ''); break
          case 'null': triggered = val == null; break
          case 'nnull': triggered = val != null; break
          case 'in': {
            let list: string[]
            try {
              const parsed = JSON.parse(rawTriggerValue ?? '[]')
              list = Array.isArray(parsed) ? parsed.map(String) : []
            } catch {
              list = (rawTriggerValue ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
            }
            triggered = list.includes(String(val)); break
          }
          case 'contains': triggered = String(val).includes(String(rawTriggerValue ?? '')); break
          default: triggered = triggerField ? val != null : true
        }
        if (!triggered) continue

        if (rule.only_if_empty) {
          const existing = working[rule.target_field]
          if (existing != null && existing !== '') continue
        }

        if (rule.target_type === 'clear') {
          working[rule.target_field] = null
        } else if (rule.target_type === 'set') {
          const rv = rule.target_value?.replace(/\$parent\.(\w+)/g, (_, f) => {
            const v = parentContext[f]; return v != null ? String(v) : ''
          }) ?? null
          if (rv !== null) working[rule.target_field] = rv
        } else if (rule.target_type === 'relation_field') {
          const fkId = triggerField ? working[triggerField] : null
          if (fkId == null) { working[rule.target_field] = null; continue }
          try {
            const rel = await db('nivaro_relations')
              .where({ many_collection: body.collection, many_field: triggerField })
              .whereNull('junction_field')
              .first() as { one_collection: string } | undefined
            if (!rel?.one_collection) continue
            const relatedRecord = await db(rel.one_collection)
              .where({ id: String(fkId) })
              .first() as Record<string, unknown> | undefined
            working[rule.target_field] = relatedRecord && rule.target_value
              ? (relatedRecord[rule.target_value] ?? null)
              : null
          } catch { /* non-fatal */ }
        } else if (rule.target_type === 'precedence' && Array.isArray(rule.sources)) {
          let resolved: unknown = null
          for (const src of rule.sources) {
            if (!src.source_field || !src.source_related_field) continue
            try {
              if (src.source_type === 'relation_field') {
                const fkId = working[src.source_field]
                if (fkId == null) continue
                const rel = await db('nivaro_relations')
                  .where({ many_collection: body.collection, many_field: src.source_field })
                  .whereNull('junction_field')
                  .first() as { one_collection: string } | undefined
                if (!rel?.one_collection) continue
                const relRec = await db(rel.one_collection)
                  .where({ id: String(fkId) })
                  .first() as Record<string, unknown> | undefined
                const candidate = relRec?.[src.source_related_field] ?? null
                if (candidate != null) { resolved = candidate; break }
              } else if (src.source_type === 'o2m_first') {
                const rowId = working.id
                if (rowId == null) continue
                const rel = await db('nivaro_relations')
                  .where({ one_collection: body.collection, one_field: src.source_field })
                  .whereNull('junction_field')
                  .first() as { many_collection: string; many_field: string } | undefined
                if (!rel?.many_collection) continue
                const firstRec = await db(rel.many_collection)
                  .where({ [rel.many_field]: String(rowId) })
                  .orderBy('id', 'asc')
                  .first() as Record<string, unknown> | undefined
                const candidate = firstRec?.[src.source_related_field] ?? null
                if (candidate != null) { resolved = candidate; break }
              }
            } catch { continue }
          }
          working[rule.target_field] = resolved
        }
      }
    } else {
      await applyFieldRules(body.collection, working, body.changed_field)
    }

    // Return only the fields that the rules actually changed.
    const updates: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(working)) {
      if (value !== before[key]) updates[key] = value
    }

    return reply.send({ updates })
  })
}

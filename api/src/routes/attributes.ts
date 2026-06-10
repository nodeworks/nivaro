import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

const ATTR_TYPES = new Set(['text', 'number', 'boolean', 'date', 'select'])
const KEY_RE = /^[a-z][a-z0-9_]{0,254}$/

function parseOptions(raw: unknown): string[] | null {
  if (raw == null) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(parsed)) return parsed.map((v) => String(v))
    return null
  } catch {
    return null
  }
}

export async function attributesRoutes(app: FastifyInstance) {
  // ── Attribute Definitions (admin only) ─────────────────────────────────────

  app.get<{ Querystring: { collection?: string } }>(
    '/attribute-definitions',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection } = req.query
      const q = db('nivaro_attribute_definitions').orderBy('sort').orderBy('id')
      if (collection) q.where({ collection })
      const rows = await q.select('*')
      const data = rows.map((d: Record<string, unknown>) => ({
        ...d,
        options: parseOptions(d.options)
      }))
      return reply.send({ data })
    }
  )

  app.post('/attribute-definitions', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      collection?: string
      key?: string
      label?: string
      type?: string
      options?: unknown
      required?: boolean
      sort?: number
      is_active?: boolean
    }

    const collection = String(body.collection ?? '').trim()
    const key = String(body.key ?? '').trim()
    const label = String(body.label ?? '').trim()
    const type = String(body.type ?? 'text').trim()

    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    if (!KEY_RE.test(key))
      return reply.code(400).send({
        error: 'key must be a slug: lowercase letter followed by letters, digits or underscores'
      })
    if (!label) return reply.code(400).send({ error: 'label is required' })
    if (!ATTR_TYPES.has(type)) return reply.code(400).send({ error: `invalid type "${type}"` })

    const options = parseOptions(body.options)

    const existing = await db('nivaro_attribute_definitions').where({ collection, key }).first()
    if (existing)
      return reply
        .code(409)
        .send({ error: `An attribute with key "${key}" already exists for "${collection}"` })

    await db('nivaro_attribute_definitions').insert({
      collection,
      key,
      label,
      type,
      options: options ? JSON.stringify(options) : null,
      required: body.required ?? false,
      sort: body.sort ?? 0,
      is_active: body.is_active ?? true,
      created_by: req.user?.id ?? null,
      created_at: new Date()
    })

    const created = await db('nivaro_attribute_definitions')
      .where({ collection, key })
      .first<Record<string, unknown>>()
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_attribute_definitions',
      item: created ? String(created.id) : undefined,
      req
    })
    return reply
      .code(201)
      .send({ data: created ? { ...created, options: parseOptions(created.options) } : null })
  })

  app.patch<{ Params: { id: string } }>(
    '/attribute-definitions/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_attribute_definitions').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = req.body as Partial<{
        label: string
        type: string
        options: unknown
        required: boolean
        sort: number
        is_active: boolean
      }>

      const patch: Record<string, unknown> = {}
      if (body.label != null) {
        const label = String(body.label).trim()
        if (!label) return reply.code(400).send({ error: 'label cannot be empty' })
        patch.label = label
      }
      if (body.type != null) {
        if (!ATTR_TYPES.has(body.type))
          return reply.code(400).send({ error: `invalid type "${body.type}"` })
        patch.type = body.type
      }
      if ('options' in body) {
        const options = parseOptions(body.options)
        patch.options = options ? JSON.stringify(options) : null
      }
      if (body.required != null) patch.required = body.required
      if (body.sort != null) patch.sort = body.sort
      if (body.is_active != null) patch.is_active = body.is_active

      if (Object.keys(patch).length > 0) {
        await db('nivaro_attribute_definitions').where({ id }).update(patch)
      }

      const updated = await db('nivaro_attribute_definitions')
        .where({ id })
        .first<Record<string, unknown>>()
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_attribute_definitions',
        item: String(id),
        req
      })
      return reply.send({
        data: updated ? { ...updated, options: parseOptions(updated.options) } : null
      })
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/attribute-definitions/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_attribute_definitions').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      // Clean up orphaned values for this collection+key
      await db('nivaro_attribute_values')
        .where({ collection: existing.collection, attribute_key: existing.key })
        .delete()
      await db('nivaro_attribute_definitions').where({ id }).delete()
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_attribute_definitions',
        item: String(id),
        req
      })
      return reply.code(204).send()
    }
  )

  // ── Attribute Values (authenticated) ───────────────────────────────────────

  app.get<{ Params: { collection: string; itemId: string } }>(
    '/attributes/:collection/:itemId',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, itemId } = req.params
      if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const defs = await db('nivaro_attribute_definitions')
        .where({ collection, is_active: true })
        .orderBy('sort')
        .orderBy('id')
        .select('*')
      const vals = await db('nivaro_attribute_values')
        .where({ collection, item_id: String(itemId) })
        .select('attribute_key', 'value')
      const valMap = new Map(vals.map((v: Record<string, unknown>) => [v.attribute_key, v.value]))
      const result = defs.map((d: Record<string, unknown>) => ({
        ...d,
        options: parseOptions(d.options),
        value: valMap.get(d.key) ?? null
      }))
      return reply.send({ data: result })
    }
  )

  app.patch<{ Params: { collection: string; itemId: string } }>(
    '/attributes/:collection/:itemId',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, itemId } = req.params
      if (!req.isAdmin && !(await can(req.user!, 'update', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const body = (req.body ?? {}) as Record<string, unknown>

      // Only allow keys that have an active definition for this collection
      const defs = await db('nivaro_attribute_definitions')
        .where({ collection, is_active: true })
        .select('key')
      const allowed = new Set(defs.map((d: Record<string, unknown>) => String(d.key)))

      for (const [key, value] of Object.entries(body)) {
        if (!allowed.has(key)) continue
        const strValue = value != null ? String(value) : null
        const existing = await db('nivaro_attribute_values')
          .where({ collection, item_id: String(itemId), attribute_key: key })
          .first()
        if (existing) {
          await db('nivaro_attribute_values')
            .where({ collection, item_id: String(itemId), attribute_key: key })
            .update({ value: strValue, updated_at: new Date() })
        } else {
          await db('nivaro_attribute_values').insert({
            collection,
            item_id: String(itemId),
            attribute_key: key,
            value: strValue,
            updated_at: new Date()
          })
        }
      }
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection,
        item: String(itemId),
        comment: 'attributes',
        req
      })
      return reply.send({ success: true })
    }
  )
}

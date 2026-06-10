import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

function formatTemplate(row: Record<string, unknown>) {
  return {
    ...row,
    data: parseJsonSafe(row.data),
    is_shared: !!row.is_shared
  }
}

export async function recordTemplatesRoutes(app: FastifyInstance) {
  // GET /record-templates?collection= — list templates across collections (own + shared + role-scoped)
  app.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    const userId = req.user!.id
    const userRole = req.user!.role

    const query = db('nivaro_record_templates')
      .where(function () {
        this.where({ created_by: userId }).orWhere({ is_shared: 1 }).orWhere({ role_id: null })
        if (userRole) {
          this.orWhere({ role_id: userRole })
        }
      })
      .orderBy('created_at', 'desc')

    if (collection) query.where({ collection })

    const rows = (await query) as Record<string, unknown>[]
    return reply.send({ data: rows.map(formatTemplate) })
  })

  // GET /record-templates/:collection — list templates for collection (own + shared + role-scoped)
  app.get('/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const userId = req.user!.id
    const userRole = req.user!.role

    const rows = (await db('nivaro_record_templates')
      .where({ collection })
      .where(function () {
        this.where({ created_by: userId }).orWhere({ is_shared: 1 }).orWhere({ role_id: null })
        if (userRole) {
          this.orWhere({ role_id: userRole })
        }
      })
      .orderBy('created_at', 'desc')) as Record<string, unknown>[]

    return reply.send({ data: rows.map(formatTemplate) })
  })

  // POST /record-templates — create a template
  app.post('/', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      collection: string
      name: string
      description?: string
      data: Record<string, unknown>
      role_id?: string | null
      is_shared?: boolean
    }

    if (!body.collection || !body.name || !body.data) {
      return reply.code(400).send({ error: 'collection, name, and data are required' })
    }

    const now = new Date()
    const [row] = await db('nivaro_record_templates')
      .insert({
        collection: body.collection,
        name: body.name,
        description: body.description ?? null,
        data: JSON.stringify(body.data),
        role_id: body.role_id ?? null,
        is_shared: body.is_shared ? 1 : 0,
        created_by: req.user!.id,
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = (await db('nivaro_record_templates')
      .where({ id: insertedId })
      .first()) as Record<string, unknown>

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_record_templates',
      item: String(insertedId),
      req
    })

    return reply.code(201).send({ data: formatTemplate(created) })
  })

  // PATCH /record-templates/:id — update (own or admin)
  app.patch('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_record_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = req.body as Partial<{
      name: string
      description: string | null
      data: Record<string, unknown>
      role_id: string | null
      is_shared: boolean
    }>

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) patch.name = body.name
    if ('description' in body) patch.description = body.description ?? null
    if (body.data !== undefined) patch.data = JSON.stringify(body.data)
    if ('role_id' in body) patch.role_id = body.role_id ?? null
    if (body.is_shared !== undefined) patch.is_shared = body.is_shared ? 1 : 0

    await db('nivaro_record_templates').where({ id }).update(patch)
    const updated = (await db('nivaro_record_templates').where({ id }).first()) as Record<
      string,
      unknown
    >

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_record_templates',
      item: id,
      req
    })

    return reply.send({ data: formatTemplate(updated) })
  })

  // DELETE /record-templates/:id — delete (own or admin)
  app.delete('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const existing = (await db('nivaro_record_templates').where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && existing.created_by !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_record_templates').where({ id }).delete()

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_record_templates',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // POST /record-templates/:id/apply — return template data for merging into form state
  app.post('/:id/apply', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.user!.id
    const userRole = req.user!.role

    const template = (await db('nivaro_record_templates')
      .where({ id })
      .where(function () {
        this.where({ created_by: userId }).orWhere({ is_shared: 1 }).orWhere({ role_id: null })
        if (userRole) {
          this.orWhere({ role_id: userRole })
        }
      })
      .first()) as Record<string, unknown> | undefined
    if (!template) return reply.code(404).send({ error: 'Not found' })

    const data = parseJsonSafe(template.data)
    return reply.send({ data })
  })
}

import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

interface PresetRow {
  id: string
  collection: string
  name: string
  user_id: string | null
  columns: string
  is_default: boolean
  created_at: Date
}

function parsePreset(row: PresetRow) {
  return {
    id: row.id,
    collection: row.collection,
    name: row.name,
    user_id: row.user_id,
    columns: JSON.parse(row.columns) as string[],
    is_default: Boolean(row.is_default),
    created_at: row.created_at
  }
}

export async function presetsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET /presets?collection=X
  app.get<{ Querystring: { collection?: string } }>('/', async (req, reply) => {
    const { collection } = req.query
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    const userId = req.user!.id

    const systemDefault = (await db('nivaro_collection_presets')
      .where({ collection })
      .where('is_default', true)
      .whereNull('user_id')
      .first()) as PresetRow | undefined

    const userPresets = (await db('nivaro_collection_presets')
      .where({ collection, user_id: userId })
      .orderBy('created_at', 'asc')) as PresetRow[]

    const activePreset = userPresets.find((p) => p.is_default)

    return {
      data: {
        systemDefault: systemDefault ? parsePreset(systemDefault) : null,
        presets: userPresets.map(parsePreset),
        activePresetId: activePreset?.id ?? null
      }
    }
  })

  // POST /presets — create user preset
  app.post<{ Body: { collection: string; name: string; columns: string[] } }>(
    '/',
    async (req, reply) => {
      const { collection, name, columns } = req.body ?? {}
      if (!collection || !name || !Array.isArray(columns)) {
        return reply.code(400).send({ error: 'collection, name, and columns are required' })
      }

      const id = randomUUID()
      await db('nivaro_collection_presets').insert({
        id,
        collection,
        name,
        user_id: req.user!.id,
        columns: JSON.stringify(columns),
        is_default: false,
        created_at: new Date()
      })

      const row = (await db('nivaro_collection_presets').where({ id }).first()) as PresetRow
      await logActivity({
        action: 'create',
        user: req.user?.id,
        collection: 'nivaro_collection_presets',
        item: id,
        req
      })
      return reply.code(201).send({ data: parsePreset(row) })
    }
  )

  // PUT /presets/system-default — admin only; registered before /:id to avoid param collision
  app.put<{ Body: { collection: string; columns: string[] } }>(
    '/system-default',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection, columns } = req.body ?? {}
      if (!collection || !Array.isArray(columns)) {
        return reply.code(400).send({ error: 'collection and columns are required' })
      }

      const existing = (await db('nivaro_collection_presets')
        .where({ collection })
        .where('is_default', true)
        .whereNull('user_id')
        .first()) as PresetRow | undefined

      if (existing) {
        await db('nivaro_collection_presets')
          .where({ id: existing.id })
          .update({ columns: JSON.stringify(columns) })
        const row = (await db('nivaro_collection_presets')
          .where({ id: existing.id })
          .first()) as PresetRow
        return { data: parsePreset(row) }
      }

      const id = randomUUID()
      await db('nivaro_collection_presets').insert({
        id,
        collection,
        name: 'Default',
        user_id: null,
        columns: JSON.stringify(columns),
        is_default: true,
        created_at: new Date()
      })

      const row = (await db('nivaro_collection_presets').where({ id }).first()) as PresetRow
      return reply.code(201).send({ data: parsePreset(row) })
    }
  )

  // DELETE /presets/active?collection=X — clear user's active preset (static before /:id)
  app.delete<{ Querystring: { collection?: string } }>('/active', async (req, reply) => {
    const { collection } = req.query
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    await db('nivaro_collection_presets')
      .where({ collection, user_id: req.user!.id })
      .where('is_default', true)
      .update({ is_default: false })

    return reply.code(204).send()
  })

  // POST /presets/:id/activate — set as user's active preset
  app.post<{ Params: { id: string } }>('/:id/activate', async (req, reply) => {
    const { id } = req.params
    const preset = (await db('nivaro_collection_presets').where({ id }).first()) as
      | PresetRow
      | undefined
    if (!preset) return reply.code(404).send({ error: 'Not found' })

    if (preset.user_id !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_collection_presets')
      .where({ collection: preset.collection, user_id: req.user!.id })
      .where('is_default', true)
      .update({ is_default: false })

    await db('nivaro_collection_presets').where({ id }).update({ is_default: true })

    return { data: { success: true } }
  })

  // PATCH /presets/:id — update name or columns
  app.patch<{ Params: { id: string }; Body: { name?: string; columns?: string[] } }>(
    '/:id',
    async (req, reply) => {
      const { id } = req.params
      const existing = (await db('nivaro_collection_presets').where({ id }).first()) as
        | PresetRow
        | undefined
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      if (existing.user_id === null) {
        if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
      } else if (existing.user_id !== req.user!.id && !req.isAdmin) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = {}
      if (req.body?.name !== undefined) updates.name = req.body.name
      if (req.body?.columns !== undefined) updates.columns = JSON.stringify(req.body.columns)

      if (Object.keys(updates).length > 0) {
        await db('nivaro_collection_presets').where({ id }).update(updates)
      }

      const row = (await db('nivaro_collection_presets').where({ id }).first()) as PresetRow
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_collection_presets',
        item: id,
        req
      })
      return { data: parsePreset(row) }
    }
  )

  // DELETE /presets/:id
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { id } = req.params
    const existing = (await db('nivaro_collection_presets').where({ id }).first()) as
      | PresetRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    if (existing.user_id === null) {
      if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    } else if (existing.user_id !== req.user!.id && !req.isAdmin) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_collection_presets').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_collection_presets',
      item: id,
      req
    })
    return reply.code(204).send()
  })
}

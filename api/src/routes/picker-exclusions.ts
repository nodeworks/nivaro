import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

export async function pickerExclusionRoutes(app: FastifyInstance) {
  // GET status for a single item
  app.get<{ Params: { collection: string; itemId: string } }>(
    '/status/:collection/:itemId',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, itemId } = req.params
      const row = await db('nivaro_picker_exclusions')
        .where({ collection, item_id: String(itemId) })
        .first()
      return reply.send({ data: { excluded: !!row } })
    }
  )

  // POST — exclude a record
  app.post<{ Body: { collection: string; item_id: string } }>(
    '/',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection, item_id } = req.body ?? {}
      if (!collection || !item_id) return reply.code(400).send({ error: 'collection and item_id required' })
      const existing = await db('nivaro_picker_exclusions').where({ collection, item_id: String(item_id) }).first()
      if (!existing) {
        await db('nivaro_picker_exclusions').insert({
          collection,
          item_id: String(item_id),
          created_by: req.user?.id ?? null,
        })
      }
      await logActivity({ action: 'picker-exclude', collection, item: String(item_id), user: req.user?.id ?? null })
      return reply.send({ data: { excluded: true } })
    }
  )

  // DELETE — remove exclusion
  app.delete<{ Body: { collection: string; item_id: string } }>(
    '/',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection, item_id } = req.body ?? {}
      if (!collection || !item_id) return reply.code(400).send({ error: 'collection and item_id required' })
      await db('nivaro_picker_exclusions').where({ collection, item_id: String(item_id) }).delete()
      await logActivity({ action: 'picker-include', collection, item: String(item_id), user: req.user?.id ?? null })
      return reply.send({ data: { excluded: false } })
    }
  )

  // POST batch-status — check multiple items at once
  app.post<{ Body: { collection: string; ids: string[] } }>(
    '/batch-status',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, ids } = req.body ?? {}
      if (!collection || !Array.isArray(ids)) return reply.code(400).send({ error: 'collection and ids required' })
      if (ids.length === 0) return reply.send({ data: { excluded: [] } })
      const rows = await db('nivaro_picker_exclusions')
        .where({ collection })
        .whereIn('item_id', ids.map(String))
        .select('item_id') as Array<{ item_id: string }>
      return reply.send({ data: { excluded: rows.map(r => r.item_id) } })
    }
  )

  // POST bulk — exclude or include multiple records
  app.post<{ Body: { collection: string; ids: string[]; exclude: boolean } }>(
    '/bulk',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection, ids, exclude } = req.body ?? {}
      if (!collection || !Array.isArray(ids)) return reply.code(400).send({ error: 'collection and ids required' })
      if (ids.length === 0) return reply.send({ data: { success: true, count: 0 } })
      if (exclude) {
        for (const id of ids) {
          const exists = await db('nivaro_picker_exclusions').where({ collection, item_id: String(id) }).first()
          if (!exists) {
            await db('nivaro_picker_exclusions').insert({ collection, item_id: String(id), created_by: req.user?.id ?? null })
          }
        }
      } else {
        await db('nivaro_picker_exclusions').where({ collection }).whereIn('item_id', ids.map(String)).delete()
      }
      await logActivity({
        action: exclude ? 'picker-exclude-bulk' : 'picker-include-bulk',
        collection,
        item: ids.join(','),
        user: req.user?.id ?? null,
      })
      return reply.send({ data: { success: true, count: ids.length } })
    }
  )
}

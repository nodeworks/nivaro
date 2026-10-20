import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { readOne } from '../services/items.js'
import { can } from '../services/permissions.js'
import { isSystemCollection } from '../services/system-collections.js'
import { resolveLayout } from './collection-layouts.js'

/**
 * Who may switch one record in or out of pickers: administrators, and anyone
 * whose form for this record turns on "Disable in pickers" for all users
 * (layout allow_disable_pickers) — provided they may update the collection
 * and can see the record. The layout is resolved exactly as /active resolves
 * it for that person (`layout` = the ?layout= link name the page opened with).
 * Null = allowed; otherwise the refusal to send.
 */
export async function pickerToggleRefusal(
  req: Pick<FastifyRequest, 'user' | 'isAdmin'>,
  collection: string,
  itemId: string,
  layout?: string | null
): Promise<{ status: number; error: string } | null> {
  if (req.isAdmin) return null
  const user = req.user
  if (!user) return { status: 401, error: 'Unauthorized' }
  const denied = { status: 403, error: 'Only administrators can change picker visibility here' }
  if (isSystemCollection(collection)) return denied
  if (!(await can(user, 'update', collection))) return denied
  const { row } = await resolveLayout({
    collection,
    slug: layout ?? null,
    item: itemId,
    role: user.role ?? null,
    isAdmin: false
  })
  if (!row?.allow_disable_pickers) return denied
  // readOne answers null (or throws) for a record the caller can't see.
  const visible = await readOne(user, collection, itemId).catch(() => null)
  if (!visible) return { status: 404, error: 'Not found' }
  return null
}

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
  app.post<{ Body: { collection: string; item_id: string; layout?: string | null } }>(
    '/',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, item_id, layout } = req.body ?? {}
      if (!collection || !item_id)
        return reply.code(400).send({ error: 'collection and item_id required' })
      const refusal = await pickerToggleRefusal(req, collection, String(item_id), layout)
      if (refusal) return reply.code(refusal.status).send({ error: refusal.error })
      const existing = await db('nivaro_picker_exclusions')
        .where({ collection, item_id: String(item_id) })
        .first()
      if (!existing) {
        await db('nivaro_picker_exclusions').insert({
          collection,
          item_id: String(item_id),
          created_by: req.user?.id ?? null
        })
      }
      await logActivity({
        action: 'picker-exclude',
        collection,
        item: String(item_id),
        user: req.user?.id ?? null
      })
      return reply.send({ data: { excluded: true } })
    }
  )

  // DELETE — remove exclusion
  app.delete<{ Body: { collection: string; item_id: string; layout?: string | null } }>(
    '/',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, item_id, layout } = req.body ?? {}
      if (!collection || !item_id)
        return reply.code(400).send({ error: 'collection and item_id required' })
      const refusal = await pickerToggleRefusal(req, collection, String(item_id), layout)
      if (refusal) return reply.code(refusal.status).send({ error: refusal.error })
      await db('nivaro_picker_exclusions')
        .where({ collection, item_id: String(item_id) })
        .delete()
      await logActivity({
        action: 'picker-include',
        collection,
        item: String(item_id),
        user: req.user?.id ?? null
      })
      return reply.send({ data: { excluded: false } })
    }
  )

  // POST batch-status — check multiple items at once
  app.post<{ Body: { collection: string; ids: string[] } }>(
    '/batch-status',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, ids } = req.body ?? {}
      if (!collection || !Array.isArray(ids))
        return reply.code(400).send({ error: 'collection and ids required' })
      if (ids.length === 0) return reply.send({ data: { excluded: [] } })
      const rows = (await db('nivaro_picker_exclusions')
        .where({ collection })
        .whereIn('item_id', ids.map(String))
        .select('item_id')) as Array<{ item_id: string }>
      return reply.send({ data: { excluded: rows.map((r) => r.item_id) } })
    }
  )

  // POST bulk — exclude or include multiple records
  app.post<{ Body: { collection: string; ids: string[]; exclude: boolean } }>(
    '/bulk',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection, ids, exclude } = req.body ?? {}
      if (!collection || !Array.isArray(ids))
        return reply.code(400).send({ error: 'collection and ids required' })
      if (ids.length === 0) return reply.send({ data: { success: true, count: 0 } })
      if (exclude) {
        for (const id of ids) {
          const exists = await db('nivaro_picker_exclusions')
            .where({ collection, item_id: String(id) })
            .first()
          if (!exists) {
            await db('nivaro_picker_exclusions').insert({
              collection,
              item_id: String(id),
              created_by: req.user?.id ?? null
            })
          }
        }
      } else {
        await db('nivaro_picker_exclusions')
          .where({ collection })
          .whereIn('item_id', ids.map(String))
          .delete()
      }
      await logActivity({
        action: exclude ? 'picker-exclude-bulk' : 'picker-include-bulk',
        collection,
        item: ids.join(','),
        user: req.user?.id ?? null
      })
      return reply.send({ data: { success: true, count: ids.length } })
    }
  )
}

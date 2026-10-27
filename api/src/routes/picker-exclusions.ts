import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { selectInChunks } from '../services/db-batch.js'
import { compileAccessGates, visibleIds } from '../services/record-access.js'
import { type RecordToolRequest, recordToolRefusal } from '../services/record-tool-gate.js'
import { recordVisibleTo } from '../services/revision-access.js'

/**
 * Who may switch one record in or out of pickers: administrators, and anyone
 * whose form for this record turns on "Disable in pickers" for all users
 * (layout allow_disable_pickers) and who may update this record — see
 * recordToolRefusal. A ?layout= pin (`layout`) only counts when it is a form
 * the person could legitimately be on for this record.
 * Null = allowed; otherwise the refusal to send.
 */
export function pickerToggleRefusal(
  req: RecordToolRequest,
  collection: string,
  itemId: string,
  layout?: string | null
): Promise<{ status: number; error: string } | null> {
  return recordToolRefusal(req, collection, itemId, 'allow_disable_pickers', {
    layout,
    denied: 'Only administrators can change picker visibility here'
  })
}

/** Most ids one batch-status call checks. */
export const BATCH_STATUS_MAX = 5000

export async function pickerExclusionRoutes(app: FastifyInstance) {
  // GET status for a single item
  app.get<{ Params: { collection: string; itemId: string } }>(
    '/status/:collection/:itemId',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, itemId } = req.params
      // A record the caller cannot open has no picker status as far as they know.
      if (!(await recordVisibleTo(req, collection, String(itemId)))) {
        return reply.code(404).send({ error: 'Not found' })
      }
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
      const asked = [...new Set(ids.map(String))]
      if (asked.length > BATCH_STATUS_MAX) {
        return reply.code(400).send({ error: `At most ${BATCH_STATUS_MAX} ids per request` })
      }
      // Only ids the caller can see answer (role policy, row filter, User Scopes).
      let unique = asked
      if (!req.isAdmin) {
        if (/^(nivaro_|directus_)/i.test(String(collection))) {
          return reply.send({ data: { excluded: [] } })
        }
        const gates = await compileAccessGates(req.user!, String(collection))
        const seen = await visibleIds(gates, asked)
        unique = asked.filter((i) => seen.has(i))
        if (unique.length === 0) return reply.send({ data: { excluded: [] } })
      }
      // SQL Server takes ~2100 bound parameters per statement.
      const rows = await selectInChunks(
        unique,
        1000,
        (chunk) =>
          db('nivaro_picker_exclusions')
            .where({ collection })
            .whereIn('item_id', chunk)
            .select('item_id') as Promise<Array<{ item_id: string }>>
      )
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

import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { selectInChunks } from '../services/db-batch.js'
import { readLinkedChange } from '../services/linked-change.js'
import { compileAccessGates, visibleIds } from '../services/record-access.js'
import { announceRecordAspect } from '../services/record-events.js'
import { type RecordToolRequest, recordToolRefusal } from '../services/record-tool-gate.js'
import { recordVisibleTo } from '../services/revision-access.js'

/**
 * Who may switch one record in or out of pickers: administrators, and anyone
 * whose form for this record turns on "Hide from pickers" for all users
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
      // rt4 #6 — open forms that link to this record re-check their picker (ids only).
      announceRecordAspect(collection, String(item_id), '$picker')
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
      announceRecordAspect(collection, String(item_id), '$picker')
      return reply.send({ data: { excluded: false } })
    }
  )

  // rt4 #6 — the last change to a record other forms link to: who, when and which fields
  // (yes/no and choice values only), for the line under a picker whose value just stopped
  // being offered. Only for a record the caller can open; only fields they may read.
  app.get<{ Querystring: { collection?: string; item_id?: string; since?: string } }>(
    '/linked-change',
    { preHandler: authenticate },
    async (req, reply) => {
      const collection = String(req.query.collection ?? '').trim()
      const itemId = String(req.query.item_id ?? '').trim()
      if (!collection || !itemId)
        return reply.code(400).send({ error: 'collection and item_id required' })
      if (!(await recordVisibleTo(req, collection, itemId))) {
        return reply.code(404).send({ error: 'Not found' })
      }
      const since = req.query.since ? new Date(String(req.query.since)) : new Date(0)
      const change = await readLinkedChange(
        req.user!,
        req.isAdmin === true,
        collection,
        itemId,
        Number.isNaN(since.getTime()) ? new Date(0) : since
      )
      return reply.send({ data: change })
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
        // GUID keys come back in the database's spelling (upper case) — compare case-blind.
        const seenUpper = new Set([...seen].map((i) => String(i).toUpperCase()))
        unique = asked.filter((i) => seenUpper.has(i.toUpperCase()))
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
      // Forms linking to any of them re-check; a long list says "many" once.
      if (ids.length <= 50)
        for (const id of ids) announceRecordAspect(collection, String(id), '$picker')
      else announceRecordAspect(collection, '*', '$picker')
      return reply.send({ data: { success: true, count: ids.length } })
    }
  )
}

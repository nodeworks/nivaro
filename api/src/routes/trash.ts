import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { restoreTrashRow, type TrashRow } from '../services/trash.js'

/**
 * Trash bin.
 *  GET    /trash              — list (admin: everything; others: own deletions); ?collection= filter
 *  POST   /trash/:id/restore  — re-insert with original id (create permission required)
 *  DELETE /trash/:id          — permanent purge (admin, or owner of the deletion)
 */

function rowLabel(data: Record<string, unknown>): string {
  return String(
    data.title ?? data.name ?? data.label ?? data.subject ?? `#${String(data.id)}`
  ).slice(0, 120)
}

export async function trashRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      collection?: string
      search?: string
      days?: string
      page?: string
      limit?: string
    }
  }>(
    '/',
    { preHandler: requireAuth },
    async (req, reply) => {
      const page = Math.max(1, Number(req.query.page) || 1)
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))

      const q = db('nivaro_trash').orderBy('deleted_at', 'desc')
      if (!req.isAdmin) q.where({ deleted_by: req.user!.id })
      if (req.query.collection) q.where({ collection: req.query.collection })
      const days = Number(req.query.days)
      if (Number.isFinite(days) && days > 0) {
        q.where('deleted_at', '>=', new Date(Date.now() - Math.min(3650, days) * 86_400_000))
      }
      const search = String(req.query.search ?? '').trim()
      if (search) {
        // The snapshot is JSON text — a cautious LIKE over it (and the item
        // id) is the honest cheap filter; wildcards escaped so a typed % can't
        // match everything.
        const like = `%${search.replace(/[%_[]/g, (c) => `[${c}]`)}%`
        q.where((qb) => {
          qb.where('data', 'like', like).orWhere('item_id', 'like', like)
        })
      }

      const countQ = q.clone().clearOrder().count<{ c: number }[]>('id as c')
      const rows = (await q.offset((page - 1) * limit).limit(limit)) as TrashRow[]
      const total = Number((await countQ)[0]?.c ?? 0)

      const userIds = [...new Set(rows.map((r) => r.deleted_by).filter(Boolean))] as string[]
      const users = userIds.length
        ? ((await db('nivaro_users')
            .whereIn('id', userIds)
            .select('id', 'first_name', 'last_name')) as Array<{
            id: string
            first_name: string | null
            last_name: string | null
          }>)
        : []
      const nameById = new Map(
        users.map((u) => [u.id, `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim()])
      )

      // Full dropdown option list for the viewer's scope — the page can't
      // derive it from the current (filtered) page of rows. NOTE: never
      // .distinct(col).pluck(col) on mssql — nested-array trap.
      const colQ = db('nivaro_trash').distinct('collection')
      if (!req.isAdmin) colQ.where({ deleted_by: req.user!.id })
      const colRows = (await colQ) as Array<{ collection: string }>
      const collections = [...new Set(colRows.map((r) => String(r.collection)))].sort()

      return reply.send({
        collections,
        data: rows.map((r) => {
          let data: Record<string, unknown> = {}
          try {
            data = JSON.parse(r.data) as Record<string, unknown>
          } catch {
            /* unreadable snapshot — label falls back to item_id */
          }
          return {
            id: r.id,
            collection: r.collection,
            item_id: r.item_id,
            label: rowLabel({ ...data, id: r.item_id }),
            deleted_by: r.deleted_by,
            deleted_by_name: r.deleted_by ? (nameById.get(r.deleted_by) ?? null) : null,
            deleted_at: r.deleted_at
          }
        }),
        total,
        page,
        limit
      })
    }
  )

  // Bulk restore (#668): up to 100 entries, each through the SAME single-row
  // restore service (permissions, id-occupied 409s, IDENTITY_INSERT all
  // apply); per-id result list, never all-or-nothing.
  app.post<{ Body: { ids?: unknown } }>(
    '/bulk-restore',
    { preHandler: requireAuth },
    async (req, reply) => {
      const raw = Array.isArray(req.body?.ids) ? req.body.ids : []
      const ids = [...new Set(raw.map(Number).filter((n) => Number.isFinite(n)))]
      if (ids.length === 0) return reply.code(400).send({ error: 'ids is required' })
      if (ids.length > 100) {
        return reply.code(400).send({ error: 'Up to 100 entries per bulk restore' })
      }

      const results: Array<{
        id: number
        ok: boolean
        collection?: string
        item_id?: string
        label?: string
        error?: string
      }> = []
      for (const trashId of ids) {
        const row = (await db('nivaro_trash').where({ id: trashId }).first()) as
          | TrashRow
          | undefined
        if (!row) {
          results.push({ id: trashId, ok: false, error: 'Trash entry not found' })
          continue
        }
        if (!req.isAdmin && row.deleted_by !== req.user!.id) {
          results.push({ id: trashId, ok: false, error: 'Forbidden' })
          continue
        }
        try {
          const result = await restoreTrashRow(req.user!, trashId)
          results.push({
            id: trashId,
            ok: true,
            collection: row.collection,
            item_id: result.item_id
          })
        } catch (err) {
          results.push({
            id: trashId,
            ok: false,
            collection: row.collection,
            item_id: row.item_id,
            error: err instanceof Error ? err.message : 'Restore failed'
          })
        }
      }

      const restored = results.filter((r) => r.ok).length
      await logActivity({
        action: 'trash-bulk-restore',
        user: req.user!.id,
        req,
        comment: `${restored} restored, ${results.length - restored} failed (${results.length} attempted)`
      })
      return reply.send({
        data: { results, restored, failed: results.length - restored }
      })
    }
  )

  app.post<{ Params: { id: string } }>(
    '/:id/restore',
    { preHandler: requireAuth },
    async (req, reply) => {
      const trashId = Number(req.params.id)
      const row = (await db('nivaro_trash').where({ id: trashId }).first()) as
        | TrashRow
        | undefined
      if (!row) return reply.code(404).send({ error: 'Trash entry not found' })
      if (!req.isAdmin && row.deleted_by !== req.user!.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      try {
        const result = await restoreTrashRow(req.user!, trashId)
        await logActivity({
          action: 'trash-restore',
          collection: row.collection,
          item: result.item_id,
          user: req.user!.id,
          comment: `Restored from trash entry ${trashId}`
        })
        return reply.send({ data: { restored: true, collection: row.collection, ...result } })
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 500
        return reply
          .code(status)
          .send({ error: err instanceof Error ? err.message : 'Restore failed' })
      }
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const trashId = Number(req.params.id)
      const row = (await db('nivaro_trash').where({ id: trashId }).first()) as
        | TrashRow
        | undefined
      if (!row) return reply.code(404).send({ error: 'Trash entry not found' })
      if (!req.isAdmin && row.deleted_by !== req.user!.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const hold = await db('nivaro_legal_holds')
        .where({ collection: row.collection, item_id: String(row.item_id) })
        .whereNull('released_at')
        .first('id', 'reason')
      if (hold) {
        return reply.code(423).send({
          error: `This record is under legal hold (${String(hold.reason).slice(0, 200)}) — release the hold before purging.`
        })
      }
      await db('nivaro_trash').where({ id: trashId }).del()
      // Permanent purge — the last chance to recover this row is gone, so the
      // audit entry records what was destroyed.
      await logActivity({
        action: 'trash-purge',
        collection: row.collection,
        item: String(row.item_id),
        user: req.user!.id,
        req,
        comment: `purged trash entry ${trashId}`
      })
      return reply.send({ data: { purged: true } })
    }
  )
}

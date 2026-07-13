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
  app.get<{ Querystring: { collection?: string; page?: string; limit?: string } }>(
    '/',
    { preHandler: requireAuth },
    async (req, reply) => {
      const page = Math.max(1, Number(req.query.page) || 1)
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))

      const q = db('nivaro_trash').orderBy('deleted_at', 'desc')
      if (!req.isAdmin) q.where({ deleted_by: req.user!.id })
      if (req.query.collection) q.where({ collection: req.query.collection })

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

      return reply.send({
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
      await db('nivaro_trash').where({ id: trashId }).del()
      return reply.send({ data: { purged: true } })
    }
  )
}

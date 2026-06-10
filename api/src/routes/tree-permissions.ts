import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { clearTreePermissionCache } from '../services/tree-permissions.js'

const VALID_ACTIONS = new Set(['read', 'update', 'delete', '*'])

interface TreePermissionBody {
  collection?: string
  node_id?: string | number
  role?: string
  action?: string
  allow?: boolean
}

async function readWithRoleName(id: number) {
  return db('nivaro_tree_permissions as tp')
    .leftJoin('nivaro_roles as r', 'r.id', 'tp.role')
    .where('tp.id', id)
    .select('tp.*', 'r.name as role_name')
    .first()
}

/**
 * Admin CRUD for nivaro_tree_permissions. All paths are absolute under the
 * /api prefix (registered like treeRoutes — no extra prefix needed).
 */
export async function treePermissionsRoutes(app: FastifyInstance) {
  // GET /tree-permissions?collection= — list rules (role name joined)
  app.get<{ Querystring: { collection?: string } }>(
    '/tree-permissions',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const q = db('nivaro_tree_permissions as tp')
        .leftJoin('nivaro_roles as r', 'r.id', 'tp.role')
        .select('tp.*', 'r.name as role_name')
        .orderBy('tp.collection', 'asc')
        .orderBy('tp.node_id', 'asc')
        .orderBy('tp.id', 'asc')
      if (req.query.collection) q.where('tp.collection', req.query.collection)
      const rows = await q
      return reply.send({ data: rows })
    }
  )

  // POST /tree-permissions — create a rule
  app.post('/tree-permissions', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as TreePermissionBody

    if (!body.collection || body.node_id == null || body.node_id === '' || !body.role) {
      return reply.code(400).send({ error: 'collection, node_id and role are required' })
    }
    const action = body.action ?? '*'
    if (!VALID_ACTIONS.has(action)) {
      return reply.code(400).send({ error: `action must be one of: read, update, delete, *` })
    }
    const role = await db('nivaro_roles').where({ id: body.role }).first()
    if (!role) return reply.code(400).send({ error: 'Unknown role' })

    const ids = (await db('nivaro_tree_permissions')
      .insert({
        collection: body.collection,
        node_id: String(body.node_id),
        role: body.role,
        action,
        allow: body.allow !== false,
        created_at: new Date()
      })
      .returning('id')) as unknown[]
    const raw = ids[0] as { id: number } | number
    const id = typeof raw === 'object' && raw !== null ? raw.id : raw

    clearTreePermissionCache(body.collection)

    const created = await readWithRoleName(Number(id))
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_tree_permissions',
      item: String(id),
      req
    })
    return reply.code(201).send({ data: created })
  })

  // PATCH /tree-permissions/:id — update a rule
  app.patch<{ Params: { id: string } }>(
    '/tree-permissions/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db('nivaro_tree_permissions').where({ id }).first()) as
        | { collection: string }
        | undefined
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = (req.body ?? {}) as TreePermissionBody
      const patch: Record<string, unknown> = {}

      if (body.node_id != null && body.node_id !== '') patch.node_id = String(body.node_id)
      if (body.action != null) {
        if (!VALID_ACTIONS.has(body.action)) {
          return reply.code(400).send({ error: `action must be one of: read, update, delete, *` })
        }
        patch.action = body.action
      }
      if (body.role != null) {
        const role = await db('nivaro_roles').where({ id: body.role }).first()
        if (!role) return reply.code(400).send({ error: 'Unknown role' })
        patch.role = body.role
      }
      if ('allow' in body) patch.allow = body.allow !== false

      if (Object.keys(patch).length > 0) {
        await db('nivaro_tree_permissions').where({ id }).update(patch)
        clearTreePermissionCache(existing.collection)
      }

      const updated = await readWithRoleName(id)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_tree_permissions',
        item: String(id),
        req
      })
      return reply.send({ data: updated })
    }
  )

  // DELETE /tree-permissions/:id — remove a rule
  app.delete<{ Params: { id: string } }>(
    '/tree-permissions/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db('nivaro_tree_permissions').where({ id }).first()) as
        | { collection: string }
        | undefined
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_tree_permissions').where({ id }).delete()
      clearTreePermissionCache(existing.collection)
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_tree_permissions',
        item: String(id),
        req
      })
      return reply.code(204).send()
    }
  )
}

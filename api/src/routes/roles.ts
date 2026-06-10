import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import { getPoliciesForRole, parseRowFilter } from '../services/permissions.js'
import type { Role } from '../types.js'

/**
 * Validate + normalize an incoming row_filter. Returns:
 *  - { ok: true, value: string }  → JSON string to store
 *  - { ok: true, value: null }    → clear the filter
 *  - { ok: false }                → invalid input (400)
 */
function normalizeRowFilter(input: unknown): { ok: true; value: string | null } | { ok: false } {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (Array.isArray(input) && input.length === 0) return { ok: true, value: null }
  const parsed = parseRowFilter(input)
  if (!parsed) return { ok: false }
  return { ok: true, value: JSON.stringify(parsed) }
}

export async function rolesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  app.addHook('preHandler', resolveWorkspace)

  app.get('/', async (req, reply) => {
    const data = await db<Role>('nivaro_roles')
      .where(function () {
        this.where('workspace', req.workspaceId).orWhereNull('workspace')
      })
      .orderBy('name')
    return reply.send({ data })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const role = await db<Role>('nivaro_roles').where({ id }).first()
    if (!role) return reply.code(404).send({ error: 'Not found' })
    const policies = await getPoliciesForRole(id)
    return reply.send({ data: { ...role, policies } })
  })

  app.post('/', async (req, reply) => {
    const body = req.body as Omit<Role, 'id' | 'created_at' | 'updated_at'>
    const id = randomUUID()
    await db('nivaro_roles').insert({
      id,
      ...body,
      workspace: req.workspaceId,
      created_at: new Date(),
      updated_at: new Date()
    })
    const role = await db<Role>('nivaro_roles').where({ id }).first()
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_roles',
      item: id,
      req
    })
    return reply.code(201).send({ data: role })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await db('nivaro_roles')
      .where({ id })
      .update({ ...(req.body as object), updated_at: new Date() })
    const role = await db<Role>('nivaro_roles').where({ id }).first()
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_roles',
      item: id,
      req
    })
    return reply.send({ data: role })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const users = await db('nivaro_users').where({ role: id }).count('id as count').first()
    if (Number(users?.count) > 0) {
      return reply.code(400).send({ error: 'Cannot delete a role that has users assigned to it' })
    }
    await db('nivaro_policies').where({ role: id }).delete()
    await db('nivaro_roles').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_roles',
      item: id,
      req
    })
    return reply.code(204).send()
  })

  // Users assigned to a role
  app.get('/:id/users', async (req, reply) => {
    const { id } = req.params as { id: string }
    const users = await db('nivaro_users')
      .where({ role: id })
      .select('id', 'first_name', 'last_name', 'email', 'status', 'last_access')
      .orderBy('first_name')
    return reply.send({ data: users })
  })

  // Policies for a role
  app.get('/:id/policies', async (req, reply) => {
    const { id } = req.params as { id: string }
    return reply.send({ data: await getPoliciesForRole(id) })
  })

  app.post('/:id/policies', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as {
      collection: string
      action: string
      fields?: string[]
      row_filter?: unknown
    }
    const rowFilter = normalizeRowFilter(body.row_filter)
    if (!rowFilter.ok) {
      return reply
        .code(400)
        .send({ error: 'row_filter must be an array of { field, op, value } conditions' })
    }
    // nivaro_policies.id is an auto-increment integer — extract from the returned object
    const [row] = (await db('nivaro_policies')
      .insert({
        role: id,
        collection: body.collection,
        action: body.action,
        fields: body.fields ? JSON.stringify(body.fields) : null,
        row_filter: rowFilter.value,
        created_at: new Date()
      })
      .returning('id')) as unknown as [{ id: number }]
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_policies',
      item: String(row.id),
      req
    })
    return reply.code(201).send({ data: { id: row.id, ...body, role: id } })
  })

  // Update a policy — currently supports fields + row_filter (row-level security)
  app.patch('/policies/:policyId', async (req, reply) => {
    const { policyId } = req.params as { policyId: string }
    const body = req.body as { fields?: string[] | null; row_filter?: unknown }

    const existing = await db('nivaro_policies').where({ id: policyId }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const updates: Record<string, unknown> = {}
    if ('fields' in body) {
      updates.fields = body.fields ? JSON.stringify(body.fields) : null
    }
    if ('row_filter' in body) {
      const rowFilter = normalizeRowFilter(body.row_filter)
      if (!rowFilter.ok) {
        return reply
          .code(400)
          .send({ error: 'row_filter must be an array of { field, op, value } conditions' })
      }
      updates.row_filter = rowFilter.value
    }

    if (Object.keys(updates).length > 0) {
      await db('nivaro_policies').where({ id: policyId }).update(updates)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_policies',
        item: policyId,
        req
      })
    }

    const updated = await db('nivaro_policies').where({ id: policyId }).first()
    return reply.send({
      data: {
        ...updated,
        fields: updated.fields ? JSON.parse(updated.fields) : null,
        row_filter: parseRowFilter(updated.row_filter)
      }
    })
  })

  app.delete('/policies/:policyId', async (req, reply) => {
    const { policyId } = req.params as { policyId: string }
    await db('nivaro_policies').where({ id: policyId }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_policies',
      item: policyId,
      req
    })
    return reply.code(204).send()
  })
}

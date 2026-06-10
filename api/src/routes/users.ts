import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { writeRevision } from '../services/revisions.js'
import { getUser, listUsers, updateUser } from '../services/users.js'

export async function usersRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as {
      limit?: string
      offset?: string
      search?: string
      sort?: string
      filter?: string
    }
    let filter: Record<string, unknown> = {}
    if (q.filter) {
      try {
        filter = JSON.parse(q.filter)
      } catch {
        // ignore malformed filter
      }
    }
    const result = await listUsers({
      limit: Number(q.limit ?? 25),
      offset: Number(q.offset ?? 0),
      search: q.search,
      sort: q.sort,
      filter
    })
    return reply.send(result)
  })

  app.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id !== 'me' && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const userId = id === 'me' ? req.user!.id : id
    const user = await getUser(userId)
    if (!user) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: user })
  })

  app.patch('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id !== req.user!.id && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const body = req.body as Record<string, unknown>
    const allowed: Array<keyof Parameters<typeof updateUser>[1]> = req.isAdmin
      ? [
          'first_name',
          'last_name',
          'status',
          'role',
          'last_page',
          'preferences',
          'manager_id',
          'delegate_id',
          'delegate_expires_at',
          'is_out_of_office'
        ]
      : [
          'first_name',
          'last_name',
          'last_page',
          'preferences',
          'delegate_id',
          'delegate_expires_at',
          'is_out_of_office'
        ]
    const filtered = Object.fromEntries(
      Object.entries(body).filter(([k]) => (allowed as string[]).includes(k))
    )
    const previousUser = await getUser(id)
    const user = await updateUser(id, filtered)
    const activityId = await logActivity({
      action: 'update',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: id,
      req
    })
    if (activityId && user) {
      const userData = user as unknown as Record<string, unknown>
      const prevData = previousUser as unknown as Record<string, unknown> | null
      const delta = prevData
        ? Object.fromEntries(
            Object.entries(userData).filter(
              ([k, v]) => JSON.stringify(prevData[k]) !== JSON.stringify(v)
            )
          )
        : null
      await writeRevision({
        activity: activityId,
        collection: 'nivaro_users',
        item: id,
        data: userData,
        delta
      })
    }
    return reply.send({ data: user })
  })

  // ─── Self-service delegation ──────────────────────────────────────────────
  // POST /users/me/delegate — lets any authenticated user set their own
  // out-of-office delegation without admin access.
  app.post('/me/delegate', { preHandler: authenticate }, async (req, reply) => {
    const body = req.body as {
      delegate_id?: string | null
      delegate_expires_at?: string | null
      is_out_of_office?: boolean
    }
    const userId = req.user!.id

    if (body.delegate_id && body.delegate_id === userId) {
      return reply.code(400).send({ error: 'Cannot delegate to yourself' })
    }
    if (body.delegate_id) {
      const delegate = await db('nivaro_users').where({ id: body.delegate_id }).first()
      if (!delegate) return reply.code(400).send({ error: 'Delegate user not found' })
    }

    const updates = {
      delegate_id: body.delegate_id ?? null,
      delegate_expires_at: body.delegate_expires_at ? new Date(body.delegate_expires_at) : null,
      is_out_of_office: body.is_out_of_office ?? false
    }

    const previousUser = await getUser(userId)
    const user = await updateUser(userId, updates)
    const activityId = await logActivity({
      action: 'update',
      user: userId,
      collection: 'nivaro_users',
      item: userId,
      req
    })
    if (activityId && user) {
      const userData = user as unknown as Record<string, unknown>
      const prevData = previousUser as unknown as Record<string, unknown> | null
      const delta = prevData
        ? Object.fromEntries(
            Object.entries(userData).filter(
              ([k, v]) => JSON.stringify(prevData[k]) !== JSON.stringify(v)
            )
          )
        : null
      await writeRevision({
        activity: activityId,
        collection: 'nivaro_users',
        item: userId,
        data: userData,
        delta
      })
    }
    return reply.send({ data: user })
  })

  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      email: string
      first_name?: string
      last_name?: string
      role?: string
    }
    if (!body.email) return reply.code(400).send({ error: 'email is required' })
    const existing = await db('nivaro_users').where({ email: body.email }).first()
    if (existing) return reply.code(409).send({ error: 'Email already in use' })
    const userId = randomUUID()
    await db('nivaro_users').insert({
      id: userId,
      email: body.email,
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      role: body.role ?? null,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date()
    })
    const user = await getUser(userId)
    const activityId = await logActivity({
      action: 'create',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: userId,
      req
    })
    if (activityId && user) {
      await writeRevision({
        activity: activityId,
        collection: 'nivaro_users',
        item: userId,
        data: user as unknown as Record<string, unknown>,
        delta: null
      })
    }
    return reply.code(201).send({ data: user })
  })

  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id === req.user!.id) return reply.code(400).send({ error: 'Cannot delete yourself' })
    const deletedUser = await getUser(id)
    await db('nivaro_users').where({ id }).delete()
    const activityId = await logActivity({
      action: 'delete',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: id,
      req
    })
    if (activityId && deletedUser) {
      await writeRevision({
        activity: activityId,
        collection: 'nivaro_users',
        item: id,
        data: deletedUser as unknown as Record<string, unknown>,
        delta: null
      })
    }
    return reply.code(204).send()
  })

  // ─── Static token management ──────────────────────────────────────────────
  // POST /users/me/token or /users/:id/token (admin)
  app.post('/:id/token', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id !== 'me' && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const userId = id === 'me' ? req.user!.id : id

    const token = randomBytes(32).toString('hex') // 64-char hex
    await db('nivaro_users').where({ id: userId }).update({ static_token: token })
    await logActivity({
      action: 'token.generate',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: userId,
      req
    })
    return reply.send({ data: { token } })
  })

  // DELETE /users/me/token or /users/:id/token (admin)
  app.delete('/:id/token', { preHandler: authenticate }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (id !== 'me' && !req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const userId = id === 'me' ? req.user!.id : id

    await db('nivaro_users').where({ id: userId }).update({ static_token: null })
    await logActivity({
      action: 'token.revoke',
      user: req.user!.id,
      collection: 'nivaro_users',
      item: userId,
      req
    })
    return reply.code(204).send()
  })
}

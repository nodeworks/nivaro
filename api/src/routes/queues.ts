import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { parseJson, toJsonStr } from '../services/pipeline-engine.js'
import type { QueueRow, QueueScope, QueueSourceRow, QueueSourceType } from '../services/queues.js'
import { fetchQueueItems } from '../services/queues.js'

function formatQueue(row: QueueRow) {
  return {
    ...row,
    is_shared: !!row.is_shared,
    is_active: !!row.is_active
  }
}

function formatSource(row: QueueSourceRow) {
  return {
    ...row,
    filters: parseJson(row.filters),
    state_values: parseJson(row.state_values)
  }
}

/**
 * Read visibility for a single queue: admin, owner, or a shared queue whose
 * role_id is either unset (shared with everyone) or matches the viewer's
 * role. Mirrors the GET / list query's WHERE clause exactly — GET /:id and
 * GET /:id/items must never be reachable for a queue the list endpoint
 * would have excluded (role-scoped shared queues are not "public to any
 * authenticated user" just because is_shared=true).
 */
function canReadQueue(queue: QueueRow, req: FastifyRequest): boolean {
  if (req.isAdmin) return true
  if (queue.owner === req.user!.id) return true
  if (!queue.is_shared) return false
  const userRole = req.user!.role ?? null
  return queue.role_id === null || queue.role_id === userRole
}

const SOURCE_TYPES: QueueSourceType[] = ['collection', 'tasks', 'approvals', 'owned_by_me']

export async function queuesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET / — own queues + shared queues (optionally role-matched)
  app.get('/', async (req, reply) => {
    const userId = req.user!.id
    const userRole = req.user!.role ?? null

    const rows = (await db<QueueRow>('nivaro_queues')
      .where({ is_active: true })
      .andWhere((qb) => {
        qb.where({ owner: userId }).orWhere((shared) => {
          shared.where('is_shared', true).andWhere((roleQb) => {
            roleQb.whereNull('role_id')
            if (userRole) roleQb.orWhere('role_id', userRole)
          })
        })
      })
      .orderBy('created_at', 'asc')) as QueueRow[]

    return reply.send({ data: rows.map(formatQueue) })
  })

  // GET /:id — single queue + its sources
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as QueueRow | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const sources = (await db<QueueSourceRow>('nivaro_queue_sources')
      .where({ queue_id: id })
      .orderBy('sort')) as QueueSourceRow[]

    return reply.send({ data: { ...formatQueue(queue), sources: sources.map(formatSource) } })
  })

  // POST / — create a queue owned by the current user, seeded with an owned_by_me source
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string
      description?: string
      icon?: string
      color?: string
      is_shared?: boolean
      role_id?: string | null
      view_mode?: 'table' | 'kanban' | 'both'
    }

    if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const [queue] = (await db('nivaro_queues')
      .insert({
        name: body.name.trim(),
        description: body.description ?? null,
        icon: body.icon ?? null,
        color: body.color ?? null,
        owner: req.user!.id,
        is_shared: !!body.is_shared,
        role_id: body.role_id ?? null,
        view_mode: body.view_mode ?? 'table',
        is_active: true,
        created_at: new Date()
      })
      .returning('*')) as unknown as [QueueRow]

    await db('nivaro_queue_sources').insert({
      queue_id: queue.id,
      type: 'owned_by_me',
      collection: null,
      filters: toJsonStr(null),
      state_values: toJsonStr(null),
      sort: 0
    })

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_queues',
      item: String(queue.id),
      comment: queue.name,
      req
    })

    return reply.code(201).send({ data: formatQueue(queue) })
  })

  // PATCH /:id — update queue metadata (owner or admin)
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as QueueRow | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && queue.owner !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = (req.body ?? {}) as {
      name?: string
      description?: string | null
      icon?: string | null
      color?: string | null
      is_shared?: boolean
      role_id?: string | null
      view_mode?: 'table' | 'kanban' | 'both'
      is_active?: boolean
    }

    const update: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) {
      if (!body.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' })
      update.name = body.name.trim()
    }
    if (body.description !== undefined) update.description = body.description
    if (body.icon !== undefined) update.icon = body.icon
    if (body.color !== undefined) update.color = body.color
    if (body.is_shared !== undefined) update.is_shared = !!body.is_shared
    if (body.role_id !== undefined) update.role_id = body.role_id
    if (body.view_mode !== undefined) update.view_mode = body.view_mode
    if (body.is_active !== undefined) update.is_active = !!body.is_active

    await db('nivaro_queues').where({ id }).update(update)
    const updated = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as QueueRow

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_queues',
      item: String(id),
      req
    })

    return reply.send({ data: formatQueue(updated) })
  })

  // DELETE /:id — delete queue (owner or admin); sources cascade via FK
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as QueueRow | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && queue.owner !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_queues').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_queues',
      item: String(id),
      req
    })
    return reply.code(204).send()
  })

  // PATCH /:id/sources — bulk-replace all sources for this queue
  app.patch('/:id/sources', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as QueueRow | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && queue.owner !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = req.body as {
      sources?: Array<{
        type?: string
        collection?: string | null
        filters?: unknown
        state_values?: unknown
        sort?: number
      }>
    }
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      return reply.code(400).send({ error: 'sources[] is required and cannot be empty' })
    }
    for (const s of body.sources) {
      if (!s.type || !SOURCE_TYPES.includes(s.type as QueueSourceType)) {
        return reply.code(400).send({ error: `invalid source type: ${s.type}` })
      }
      if (s.type === 'collection' && !s.collection) {
        return reply.code(400).send({ error: 'collection is required for type=collection sources' })
      }
    }

    await db.transaction(async (trx) => {
      await trx('nivaro_queue_sources').where({ queue_id: id }).delete()
      await trx('nivaro_queue_sources').insert(
        body.sources!.map((s, i) => ({
          queue_id: id,
          type: s.type,
          collection: s.collection ?? null,
          filters: toJsonStr(s.filters),
          state_values: toJsonStr(s.state_values),
          sort: s.sort ?? i
        }))
      )
    })

    const sources = (await db<QueueSourceRow>('nivaro_queue_sources')
      .where({ queue_id: id })
      .orderBy('sort')) as QueueSourceRow[]

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_queues',
      item: String(id),
      comment: 'sources',
      req
    })

    return reply.send({ data: sources.map(formatSource) })
  })

  // GET /:id/items?scope=mine|unowned|all — fan-out worklist
  app.get('/:id/items', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { scope = 'all' } = req.query as { scope?: string }
    if (!['mine', 'unowned', 'all'].includes(scope)) {
      return reply.code(400).send({ error: 'scope must be mine, unowned, or all' })
    }

    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as QueueRow | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const result = await fetchQueueItems(id, req.user!, scope as QueueScope)
    return reply.send({ data: result.items, stats: result.stats })
  })
}

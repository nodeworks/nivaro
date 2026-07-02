import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { parseJson, toJsonStr } from '../services/pipeline-engine.js'
import type { QueueRow, QueueScope, QueueSourceRow, QueueSourceType } from '../services/queues.js'
import {
  computeAvailableExtraFields,
  fetchQueueItems,
  fetchQueueWorkload
} from '../services/queues.js'
import { broadcastCollectionUpdate } from '../services/realtime.js'

// Format-only validation for extra_fields entries used as SQL column identifiers in
// resolveCollectionSource's .select(['id', ...extraFieldNames]) — mirrors
// api/src/routes/widget.ts's FIELD_NAME_RE/validateFields exactly. Declared locally
// rather than imported from widget.ts to avoid a circular import (widget.ts already
// imports canReadQueue from this file).
const FIELD_NAME_RE = /^[a-zA-Z0-9_]+$/

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
    state_values: parseJson(row.state_values),
    extra_fields: parseJson(row.extra_fields)
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
export function canReadQueue(queue: QueueRow, req: FastifyRequest): boolean {
  if (req.isAdmin) return true
  if (queue.owner === req.user!.id) return true
  if (!queue.is_shared) return false
  const userRole = req.user!.role ?? null
  return queue.role_id === null || queue.role_id === userRole
}

const SOURCE_TYPES: QueueSourceType[] = ['collection', 'tasks', 'approvals', 'owned_by_me']
const MAX_SOURCES_PER_QUEUE = 10

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
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const sources = (await db<QueueSourceRow>('nivaro_queue_sources')
      .where({ queue_id: id })
      .orderBy('sort')) as QueueSourceRow[]

    return reply.send({
      data: {
        ...formatQueue(queue),
        sources: sources.map(formatSource),
        available_extra_fields: computeAvailableExtraFields(sources)
      }
    })
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
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
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
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
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
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
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
        sla_filter?: string | null
        extra_fields?: unknown
        sort?: number
      }>
    }
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      return reply.code(400).send({ error: 'sources[] is required and cannot be empty' })
    }
    if (body.sources.length > MAX_SOURCES_PER_QUEUE) {
      return reply
        .code(400)
        .send({ error: `A queue can have at most ${MAX_SOURCES_PER_QUEUE} sources` })
    }
    for (const s of body.sources) {
      if (!s.type || !SOURCE_TYPES.includes(s.type as QueueSourceType)) {
        return reply.code(400).send({ error: `invalid source type: ${s.type}` })
      }
      if (s.type === 'collection' && !s.collection) {
        return reply.code(400).send({ error: 'collection is required for type=collection sources' })
      }
      if (s.sla_filter && s.sla_filter !== 'warning' && s.sla_filter !== 'breached') {
        return reply.code(400).send({ error: `invalid sla_filter: ${s.sla_filter}` })
      }
      if (s.extra_fields !== undefined) {
        if (!Array.isArray(s.extra_fields) || s.extra_fields.length > 5) {
          return reply
            .code(400)
            .send({ error: 'extra_fields must be an array of at most 5 field names' })
        }
        for (const f of s.extra_fields) {
          if (typeof f !== 'string') {
            return reply.code(400).send({
              error: 'extra_fields must contain only valid field names (letters, numbers, underscore)'
            })
          }
          const segments = f.split('.')
          if (segments.length === 0 || segments.length > 3) {
            return reply
              .code(400)
              .send({ error: `extra_fields path must have 1-3 segments: ${f}` })
          }
          if (segments.some((seg) => !FIELD_NAME_RE.test(seg))) {
            return reply.code(400).send({
              error: `extra_fields must contain only valid field names (letters, numbers, underscore): ${f}`
            })
          }
        }
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
          sla_filter: s.sla_filter ?? null,
          extra_fields: toJsonStr(s.extra_fields ?? []),
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

  // GET /:id/column-prefs — current user's saved visible-columns for this queue
  app.get('/:id/column-prefs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const pref = await db('nivaro_queue_column_prefs')
      .where({ queue_id: id, user: req.user!.id })
      .first()

    return reply.send({
      data: { visible_columns: pref ? (parseJson(pref.visible_columns) as string[]) : null }
    })
  })

  // PUT /:id/column-prefs — upsert current user's visible-columns for this queue
  app.put('/:id/column-prefs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const body = req.body as { visible_columns?: unknown }
    if (
      !Array.isArray(body.visible_columns) ||
      body.visible_columns.some((c) => typeof c !== 'string')
    ) {
      return reply.code(400).send({ error: 'visible_columns must be an array of strings' })
    }

    const existing = await db('nivaro_queue_column_prefs')
      .where({ queue_id: id, user: req.user!.id })
      .first('id')

    if (existing) {
      await db('nivaro_queue_column_prefs')
        .where({ id: existing.id })
        .update({ visible_columns: toJsonStr(body.visible_columns) })
    } else {
      await db('nivaro_queue_column_prefs').insert({
        queue_id: id,
        user: req.user!.id,
        visible_columns: toJsonStr(body.visible_columns)
      })
    }

    return reply.send({ data: { visible_columns: body.visible_columns } })
  })

  // GET /:id/items?scope=mine|unowned|all|claimed — fan-out worklist
  app.get('/:id/items', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { scope = 'all' } = req.query as { scope?: string }
    if (!['mine', 'unowned', 'all', 'claimed'].includes(scope)) {
      return reply.code(400).send({ error: 'scope must be mine, unowned, all, or claimed' })
    }

    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const result = await fetchQueueItems(id, req.user!, scope as QueueScope)
    return reply.send({ data: result.items, stats: result.stats })
  })

  // GET /:id/workload — items grouped by owner, with each owner's most
  // restrictive max_wip (MIN across every owner-group they belong to that sets one)
  app.get('/:id/workload', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const workload = await fetchQueueWorkload(id, req.user!)
    return reply.send({ data: workload })
  })

  // POST /:id/claim — self-assign an item within this queue; write-through to the
  // real pipeline instance-owner table when the item has a live workflow instance.
  app.post('/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { source_collection?: string; item_id?: string }
    if (!body.source_collection || !body.item_id) {
      return reply.code(400).send({ error: 'source_collection and item_id are required' })
    }

    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const { items } = await fetchQueueItems(id, req.user!, 'all')
    const targetKey = `${body.source_collection}:${body.item_id}`
    const found = items.some((i) => `${i.collection}:${i.item_id}` === targetKey)
    if (!found) {
      return reply.code(404).send({ error: 'Item not found in this queue' })
    }

    const existing = await db('nivaro_queue_claims')
      .where({ queue_id: id, source_collection: body.source_collection, item_id: body.item_id })
      .first()
    if (!existing) {
      await db('nivaro_queue_claims').insert({
        queue_id: id,
        source_collection: body.source_collection,
        item_id: body.item_id,
        claimed_by: req.user!.id,
        claimed_at: new Date()
      })
    }

    // Write-through: for sources pointing at a real collection record (everything
    // except 'tasks', whose item_id is a task's own PK, not a business record id),
    // also add the caller as a pipeline instance owner when a live workflow instance
    // exists — same self-add rule the Pipeline Owners panel already uses (POST
    // /pipelines/instance/:collection/:item/owners). Approvals sources point at a
    // real collection+item just like collection sources do, so they get the same
    // treatment, not an exclusion.
    if (body.source_collection !== 'tasks') {
      const instance = await db('nivaro_workflow_instances')
        .where({ collection: body.source_collection, item: body.item_id })
        .first()
      if (instance) {
        const alreadyOwner = await db('nivaro_pipeline_instance_owners')
          .where({ instance: instance.id, user: req.user!.id })
          .first()
        if (!alreadyOwner) {
          await db('nivaro_pipeline_instance_owners').insert({
            instance: instance.id,
            state: null,
            user: req.user!.id,
            added_by: req.user!.id,
            added_at: new Date()
          })
        }
      }
    }

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_queue_claims',
      item: `${body.source_collection}:${body.item_id}`,
      comment: id,
      req
    })

    broadcastCollectionUpdate(app.io, body.source_collection, body.item_id)

    return reply.code(201).send({ data: { claimed: true } })
  })

  // POST /:id/release — undo a claim, removing the write-through owner grant too
  // (only the grant this claim itself added — added_by=self guards against removing
  // ownership that came from an owner group).
  app.post('/:id/release', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { source_collection?: string; item_id?: string }
    if (!body.source_collection || !body.item_id) {
      return reply.code(400).send({ error: 'source_collection and item_id are required' })
    }

    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const { items } = await fetchQueueItems(id, req.user!, 'all')
    const targetKey = `${body.source_collection}:${body.item_id}`
    const found = items.some((i) => `${i.collection}:${i.item_id}` === targetKey)
    if (!found) {
      return reply.code(404).send({ error: 'Item not found in this queue' })
    }

    await db('nivaro_queue_claims')
      .where({
        queue_id: id,
        source_collection: body.source_collection,
        item_id: body.item_id,
        claimed_by: req.user!.id
      })
      .delete()

    // Write-through: remove the write-through owner grant for sources pointing at a
    // real collection record (everything except 'tasks', whose item_id is a task's
    // own PK, not a business record id) — same self-remove rule the Pipeline Owners
    // panel already uses (DELETE /pipelines/instance/:collection/:item/owners).
    // Approvals sources point at a real collection+item just like collection sources
    // do, so they get the same treatment, not an exclusion.
    if (body.source_collection !== 'tasks') {
      const instance = await db('nivaro_workflow_instances')
        .where({ collection: body.source_collection, item: body.item_id })
        .first()
      if (instance) {
        await db('nivaro_pipeline_instance_owners')
          .where({ instance: instance.id, user: req.user!.id, added_by: req.user!.id })
          .delete()
      }
    }

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_queue_claims',
      item: `${body.source_collection}:${body.item_id}`,
      comment: id,
      req
    })

    broadcastCollectionUpdate(app.io, body.source_collection, body.item_id)

    return reply.code(204).send()
  })
}

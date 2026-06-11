import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import * as svc from '../services/collections.js'
import type { CMSCollection } from '../types.js'

export async function collectionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', resolveWorkspace)

  app.get<{ Querystring: { tables_only?: string } }>('/', async (req, reply) => {
    const tablesOnly = req.query.tables_only === 'true'
    if (tablesOnly) {
      const data = await svc.listTableCollections()
      return reply.send({ data })
    }
    const data = await svc.listCollections(req.workspaceId)
    return reply.send({ data })
  })

  app.get('/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const col = await svc.getCollection(collection)
    if (!col) return reply.code(404).send({ error: 'Not found' })
    const [fields, relations] = await Promise.all([
      svc.getFields(collection),
      svc.getRelations(collection)
    ])
    return reply.send({ data: { ...col, fields, relations } })
  })

  app.post('/', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const body = req.body as Omit<CMSCollection, 'id' | 'created_at' | 'updated_at'>
    const data = await svc.createCollection({ ...body, workspace: req.workspaceId })
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: body.collection,
      req
    })
    return reply.code(201).send({ data })
  })

  app.patch('/reorder', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { items } = req.body as { items: { collection: string; sort: number }[] }
    await Promise.all(
      items.map(({ collection, sort }) =>
        db('nivaro_collections').where({ collection }).update({ sort })
      )
    )
    return reply.send({ ok: true })
  })

  app.patch('/:collection', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { collection } = req.params as { collection: string }
    const data = await svc.updateCollection(collection, req.body as Partial<CMSCollection>)
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: collection,
      req
    })
    return reply.send({ data })
  })

  app.delete('/:collection', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { collection } = req.params as { collection: string }
    await svc.deleteCollection(collection)
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: collection,
      req
    })
    return reply.code(204).send()
  })

  app.get('/:collection/fields', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    return reply.send({ data: await svc.getFields(collection) })
  })

  app.post('/:collection/fields', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Admin only' })
    const { collection } = req.params as { collection: string }
    const { field, ...rest } = req.body as { field: string } & Record<string, unknown>
    await svc.upsertField(collection, field, rest)
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_fields',
      item: `${collection}.${field}`,
      req
    })
    return reply.code(201).send({ data: await svc.getFields(collection) })
  })
}

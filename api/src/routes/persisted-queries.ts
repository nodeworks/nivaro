import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Persisted GraphQL queries (admin CRUD).
 *
 * POST computes the sha256 hash of the query text — clients then execute via
 * POST /api/graphql with { id } or APQ-style
 * { extensions: { persistedQuery: { sha256Hash } } }.
 */

interface PersistedQueryRow {
  id: number
  hash: string
  name: string
  query: string
  created_by: string
  created_at: Date
}

function sha256(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex')
}

export async function persistedQueriesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // List
  app.get('/', async () => {
    const rows = (await db('nivaro_persisted_queries').orderBy(
      'name',
      'asc'
    )) as PersistedQueryRow[]
    return { data: rows }
  })

  // Single
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db('nivaro_persisted_queries')
      .where({ id: Number(req.params.id) })
      .first()) as PersistedQueryRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: row }
  })

  // Create — hash computed server-side
  app.post<{ Body: { name?: string; query?: string } }>('/', async (req, reply) => {
    const { name, query } = req.body ?? {}
    if (!name || !query) {
      return reply.code(400).send({ error: 'name and query are required' })
    }

    const hash = sha256(query)
    const existing = (await db('nivaro_persisted_queries').where({ hash }).first()) as
      | PersistedQueryRow
      | undefined
    if (existing) {
      return reply
        .code(409)
        .send({ error: 'A persisted query with this exact text already exists', data: existing })
    }

    const [inserted] = await db('nivaro_persisted_queries')
      .insert({
        hash,
        name,
        query,
        created_by: req.user?.id,
        created_at: new Date()
      })
      .returning('*')

    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as PersistedQueryRow)
        : ((await db('nivaro_persisted_queries')
            .where({ id: inserted as number })
            .first()) as PersistedQueryRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_persisted_queries',
      item: String(row.id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: row })
  })

  // Update — recomputes hash when query text changes
  app.patch<{ Params: { id: string }; Body: Partial<{ name: string; query: string }> }>(
    '/:id',
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = (await db('nivaro_persisted_queries').where({ id }).first()) as
        | PersistedQueryRow
        | undefined
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = req.body ?? {}
      const patch: Record<string, unknown> = {}
      if (body.name !== undefined) patch.name = body.name
      if (body.query !== undefined && body.query !== existing.query) {
        const hash = sha256(body.query)
        const clash = (await db('nivaro_persisted_queries')
          .where({ hash })
          .whereNot({ id })
          .first()) as PersistedQueryRow | undefined
        if (clash) {
          return reply
            .code(409)
            .send({ error: 'Another persisted query with this exact text already exists' })
        }
        patch.query = body.query
        patch.hash = hash
      }

      if (Object.keys(patch).length > 0) {
        await db('nivaro_persisted_queries').where({ id }).update(patch)
      }
      const row = (await db('nivaro_persisted_queries').where({ id }).first()) as PersistedQueryRow

      await logActivity({
        action: 'update',
        collection: 'nivaro_persisted_queries',
        item: String(id),
        user: req.user?.id,
        req
      })
      return { data: row }
    }
  )

  // Delete
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const deleted = await db('nivaro_persisted_queries')
      .where({ id: Number(req.params.id) })
      .delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_persisted_queries',
      item: req.params.id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })
}

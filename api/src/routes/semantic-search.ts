import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import {
  embedText,
  getEmbeddableFields,
  searchEmbeddings,
  upsertItemEmbedding
} from '../services/embeddings.js'
import { can } from '../services/permissions.js'

// Registered under the /search prefix → /api/search/semantic, /api/search/reindex/:collection
export async function semanticSearchRoutes(app: FastifyInstance) {
  // POST /search/semantic — vector similarity search over a collection
  app.post('/semantic', { preHandler: authenticate }, async (req, reply) => {
    const { collection, query, limit } = req.body as {
      collection?: string
      query?: string
      limit?: number
    }

    if (!collection || !query) {
      return reply.code(400).send({ error: 'collection and query are required' })
    }
    if (collection.startsWith('nivaro_')) {
      return reply.code(403).send({ error: 'System collections cannot be searched' })
    }
    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const max = Math.min(Math.max(Number(limit) || 10, 1), 100)

    const queryVec = await embedText(query)
    const matches = await searchEmbeddings(collection, queryVec, max)
    if (matches.length === 0) {
      return reply.send({ data: [] })
    }

    // Hydrate only the rows that actually matched
    const ids = [...new Set(matches.map((m) => m.item))]
    const rows = (await db(collection).whereIn('id', ids)) as Array<Record<string, unknown>>
    const byId = new Map(rows.map((r) => [String(r.id), r]))

    const data = matches
      .map((m) => ({ item: byId.get(m.item), score: m.score, field: m.field }))
      .filter(
        (d): d is { item: Record<string, unknown>; score: number; field: string } =>
          d.item !== undefined
      )

    return reply.send({ data })
  })

  // POST /search/reindex/:collection — rebuild embeddings for all eligible text fields
  app.post('/reindex/:collection', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    if (collection.startsWith('nivaro_')) {
      return reply.code(403).send({ error: 'System collections cannot be indexed' })
    }

    const fields = await getEmbeddableFields(collection)
    if (fields.length === 0) {
      return reply.send({ indexed: 0 })
    }

    const BATCH = 500
    let offset = 0
    let indexed = 0

    for (;;) {
      const rows = (await db(collection)
        .select('id', ...fields)
        .orderBy('id', 'asc')
        .limit(BATCH)
        .offset(offset)) as Array<Record<string, unknown>>
      if (rows.length === 0) break

      for (const row of rows) {
        for (const field of fields) {
          const value = row[field]
          if (typeof value !== 'string' || value.trim() === '') continue
          try {
            const written = await upsertItemEmbedding(collection, String(row.id), field, value)
            if (written) indexed++
          } catch (err) {
            req.log.error({ err, collection, item: row.id, field }, 'Reindex embedding failed')
          }
        }
      }

      offset += rows.length
      if (rows.length < BATCH) break
    }

    return reply.send({ indexed })
  })
}

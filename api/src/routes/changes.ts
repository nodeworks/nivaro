import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import { FeedRefusal, readChangeFeed } from '../services/change-feed.js'
import { clientGoneSignal, withReadGate } from '../services/read-gate.js'

/**
 * GET /api/changes — the change feed for clients without a live session (#3221, MCP
 * changes_since; services/change-feed.ts).
 *
 *   GET /api/changes                         → { data: { changes: [], cursor } } (start from now)
 *   GET /api/changes?since=2026-10-29T12:00Z → changes since that time
 *   GET /api/changes?cursor=c1.…&collections=orders,lines&limit=100
 *
 * Record ids, actions and changed field NAMES only, for records the caller can see now.
 */
export async function changesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Unauthorized' })
    const q = req.query as Record<string, string | undefined>
    const collections = q.collections
      ? q.collections
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
      : undefined
    try {
      const data = await withReadGate(
        String(req.user.id),
        () =>
          readChangeFeed(req, {
            cursor: q.cursor || undefined,
            since: q.since || undefined,
            collections,
            limit: q.limit ? Number(q.limit) : undefined
          }),
        { signal: clientGoneSignal(reply.raw), label: 'changes' }
      )
      return reply.send({ data })
    } catch (err) {
      if (err instanceof FeedRefusal)
        return reply.code(err.statusCode).send({ error: err.message, code: err.code })
      throw err
    }
  })
}

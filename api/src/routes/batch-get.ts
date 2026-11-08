import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import {
  BATCH_GET_MAX,
  batchGetPath,
  runBatchGet,
  serializeBatchGet
} from '../services/batch-get.js'

/**
 * POST /api/batch-get {reads: [{key?, path}]} — several small GETs in one round trip
 * (services/batch-get.ts). Each `path` is the GET's path under /api with its query string;
 * each part answers `{key, status, body?, request_id?, retry_after?}` exactly as that GET
 * answers the same caller. The batch itself fails only on a malformed body or a caller who
 * is not signed in. A POST only because it carries a body: exempt from the maintenance freeze
 * and the sandbox-key guard (each part is a GET, judged on its own).
 */
export async function batchGetRoutes(app: FastifyInstance) {
  app.post('/batch-get', { preHandler: authenticate }, async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in first', code: 'UNAUTHENTICATED' })
    const body = (req.body ?? {}) as { reads?: unknown }
    if (!Array.isArray(body.reads) || body.reads.length === 0)
      return reply.code(400).send({ error: 'reads must be a non-empty array', code: 'BAD_REQUEST' })
    if (body.reads.length > BATCH_GET_MAX)
      return reply.code(400).send({
        error: `At most ${BATCH_GET_MAX} reads per batch`,
        code: 'BATCH_GET_LIMIT'
      })
    const reads = (body.reads as Array<{ key?: unknown; path?: unknown } | null>).map((r, i) => ({
      key: r?.key == null || r.key === '' ? String(i) : String(r.key),
      path: batchGetPath(r?.path)
    }))
    const results = await runBatchGet(app, req, reads)
    return reply
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(serializeBatchGet(results))
  })
}

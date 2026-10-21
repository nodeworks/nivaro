import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  REALTIME_WORKER_SOURCE,
  realtimeWorkerEnabled
} from '../services/realtime-worker-source.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * `GET /api/realtime/worker.js` (#2475) — the SharedWorker script tabs attach to for one socket
 * per browser. No sign-in: it is code, not data (the socket it opens signs in like any other).
 * Off (`REALTIME_SHARED_WORKER=off`) it answers 404 and tabs keep their own sockets.
 *
 * Registered apart from realtimeRoutes (admin only) on the same prefix. `no-cache` + ETag: a
 * browser re-validates on every new worker start, so a release is picked up by the next
 * worker without a stale copy living on; a running worker lives until its last tab closes.
 */
export async function realtimeWorkerRoutes(app: FastifyInstance): Promise<void> {
  const etag = `"${createHash('sha1').update(REALTIME_WORKER_SOURCE).update(NIVARO_VERSION).digest('hex').slice(0, 20)}"`
  app.get('/worker.js', async (req, reply) => {
    if (!realtimeWorkerEnabled())
      return reply.code(404).send({ error: 'Shared worker off', code: 'REALTIME_WORKER_OFF' })
    reply.header('Content-Type', 'application/javascript; charset=utf-8')
    reply.header('Cache-Control', 'no-cache')
    reply.header('ETag', etag)
    reply.header('X-Nivaro-Version', NIVARO_VERSION)
    if (req.headers['if-none-match'] === etag) return reply.code(304).send()
    return reply.send(REALTIME_WORKER_SOURCE)
  })
}

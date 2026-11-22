import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { isMultiTenant } from '../services/deployment-mode.js'
import { loadErrorClusters, requestIdsForCluster } from '../services/error-clusters-load.js'
import { withReadGate } from '../services/read-gate.js'
import { normalizeRequestId } from '../services/request-story.js'
import { loadRequestStory } from '../services/request-story-load.js'

/**
 * Readable operations (#19 / #20), admin only — a request story names the caller, the records
 * it wrote and the SQL it ran; clusters name routes and people counts.
 *
 *   GET /ops/request-story/:requestId            one request in plain words
 *   GET /ops/request-story/:requestId/related    same page load / caller / record / chain / error
 *   GET /ops/error-clusters?days=7&source=        server + client errors grouped by signature
 *   GET /ops/error-clusters/:signature?days=7     one cluster + request ids to open as stories
 */
export async function opsReadableRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get<{ Params: { requestId: string } }>('/request-story/:requestId', async (req, reply) => {
    const rid = normalizeRequestId(req.params.requestId)
    if (!rid) {
      return reply.code(400).send({
        error: 'Not a request id — paste the id from an error, a log row or a trace (a uuid).',
        code: 'BAD_REQUEST_ID'
      })
    }
    const story = await loadRequestStory(rid)
    return reply.send({ data: story })
  })

  /**
   * What else is linked to one request (the Traffic Map's related rail, services/traffic-inspect/
   * nav.ts relatedFor): same page load, same chain, same record, same caller (±5 min), same
   * error (issues) and its statement shapes. Its own call so the story never waits on it.
   * Cloud mode: the page-load and statement rails read per-process memory that is not
   * tenant-keyed, so cloud answers notes only.
   */
  app.get<{ Params: { requestId: string } }>(
    '/request-story/:requestId/related',
    async (req, reply) => {
      const rid = normalizeRequestId(req.params.requestId)
      if (!rid) {
        return reply.code(400).send({
          error: 'Not a request id — paste the id from an error, a log row or a trace (a uuid).',
          code: 'BAD_REQUEST_ID'
        })
      }
      if (isMultiTenant()) {
        return reply.send({
          data: { groups: [], notes: ['Related requests are not available on a cloud instance.'] }
        })
      }
      const { relatedFor } = await import('../services/traffic-inspect/nav.js')
      const data = await withReadGate(
        req.user?.id,
        () => relatedFor('request', rid, { req, at: null, windowSec: 300 }),
        { label: 'ops:request-story-related' }
      )
      return reply.send({
        data: data
          ? { groups: data.groups, notes: data.notes, load: data.load, window: data.window }
          : { groups: [], notes: ['Nothing else is linked to this request.'] }
      })
    }
  )

  const daysOf = (raw: unknown) => Math.min(30, Math.max(1, Number(raw) || 7))
  const sourceOf = (raw: unknown) => (raw === 'server' || raw === 'client' ? raw : null)

  app.get('/error-clusters', async (req, reply) => {
    const q = req.query as { days?: string; source?: string; limit?: string }
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200))
    const loaded = await withReadGate(
      req.user?.id,
      () => loadErrorClusters({ days: daysOf(q.days), source: sourceOf(q.source) }),
      { label: 'ops:error-clusters' }
    )
    return reply.send({
      data: {
        clusters: loaded.clusters.slice(0, limit),
        total: loaded.clusters.length,
        truncated: loaded.truncated,
        window: loaded.window
      }
    })
  })

  app.get<{ Params: { signature: string } }>('/error-clusters/:signature', async (req, reply) => {
    const sig = String(req.params.signature)
    if (!/^[0-9a-f]{20}$/.test(sig)) return reply.code(400).send({ error: 'Invalid signature' })
    const q = req.query as { days?: string; source?: string }
    const loaded = await withReadGate(
      req.user?.id,
      () => loadErrorClusters({ days: daysOf(q.days), source: sourceOf(q.source) }),
      { label: 'ops:error-clusters' }
    )
    const cluster = loaded.clusters.find((c) => c.signature === sig)
    if (!cluster) return reply.code(404).send({ error: 'No such cluster in this window' })
    const requests = await requestIdsForCluster(cluster, loaded.occurrences)
    return reply.send({ data: { cluster, requests, window: loaded.window } })
  })
}

import type { FastifyInstance } from 'fastify'
import { relatedNoteRegistry } from '../extensions/related-notes.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

/**
 * #20 / #29 — the integration events feed: every extension-registered notes
 * source that can LIST across records feeds one page (filter by integration
 * and status), and a provider that can REPLAY re-applies one event from its
 * stored form. The thread's per-record entries reuse the same replay route.
 */
export async function integrationEventsRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { integration?: string; status?: string; limit?: string }
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100))
    const status =
      q.status === 'ok' || q.status === 'error' || q.status === 'info' ? q.status : null
    const providers = relatedNoteRegistry.describe()
    const entries = await relatedNoteRegistry.listRecent({
      limit,
      provider: q.integration || null,
      status
    })
    return reply.send({ data: { providers, entries } })
  })

  app.post('/:provider/replay', { preHandler: requireAuth }, async (req, reply) => {
    const { provider: providerId } = req.params as { provider: string }
    const body = (req.body ?? {}) as { entry_id?: string | number }
    const provider = relatedNoteRegistry.get(providerId)
    if (!provider) return reply.code(404).send({ error: 'Unknown integration source' })
    if (!provider.replay)
      return reply.code(400).send({ error: 'This integration source cannot replay events' })
    if (body.entry_id == null || body.entry_id === '')
      return reply.code(400).send({ error: 'entry_id is required' })
    // Replaying re-applies data to the provider's collection — an update, not a read.
    if (!req.isAdmin && !(await can(req.user!, 'update', provider.collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    try {
      const result = await provider.replay(String(body.entry_id), { userId: req.user?.id ?? null })
      await logActivity({
        action: 'integration-event-replay',
        user: req.user?.id,
        collection: provider.collection,
        comment: `${providerId} · ${String(body.entry_id)} — ${result.detail}`,
        req
      })
      return reply.send({ data: { replayed: true, ...result } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await logActivity({
        action: 'integration-event-replay-failed',
        user: req.user?.id,
        collection: provider.collection,
        comment: `${providerId} · ${String(body.entry_id)} — ${message}`,
        req
      })
      return reply.code(422).send({ error: message })
    }
  })
}

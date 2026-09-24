import type { FastifyInstance } from 'fastify'
import { relatedNoteRegistry } from '../extensions/related-notes.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'
import { resolveFriendlyIds } from '../services/workflow-transitions.js'

type FeedEntry = Awaited<ReturnType<typeof relatedNoteRegistry.listRecent>>[number]

/**
 * Entries a provider sent without a record label get the record's friendly id
 * (the human id the entity-room registry names), one batched lookup per
 * collection over the page. Never throws — a failed lookup leaves the entry
 * unlabelled and the client falls back to the raw id.
 */
export async function fillItemLabels(entries: FeedEntry[]): Promise<void> {
  const byCollection = new Map<string, Set<string>>()
  for (const e of entries) {
    if (e.item_label || !e.collection || e.item_id == null || e.item_id === '') continue
    const set = byCollection.get(e.collection) ?? new Set<string>()
    set.add(String(e.item_id))
    byCollection.set(e.collection, set)
  }
  for (const [collection, ids] of byCollection) {
    try {
      const labels = await resolveFriendlyIds(collection, [...ids])
      for (const e of entries) {
        if (e.item_label || e.collection !== collection) continue
        const label = labels.get(String(e.item_id))
        // resolveFriendlyIds echoes the id when it finds nothing better.
        if (label && label !== String(e.item_id)) e.item_label = label
      }
    } catch {
      /* the entry keeps no label */
    }
  }
}

/**
 * #20 / #29 — the integration events feed: every extension-registered notes
 * source that can LIST across records feeds one page (filter by integration
 * and status), and a provider that can REPLAY re-applies one event from its
 * stored form. The thread's per-record entries reuse the same replay route.
 */
export async function integrationEventsRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as {
      integration?: string
      provider?: string
      status?: string
      limit?: string
      before?: string
    }
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100))
    const status =
      q.status === 'ok' || q.status === 'error' || q.status === 'info' ? q.status : null
    // `provider` is the name the console (and the old events page) sends;
    // `integration` is the original parameter — both narrow to one source.
    const provider = q.integration || q.provider || null
    const before = q.before && !Number.isNaN(new Date(q.before).getTime()) ? q.before : null
    const providers = relatedNoteRegistry.describe()
    const entries = await relatedNoteRegistry.listRecent({ limit, provider, status, before })
    await fillItemLabels(entries)
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

import type { FastifyInstance } from 'fastify'
import { relatedNoteRegistry } from '../extensions/related-notes.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { chainIdsForRoots, recordReplayRoot } from '../services/chain-roots.js'
import { chainsTouchingRecord, findRecordRef } from '../services/event-path/record-ref.js'
import {
  describeEventSources,
  fillEventLabels,
  listEvents
} from '../services/integration-event-sources.js'
import { can } from '../services/permissions.js'

/** Kept for existing importers — the fill lives with the event sources now. */
export const fillItemLabels = fillEventLabels

/**
 * #20 / #29 — the integration events feed: every registered event source
 * (core outbound pushes and inbound partner writes, plus each notes
 * provider that can LIST across records) feeds one page, filterable by
 * source, status, partner, caller and record; a provider that can REPLAY
 * re-applies one event from its stored form. The thread's per-record
 * entries reuse the same replay route.
 */
export async function integrationEventsRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500)
    const status =
      q.status === 'ok' || q.status === 'error' || q.status === 'info' ? q.status : null
    const before = q.before && !Number.isNaN(Date.parse(q.before)) ? q.before : null
    const record = q.record ? await findRecordRef(q.record) : null
    const chainIds = record ? await chainsTouchingRecord(record.collection, record.item) : null
    const entries = await listEvents({
      limit,
      status,
      before,
      // `provider` is what the console sends; `integration` the original
      // parameter; `source` the registry's own name — all narrow to one.
      source: q.source || q.provider || q.integration || null,
      partner: q.partner || null,
      caller: q.caller || null,
      includePeople: q.include_people === '1',
      record,
      chainIds
    })
    await fillEventLabels(entries)
    return reply.send({
      data: {
        providers: describeEventSources(),
        entries: entries.map((e) => ({ ...e, provider: e.source })),
        record
      }
    })
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
    const entryId = String(body.entry_id)
    // The replay runs on this request's chain; mark it as a replay of the
    // chain the original event started (null when that one predates chains).
    const original = (await chainIdsForRoots(provider.id, [entryId])).get(entryId)
    await recordReplayRoot({
      source: provider.id,
      ref: `replay:${entryId}`,
      replayOf: original ?? null
    })
    try {
      const result = await provider.replay(entryId, { userId: req.user?.id ?? null })
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

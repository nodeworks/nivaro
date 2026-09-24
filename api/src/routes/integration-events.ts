import type { FastifyInstance, FastifyRequest } from 'fastify'
import { relatedNoteRegistry } from '../extensions/related-notes.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { chainIdsForRoots, recordReplayRoot } from '../services/chain-roots.js'
import { buildChainPath, buildEventPath, type EventPath } from '../services/event-path/index.js'
import { chainsTouchingRecord, findRecordRef } from '../services/event-path/record-ref.js'
import { redactError } from '../services/event-path/redact.js'
import {
  describeEventSources,
  type EventEntry,
  fillEventLabels,
  getEvent,
  listEvents
} from '../services/integration-event-sources.js'
import { readItems } from '../services/items.js'
import { can } from '../services/permissions.js'

/** Kept for existing importers — the fill lives with the event sources now. */
export const fillItemLabels = fillEventLabels

/** Events per page on a record's integration activity list. */
const RECORD_PAGE = 25
/** Ids per permission read — well under readItems' row clamp and the bind cap. */
const READ_CHUNK = 500

type RecordRef = { collection: string; item: string }

/**
 * The "collection:item" keys among `refs` this request's user may open — each
 * collection read AS the user (RBAC, row filters, user scopes all apply).
 * System collections and anything that fails to read count as unreadable.
 */
function readerFor(req: FastifyRequest) {
  return async (refs: RecordRef[]): Promise<Set<string>> => {
    const allowed = new Set<string>()
    const byColl = new Map<string, Set<string>>()
    for (const r of refs) {
      if (!r.collection || r.item == null || r.item === '') continue
      const set = byColl.get(r.collection) ?? new Set<string>()
      set.add(String(r.item))
      byColl.set(r.collection, set)
    }
    for (const [collection, items] of byColl) {
      if (/^(nivaro|directus)_/i.test(collection)) continue
      if (!(await can(req.user!, 'read', collection).catch(() => false))) continue
      const ids = [...items]
      for (let i = 0; i < ids.length; i += READ_CHUNK) {
        const chunk = ids.slice(i, i + READ_CHUNK)
        try {
          const res = await readItems(
            req.user!,
            collection,
            { filter: { id: { _in: chunk } }, fields: ['id'], limit: chunk.length },
            req
          )
          for (const row of (res.data ?? []) as Array<{ id: unknown }>) {
            allowed.add(`${collection}:${String(row.id)}`)
          }
        } catch {
          // an unreadable collection allows nothing there
        }
      }
    }
    return allowed
  }
}

/** Whether an event concerns a record: it names it, or its chain touched it. */
function eventConcernsRecord(ev: EventEntry, record: RecordRef, chainIds: string[]): boolean {
  if (ev.collection === record.collection && String(ev.item_id) === String(record.item)) return true
  return Boolean(ev.chain_id && chainIds.includes(String(ev.chain_id)))
}

/** A non-admin sees an event's text at status level: first line, secrets masked, capped. */
function redactEntry<T extends { text: string }>(e: T): T {
  return { ...e, text: redactError(e.text, false) ?? '' }
}

/** Same treatment for the root step of a path shown to a non-admin. */
function redactRoot(path: EventPath): EventPath {
  const root = path.root
  return {
    ...path,
    root: {
      ...root,
      summary: redactError(root.summary, false) ?? '',
      reason: root.reason == null ? root.reason : redactError(root.reason, false)
    }
  }
}

const CHAIN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PATH_UNAVAILABLE = 'The path for this event could not be assembled right now'

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

  // A chain's full path, by chain id — what a replay link opens (`replay_of`
  // and `replayed_as` name chains, not events). Admins only, bodies included.
  app.get('/chain/:chainId/path', { preHandler: requireAdmin }, async (req, reply) => {
    const { chainId } = req.params as { chainId: string }
    if (!CHAIN_ID_RE.test(chainId)) return reply.code(400).send({ error: 'Invalid chain id' })
    try {
      const path = await buildChainPath(chainId, { isAdmin: true })
      if (!path) return reply.code(404).send({ error: 'Chain not found' })
      return reply.send({ data: path })
    } catch (err) {
      req.log.warn({ err, chainId }, 'integration chain path failed')
      const detail = err instanceof Error ? err.message : String(err)
      return reply.code(503).send({ error: `${PATH_UNAVAILABLE}: ${detail}` })
    }
  })

  // An event's full path, bodies included (admins only).
  app.get('/:source/:id/path', { preHandler: requireAdmin }, async (req, reply) => {
    const { source, id } = req.params as { source: string; id: string }
    try {
      const path = await buildEventPath(source, id, { isAdmin: true })
      if (!path) return reply.code(404).send({ error: 'Event not found' })
      return reply.send({ data: path })
    } catch (err) {
      req.log.warn({ err, source, id }, 'integration event path failed')
      const detail = err instanceof Error ? err.message : String(err)
      return reply.code(503).send({ error: `${PATH_UNAVAILABLE}: ${detail}` })
    }
  })

  // A record's integration activity: events whose chain touched the record,
  // plus events that name it directly. Readers of the record only.
  app.get('/record/:collection/:item', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }
    const admin = req.isAdmin === true
    if (!(admin || (await can(req.user!, 'read', collection).catch(() => false)))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const reader = admin ? null : readerFor(req)
    if (reader && !(await reader([{ collection, item }])).has(`${collection}:${item}`)) {
      return reply.code(404).send({ error: 'Record not found' })
    }
    const page = Math.max(Math.floor(Number((req.query as { page?: string }).page) || 1), 1)
    try {
      const chainIds = await chainsTouchingRecord(collection, item)
      let entries = await listEvents({
        limit: page * RECORD_PAGE + 1,
        record: { collection, item },
        chainIds,
        // Only machine accounts and API keys count as a record's inbound
        // integration activity; a person's own writes (and lock/heartbeat
        // traffic from their tokens) are not. Pushes a person set off still
        // show — they come through core:outbound.
        includePeople: false
      })
      const hasMore = entries.length > page * RECORD_PAGE
      entries = entries.slice((page - 1) * RECORD_PAGE, page * RECORD_PAGE)
      if (reader) {
        // A chain-linked event about another record stays hidden when the
        // viewer cannot open that record.
        const refs = entries
          .filter((e) => e.collection && e.item_id)
          .map((e) => ({ collection: e.collection as string, item: String(e.item_id) }))
        const allowed = refs.length ? await reader(refs) : new Set<string>()
        entries = entries
          .filter((e) => !e.collection || !e.item_id || allowed.has(`${e.collection}:${e.item_id}`))
          .map(redactEntry)
      }
      await fillEventLabels(entries)
      return reply.send({ data: { entries, page, has_more: hasMore } })
    } catch (err) {
      req.log.warn({ err, collection, item }, 'record integration activity failed')
      return reply
        .code(503)
        .send({ error: 'Integration activity for this record could not be loaded right now' })
    }
  })

  // One event's path, from a record: only events that concern the record,
  // no bodies, and steps on records the viewer cannot open dropped.
  app.get('/record/:collection/:item/path', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }
    const { source, id } = req.query as { source?: string; id?: string }
    if (!source || !id) return reply.code(400).send({ error: 'source and id are required' })
    const admin = req.isAdmin === true
    if (!(admin || (await can(req.user!, 'read', collection).catch(() => false)))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const reader = admin ? null : readerFor(req)
    const record = { collection, item }
    try {
      if (reader && !(await reader([record])).has(`${collection}:${item}`)) {
        return reply.code(404).send({ error: 'Record not found' })
      }
      const ev = await getEvent(source, id)
      if (!ev) return reply.code(404).send({ error: 'Event not found' })
      if (!eventConcernsRecord(ev, record, await chainsTouchingRecord(collection, item))) {
        return reply.code(404).send({ error: 'Event not found on this record' })
      }
      const path = await buildEventPath(source, id, {
        isAdmin: admin,
        canReadRecords: reader ?? undefined
      })
      if (!path) return reply.code(404).send({ error: 'Event not found' })
      if (reader) {
        // The path service filters steps, never the root: check it here.
        const rootRec = path.root.record
        if (rootRec?.collection && rootRec.item != null && rootRec.item !== '') {
          const key = `${rootRec.collection}:${rootRec.item}`
          if (
            !(await reader([{ collection: rootRec.collection, item: String(rootRec.item) }])).has(
              key
            )
          ) {
            return reply.code(404).send({ error: 'Event not found' })
          }
        }
        return reply.send({ data: redactRoot(path) })
      }
      return reply.send({ data: path })
    } catch (err) {
      req.log.warn({ err, collection, item, source, id }, 'record integration path failed')
      return reply.code(503).send({ error: PATH_UNAVAILABLE })
    }
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

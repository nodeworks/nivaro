import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { recordReadable, recordRefusal } from '../services/erp-record-gate.js'
import {
  inboundChangesForCaller,
  inboundRequestForActivity,
  inboundWritesForRecord
} from '../services/inbound-attribution.js'
import { outboundPreview, transitionPreflight } from '../services/integration-preview.js'
import { can, getAllowedFields } from '../services/permissions.js'
import { ADDENDUM_COLLECTION, resolvePipelineSubject } from '../services/pipeline-subject.js'
import { registerNoteSource } from '../services/record-notes.js'
import type { User } from '../types.js'

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether the caller's read policy on the collection covers every field. */
async function readsEveryField(user: User, collection: string): Promise<boolean> {
  const allowed = await getAllowedFields(user, 'read', collection).catch((): string[] => [])
  return allowed === null || allowed.includes('*')
}

function recordCollectionOk(collection: string): boolean {
  return COLLECTION_RE.test(collection) && !/^nivaro_/i.test(collection)
}

/**
 * The collection whose read permission decides who may ask about a pipeline
 * step. An addendum runs its own workflow instance, so its step buttons ask
 * about the addendum row; the addendum is part of its parent record, and
 * whoever may read the parent may read this. Null = not a record we answer for.
 */
async function pipelineGateCollection(collection: string, item: string): Promise<string | null> {
  if (collection !== ADDENDUM_COLLECTION) return recordCollectionOk(collection) ? collection : null
  const subject = await resolvePipelineSubject(collection, item).catch(() => null)
  if (!subject || subject.collection === ADDENDUM_COLLECTION) return null
  return recordCollectionOk(subject.collection) ? subject.collection : null
}

/**
 * What the record form shows about partner integrations:
 *
 *   GET /integration-preview/:collection/:item/outbound   (#615)
 *   GET /integration-preview/:collection/:item/preflight?transition_id=  (#616)
 *   GET /inbound-attribution/activity/:id/request         (#617)
 *   GET /inbound-attribution/changes?caller=k12|u<uuid>   (#609, admin)
 *
 * and the Notes-thread source that names inbound writers (#609).
 */
export async function recordIntegrationsRoutes(app: FastifyInstance) {
  registerNoteSource({
    key: 'inbound-writes',
    machine: true,
    async load({ collection, item, cap }) {
      const writes = await inboundWritesForRecord(collection, item, cap).catch(() => [])
      return writes.map((w) => ({
        id: `inbound:${w.activity_id}`,
        source: 'inbound' as const,
        label: w.caller.name,
        text: w.sentence,
        user: null,
        created_at: w.at,
        context:
          w.caller.kind === 'api_key'
            ? 'API key'
            : w.caller.kind === 'token'
              ? 'Access token'
              : 'Integration account',
        origin: 'integration' as const,
        inbound: {
          activity_id: w.activity_id,
          caller_key: w.caller.key,
          caller_kind: w.caller.kind,
          fields: w.fields
        }
      }))
    }
  })

  app.get<{ Params: { collection: string; item: string } }>(
    '/integration-preview/:collection/:item/outbound',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params
      if (!recordCollectionOk(collection))
        return reply.code(400).send({ error: 'Not a valid collection' })
      // The record itself must be visible to the caller — a collection-level
      // read let anyone render the payload of a record outside their scope.
      const refusal = await recordRefusal(req, collection, item, 'read')
      if (refusal) return reply.code(refusal.code).send(refusal.body)
      const data = await outboundPreview(collection, item, req.user?.id ?? null)
      if (!req.isAdmin && !(await readsEveryField(req.user!, collection))) {
        // The payload is built from the record's fields (and lookups) whatever
        // the caller's field policy says, so a field-limited reader sees which
        // values would change, not the values themselves.
        for (const g of data.integrations) {
          g.changes = g.changes.map((c) => ({ ...c, from: null, to: null }))
        }
      }
      return reply.send({ data })
    }
  )

  app.get<{
    Params: { collection: string; item: string }
    Querystring: { transition_id?: string }
  }>(
    '/integration-preview/:collection/:item/preflight',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params
      const transitionId = String(req.query.transition_id ?? '')
      if (!transitionId) return reply.code(400).send({ error: 'transition_id is required' })
      const gate = await pipelineGateCollection(collection, item)
      if (!gate) return reply.code(400).send({ error: 'Not a valid collection' })
      // assertInstanceAccess resolves an addendum to its parent record itself.
      const refusal = await recordRefusal(req, collection, item, 'read')
      if (refusal) return reply.code(refusal.code).send(refusal.body)
      const data = await transitionPreflight(collection, item, transitionId, req.user?.id ?? null)
      if (!data) return reply.code(404).send({ error: 'No such transition for this record' })
      return reply.send({ data })
    }
  )

  app.get<{ Params: { id: string } }>(
    '/inbound-attribution/activity/:id/request',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Bad id' })
      const found = await inboundRequestForActivity(id)
      if (!found) return reply.code(404).send({ error: 'Not found' })
      const collection = String(found.activity.collection ?? '')
      // A record write: its readers may see what wrote it. Anything else
      // (a system table) is for administrators.
      // The record must be visible to them, not just its collection.
      const item = String(found.activity.item ?? '')
      const allowed =
        req.isAdmin ||
        (recordCollectionOk(collection) &&
          item !== '' &&
          (await can(req.user!, 'read', collection)) &&
          (await recordReadable(req, collection, item)))
      if (!allowed) return reply.code(403).send({ error: 'Forbidden' })
      const r = found.request
      return reply.send({
        data: r
          ? {
              ...r,
              // The body may name fields the viewer cannot read.
              body: req.isAdmin ? r.body : null,
              request_body: req.isAdmin ? r.request_body : null,
              body_withheld: !req.isAdmin && r.body != null,
              can_replay: !!req.isAdmin
            }
          : null
      })
    }
  )

  app.get<{
    Querystring: {
      caller?: string
      hours?: string
      page?: string
      limit?: string
      collection?: string
    }
  }>('/inbound-attribution/changes', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query
    if (!q.caller) return reply.code(400).send({ error: 'caller is required' })
    const hours = Math.min(Math.max(Number(q.hours) || 168, 1), 24 * 90)
    const collection = q.collection && recordCollectionOk(q.collection) ? q.collection : null
    const data = await inboundChangesForCaller({
      caller: q.caller,
      since: new Date(Date.now() - hours * 3600_000),
      page: Number(q.page) || 1,
      limit: Number(q.limit) || 50,
      collection
    })
    return reply.send({ data: data.rows, has_more: data.has_more, stamped: data.stamped })
  })
}

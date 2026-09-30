import type { FastifyInstance } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import {
  inboundChangesForCaller,
  inboundRequestForActivity,
  inboundWritesForRecord
} from '../services/inbound-attribution.js'
import { outboundPreview, transitionPreflight } from '../services/integration-preview.js'
import { can } from '../services/permissions.js'
import { registerNoteSource } from '../services/record-notes.js'

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function recordCollectionOk(collection: string): boolean {
  return COLLECTION_RE.test(collection) && !/^nivaro_/i.test(collection)
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
      if (!(await can(req.user!, 'read', collection)))
        return reply.code(403).send({ error: 'Forbidden' })
      const data = await outboundPreview(collection, item, req.user?.id ?? null)
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
      if (!recordCollectionOk(collection))
        return reply.code(400).send({ error: 'Not a valid collection' })
      if (!transitionId) return reply.code(400).send({ error: 'transition_id is required' })
      if (!(await can(req.user!, 'read', collection)))
        return reply.code(403).send({ error: 'Forbidden' })
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
      const allowed =
        req.isAdmin ||
        (recordCollectionOk(collection) && (await can(req.user!, 'read', collection)))
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

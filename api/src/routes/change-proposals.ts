import type { FastifyInstance, FastifyReply } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import {
  acceptProposal,
  createProposal,
  declineProposal,
  ProposalError,
  proposableFields,
  proposalNotes,
  proposalsForRecord,
  proposeEligibility,
  withdrawProposal
} from '../services/change-proposals.js'
import { isAdminRole } from '../services/permissions.js'
import { registerNoteSource } from '../services/record-notes.js'

/**
 * /api/change-proposals — propose a change on a record locked after approval
 * (services/change-proposals.ts). Every route judges the record as the caller.
 *
 *   GET  /record/:collection/:item     what the caller may do here + the record's proposals
 *   POST /record/:collection/:item     { values: {field: value}, reason } → a pending proposal
 *   POST /:id/accept                   step owner (not the proposer) or admin; writes as them
 *   POST /:id/decline                  { note } — same deciders
 *   POST /:id/withdraw                 the proposer
 */

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
const ITEM_RE = /^[A-Za-z0-9_\-:.]{1,100}$/

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof ProposalError)
    return reply
      .code(err.statusCode)
      .send({ error: err.message, ...(err.code ? { code: err.code } : {}) })
  throw err
}

function badTarget(collection: string, item: string): string | null {
  if (!COLLECTION_RE.test(collection) || /^(nivaro_|directus_)/i.test(collection))
    return 'Not a valid collection'
  if (!ITEM_RE.test(item)) return 'Not a valid record id'
  return null
}

export async function changeProposalRoutes(app: FastifyInstance) {
  registerNoteSource({
    key: 'change-proposals',
    async load({ collection, item, viewerId, cap }) {
      return (await proposalNotes(collection, item, viewerId, cap).catch(() => [])) as never
    }
  })

  app.get<{ Params: { collection: string; item: string } }>(
    '/record/:collection/:item',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params
      const bad = badTarget(collection, item)
      if (bad) return reply.code(400).send({ error: bad })
      const user = req.user!
      const workspaceId = req.workspaceId ?? undefined
      const { readOne } = await import('../services/items.js')
      const row = await readOne(user, collection, item, workspaceId, ['id']).catch(() => null)
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const isAdmin = !!req.isAdmin || (await isAdminRole(user))
      const elig = await proposeEligibility(user, isAdmin, collection, item, workspaceId)
      if (!elig.enabled)
        return reply.send({ data: { enabled: false, can_propose: false, proposals: [] } })
      const [listed, proposals] = await Promise.all([
        elig.can_propose
          ? proposableFields(user, collection, { isAdmin: false, openFields: elig.open_fields })
          : Promise.resolve([]),
        proposalsForRecord(user, isAdmin, collection, item, { workspaceId })
      ])
      // What each field holds now, read as the caller (the dialog shows it beside the input).
      let fields = listed as Array<(typeof listed)[number] & { current?: unknown }>
      if (listed.length > 0) {
        const now = (await readOne(user, collection, item, workspaceId, [
          'id',
          ...listed.map((f) => f.field)
        ]).catch(() => null)) as Record<string, unknown> | null
        fields = listed.map((f) => ({ ...f, current: now?.[f.field] ?? null }))
      }
      return reply.send({
        data: {
          enabled: true,
          locked: elig.locked,
          step: elig.step ?? null,
          can_propose: elig.can_propose && fields.length > 0,
          ...(elig.can_propose && fields.length === 0
            ? { reason: 'There is nothing on this record you could change.' }
            : elig.reason
              ? { reason: elig.reason }
              : {}),
          fields,
          proposals
        }
      })
    }
  )

  app.post<{
    Params: { collection: string; item: string }
    Body: { values?: Record<string, unknown>; reason?: string }
  }>('/record/:collection/:item', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params
    const bad = badTarget(collection, item)
    if (bad) return reply.code(400).send({ error: bad })
    const body = req.body ?? {}
    if (body.values != null && (typeof body.values !== 'object' || Array.isArray(body.values)))
      return reply.code(400).send({ error: 'values must be an object of field → value' })
    try {
      const out = await createProposal(
        req,
        collection,
        item,
        { values: body.values ?? {}, reason: String(body.reason ?? '') },
        app
      )
      return reply.code(201).send({ data: out })
    } catch (err) {
      return refuse(reply, err)
    }
  })

  const idOf = (raw: string) => {
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  app.post<{ Params: { id: string } }>(
    '/:id/accept',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = idOf(req.params.id)
      if (!id) return reply.code(404).send({ error: 'Not found' })
      try {
        return reply.send({ data: await acceptProposal(app, req, id) })
      } catch (err) {
        return refuse(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/:id/decline',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = idOf(req.params.id)
      if (!id) return reply.code(404).send({ error: 'Not found' })
      try {
        return reply.send({ data: await declineProposal(app, req, id, req.body?.note) })
      } catch (err) {
        return refuse(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/:id/withdraw',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = idOf(req.params.id)
      if (!id) return reply.code(404).send({ error: 'Not found' })
      try {
        return reply.send({ data: await withdrawProposal(req, id) })
      } catch (err) {
        return refuse(reply, err)
      }
    }
  )
}

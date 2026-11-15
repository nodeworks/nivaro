import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { causesForViewer, defaultCauseDeps, readDerivedCauses } from '../services/derived-causes.js'
import { unreadableFileIds } from '../services/file-access.js'
import { readProcessingStates } from '../services/file-processing.js'
import { clampSince, recordChangesSince } from '../services/move-unseen.js'
import { recordCard } from '../services/record-card.js'
import { recordVisibleTo } from '../services/revision-access.js'

/**
 * Small reads a record page and its links make about the record's CURRENT state (rt3):
 *
 *   GET /api/records/:collection/:id/unseen?since=<iso>  — what others changed since the
 *       mover's page read the record (the move confirm lists what they have not seen, #14)
 *   GET /api/records/:collection/:id/card                — hover card: name, step, owners,
 *       key amounts (#16)
 *   GET /api/files/processing?ids=a,b                    — file processing status (#17)
 *   GET /api/records/:collection/:id/derived             — why derived values moved (rt9 #10)
 *
 * Every one reads AS THE CALLER: a record they cannot read is 404 (never "exists but hidden"),
 * values are cut to their field list, a file they cannot read is left out of the answer.
 */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ID = /^[A-Za-z0-9_.:-]{1,64}$/
const FILE_IDS_MAX = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function recordGlanceRoutes(app: FastifyInstance) {
  app.get<{
    Params: { collection: string; id: string }
    Querystring: { since?: string; fields_since?: string }
  }>('/records/:collection/:id/unseen', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, id } = req.params
    if (!NAME.test(collection) || !ID.test(id))
      return reply.code(400).send({ error: 'Name a record' })
    const since = clampSince(req.query.since)
    if (!since) return reply.code(400).send({ error: 'since must be a time' })
    if (/^(nivaro_|directus_)/i.test(collection) || !(await recordVisibleTo(req, collection, id)))
      return reply.code(404).send({ error: 'Not found' })
    const data = await recordChangesSince(req.user!, !!req.isAdmin, collection, id, since, {
      fieldsSince: clampSince(req.query.fields_since)
    })
    return reply.send({ data })
  })

  app.get<{ Params: { collection: string; id: string } }>(
    '/records/:collection/:id/card',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!NAME.test(collection) || !ID.test(id))
        return reply.code(400).send({ error: 'Name a record' })
      const card = await recordCard(req.user!, collection, id, req.workspaceId ?? undefined)
      if (!card) return reply.code(404).send({ error: 'Not found' })
      return reply.send({ data: card })
    }
  )

  // rt9 #10: "Moved 2 days later because PO due date changed" — the notes the app kept when it
  // re-derived a stored value, judged for the caller (services/derived-causes.ts).
  app.get<{ Params: { collection: string; id: string } }>(
    '/records/:collection/:id/derived',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, id } = req.params
      if (!NAME.test(collection) || !ID.test(id))
        return reply.code(400).send({ error: 'Name a record' })
      if (/^(nivaro_|directus_)/i.test(collection)) return reply.send({ data: [] })
      const stored = await readDerivedCauses(collection, id)
      // Nothing kept: the same empty answer for a record that does not exist or is hidden.
      if (stored.length === 0) return reply.send({ data: [] })
      const { readOne } = await import('../services/items.js')
      const fields = [...new Set(stored.map((c) => c.field))]
      const row = (await readOne(req.user!, collection, id, req.workspaceId ?? undefined, [
        'id',
        ...fields
      ]).catch(() => null)) as Record<string, unknown> | null
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const data = await causesForViewer(collection, row, stored, await defaultCauseDeps(req.user!))
      return reply.send({ data })
    }
  )

  app.get<{ Querystring: { ids?: string } }>(
    '/files/processing',
    { preHandler: requireAuth },
    async (req, reply) => {
      const asked = [
        ...new Set(
          String(req.query.ids ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => UUID.test(s))
        )
      ].slice(0, FILE_IDS_MAX)
      if (asked.length === 0) return reply.send({ data: {} })
      const hidden = new Set((await unreadableFileIds(asked, req)).map((i) => i.toLowerCase()))
      const ids = asked.filter((i) => !hidden.has(i.toLowerCase()))
      const states = await readProcessingStates(ids)
      const data: Record<string, { status: string; steps: string[] }> = {}
      for (const [fid, s] of Object.entries(states))
        data[fid] = { status: s.status, steps: s.steps }
      return reply.send({ data })
    }
  )
}

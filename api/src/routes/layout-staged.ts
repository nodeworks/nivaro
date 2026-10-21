import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { markConfigRead } from '../services/config-live.js'
import {
  clearStaged,
  parseStagedBody,
  readStaged,
  StagedError,
  stagedAvailable,
  stagedByOthers,
  writeStaged
} from '../services/layout-staged.js'

/**
 * Staged layout edits (#2589), registered by collectionLayoutsRoutes under
 * /collection-layouts, admin only:
 *  - GET  /:id/staged        my draft on this layout + who else has one (names, counts)
 *  - POST /:id/staged        { steps, base_rev } keeps my unsaved steps
 *  - POST /:id/staged/clear  drops them (Save, Discard)
 * A draft changes nothing anyone else reads, so the writes are POSTs that mark
 * themselves config reads: no metadata flush, no config:update push on every
 * keystroke (the hook only honours that mark on POST).
 */

const isRowId = (v: string) => /^\d{1,10}$/.test(v)
const UNAVAILABLE = 'Staged layout edits need migration 316'

export async function layoutStagedRoutes(app: FastifyInstance) {
  app.get('/:id/staged', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await stagedAvailable())) return reply.send({ data: null, others: [], available: false })
    const uid = req.user!.id
    const [mine, others] = await Promise.all([
      readStaged(Number(id), uid),
      stagedByOthers(Number(id), uid)
    ])
    return reply.send({ data: mine, others, available: true })
  })

  app.post('/:id/staged', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await stagedAvailable())) return reply.code(503).send({ error: UNAVAILABLE })
    let parsed: ReturnType<typeof parseStagedBody>
    try {
      parsed = parseStagedBody(req.body)
    } catch (err) {
      if (err instanceof StagedError) return reply.code(err.status).send({ error: err.message })
      throw err
    }
    const layout = (await db('nivaro_collection_layouts')
      .where({ id: Number(id) })
      .first('id')) as { id: number } | undefined
    if (!layout) return reply.code(404).send({ error: 'Not found' })
    const row = await writeStaged(Number(id), req.user!.id, parsed)
    return reply.send({ data: row })
  })

  app.post('/:id/staged/clear', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    if (await stagedAvailable()) await clearStaged(Number(id), req.user!.id)
    return reply.send({ data: { cleared: true } })
  })
}

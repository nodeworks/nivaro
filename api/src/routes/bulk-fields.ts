import type { FastifyInstance } from 'fastify'
import { builtinAllowed } from '../services/bulk-actions.js'

const MAX_IDS = 1000

/**
 * POST /items/:collection/bulk-fields {ids} (#2722) — what the bulk "Update
 * field" action offers for a selection, as the caller: the forms the records
 * open with (sections and placements as the caller sees them) and, per field
 * the caller may update, how many records show it and how many lock it, with
 * the form's reason. A POST only because the ids ride the body; it writes
 * nothing. Registered inside the items routes (their auth + workspace hooks).
 */
export function registerBulkFieldsRoute(app: FastifyInstance): void {
  app.post('/:collection/bulk-fields', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { ids } = (req.body ?? {}) as { ids?: unknown }
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids array required' })
    if (!(await builtinAllowed(collection, 'update-field', req)))
      return reply.code(403).send({ error: 'Bulk update is not available to you here' })
    const clean = ids
      .filter((v) => (typeof v === 'string' || typeof v === 'number') && String(v).length <= 64)
      .slice(0, MAX_IDS) as Array<string | number>
    try {
      const { bulkFieldsReport } = await import('../services/form-field-gate.js')
      const data = await bulkFieldsReport({
        user: req.user!,
        isAdmin: !!req.isAdmin,
        collection,
        ids: clean,
        workspaceId: req.workspaceId ?? undefined
      })
      return { data: { ...data, capped: ids.length > MAX_IDS } }
    } catch (e) {
      const name = (e as Error).name
      if (name === 'ForbiddenError') return reply.code(403).send({ error: 'Forbidden' })
      if (name === 'CollectionNotFoundError') return reply.code(404).send({ error: 'Not found' })
      throw e
    }
  })
}

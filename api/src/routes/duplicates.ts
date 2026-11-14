import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { duplicateConfig, fieldsFor, findDuplicates } from '../services/duplicate-check.js'
import { getAllowedFields } from '../services/permissions.js'

/**
 * Likely duplicates while a record is being created (services/duplicate-check.ts).
 *
 *   GET /api/duplicates/:collection
 *     → { enabled, fields, block_exact, close, source, reason?, label } — what the form
 *       watches. `fields` are narrowed to what the caller may read.
 *   GET /api/duplicates/:collection/check?values={"name":"MX480"}&exclude=<id>
 *     → { enabled, fields, block_exact, close, label, matches: {field: [{id, label,
 *       value, match: 'exact'|'close', score}]}, partial? } — judged AS THE CALLER.
 *
 * Signed in; a person who may not read the collection gets enabled:false / no matches.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export async function duplicateRoutes(app: FastifyInstance) {
  app.get('/:collection', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    const user = req.user
    if (!user) return reply.code(401).send({ error: 'Sign in first' })
    const cfg = await duplicateConfig(collection)
    if (!cfg) return reply.send({ data: { enabled: false, fields: [], block_exact: false } })
    const allowed = await getAllowedFields(user, 'read', collection).catch(() => [] as string[])
    const fields = fieldsFor(cfg, allowed)
    return reply.send({
      data: {
        enabled: fields.length > 0,
        fields,
        block_exact: cfg.block_exact,
        close: cfg.close,
        source: cfg.source,
        // The settings card explains why auto mode is off; only administrators see it.
        ...(req.isAdmin ? { reason: cfg.reason ?? null, rows: cfg.rows } : {}),
        label: cfg.label
      }
    })
  })

  app.get('/:collection/check', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'Invalid collection' })
    const user = req.user
    if (!user) return reply.code(401).send({ error: 'Sign in first' })
    const q = req.query as { values?: string; exclude?: string; limit?: string }
    let values: Record<string, unknown> = {}
    if (q.values) {
      if (q.values.length > 4000) return reply.code(400).send({ error: 'values is too long' })
      try {
        const parsed = JSON.parse(q.values) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          values = parsed as Record<string, unknown>
      } catch {
        return reply.code(400).send({ error: 'values must be a JSON object' })
      }
    }
    const answer = await findDuplicates(user, collection, values, {
      excludeId: q.exclude || null,
      limit: q.limit ? Number(q.limit) : undefined,
      req
    })
    return reply.send({ data: answer })
  })
}

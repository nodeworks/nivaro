import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { recordRefusal } from '../services/erp-record-gate.js'
import { type LineDraft, partnerNeeds } from '../services/partner-needs/index.js'
import { can } from '../services/permissions.js'

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_VALUES = 400
const MAX_RELATIONS = 20
const MAX_ROWS = 500

/**
 * POST /api/partner-needs/:collection  {item?, values?, lines?}  (idea 43)
 *
 * Which fields a partner push at a later manual move will need, for the values the record
 * form holds now (unsaved edits and lines included) — services/partner-needs. A POST only
 * because it carries the form's values; it reads, never writes (exempt from the maintenance
 * freeze and allowed for sandbox keys). The record must be readable by the caller (a new
 * record: the caller may create in the collection).
 */
export async function partnerNeedsRoutes(app: FastifyInstance) {
  app.post<{
    Params: { collection: string }
    Body: { item?: unknown; values?: unknown; lines?: unknown }
  }>('/:collection', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.params
    if (!COLLECTION_RE.test(collection) || /^(nivaro|directus)_/i.test(collection))
      return reply.code(400).send({ error: 'Not a valid collection' })
    const body = req.body ?? {}
    const rawItem = body.item
    const item =
      rawItem == null || rawItem === '' || rawItem === 'new' ? null : String(rawItem).slice(0, 64)
    if (item) {
      const refusal = await recordRefusal(req, collection, item, 'read')
      if (refusal) return reply.code(refusal.code).send(refusal.body)
    } else if (!req.isAdmin && !(req.user && (await can(req.user, 'create', collection)))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const values: Record<string, unknown> = {}
    if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) {
      for (const [k, v] of Object.entries(body.values as Record<string, unknown>).slice(
        0,
        MAX_VALUES
      ))
        values[k] = v
    }
    const lines: Record<string, LineDraft[]> = {}
    if (body.lines && typeof body.lines === 'object' && !Array.isArray(body.lines)) {
      for (const [rel, rows] of Object.entries(body.lines as Record<string, unknown>).slice(
        0,
        MAX_RELATIONS
      )) {
        if (!Array.isArray(rows)) continue
        lines[rel] = rows
          .slice(0, MAX_ROWS)
          .filter(
            (r): r is { key: unknown; values: unknown } =>
              !!r && typeof r === 'object' && 'key' in (r as object)
          )
          .map((r) => ({
            key: String(r.key),
            values:
              r.values && typeof r.values === 'object' && !Array.isArray(r.values)
                ? (r.values as Record<string, unknown>)
                : {}
          }))
      }
    }

    const data = await partnerNeeds(
      { collection, item, values, lines },
      { user: req.user ?? null, isAdmin: !!req.isAdmin, workspaceId: req.workspaceId ?? undefined }
    )
    // Read as the caller: a record they cannot read is not there.
    if (!data) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data })
  })
}

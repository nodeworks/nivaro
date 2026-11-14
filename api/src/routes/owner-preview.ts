import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { markConfigRead } from '../services/config-live.js'
import { readOne } from '../services/items.js'
import { type DraftOwnerGroupInput, previewRecordOwners } from '../services/owner-preview.js'
import { recordLabelsAsViewer } from '../services/record-labels-as-viewer.js'

/**
 * POST /api/pipelines/:id/owner-preview — "Try a record" in the Owner Matrix.
 * Body: { collection, item, draft?: DraftOwnerGroupInput[] } (only the groups
 * the matrix draft changed, added or removed). Admin, read-only: the record is
 * read AS the admin through the items service first (null = 404), then both
 * answers come from the real owner resolver (services/owner-preview.ts).
 */

const OPS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'notin'])
const MAX_DRAFT_GROUPS = 2000
const ID_RE = /^[A-Za-z0-9:_-]{1,64}$/

type Scalar = string | number | boolean | null

function scalar(v: unknown): v is Scalar {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

/** The draft as the editor sent it, checked; null = refused (the reason). */
export function parseDraft(raw: unknown): DraftOwnerGroupInput[] | string {
  if (raw == null) return []
  if (!Array.isArray(raw)) return 'draft must be a list of owner groups'
  if (raw.length > MAX_DRAFT_GROUPS) return `draft has more than ${MAX_DRAFT_GROUPS} groups`
  const out: DraftOwnerGroupInput[] = []
  for (const g of raw as Array<Record<string, unknown>>) {
    if (!g || typeof g !== 'object') return 'draft group must be an object'
    const id = String(g.id ?? '')
    const state = String(g.state ?? '')
    if (!ID_RE.test(id) || !ID_RE.test(state)) return 'draft group needs an id and a state'
    const filtersRaw = g.filters ?? []
    if (!Array.isArray(filtersRaw) || filtersRaw.length > 20)
      return 'draft group filters are invalid'
    const filters = []
    for (const f of filtersRaw as Array<Record<string, unknown>>) {
      const field = String(f?.field ?? '')
      const op = String(f?.op ?? '')
      if (!field || field.length > 255 || !OPS.has(op)) return 'draft group filters are invalid'
      if (!scalar(f.value ?? null) && !Array.isArray(f.value))
        return 'draft group filters are invalid'
      const idv = f.id_value
      filters.push({
        field,
        op: op as 'eq',
        value: f.value ?? null,
        ...(typeof idv === 'number' || typeof idv === 'string' ? { id_value: idv as number } : {})
      })
    }
    const users = Array.isArray(g.users) ? g.users.map(String).slice(0, 500) : []
    const teams = Array.isArray(g.teams)
      ? g.teams
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
          .slice(0, 100)
      : []
    if (users.some((u) => !ID_RE.test(u))) return 'draft group users are invalid'
    out.push({
      id,
      state,
      name: typeof g.name === 'string' ? g.name.slice(0, 255) : null,
      filters,
      is_default: g.is_default === true,
      priority: Number.isFinite(Number(g.priority)) ? Number(g.priority) : 0,
      users,
      teams,
      removed: g.removed === true
    })
  }
  return out
}

export async function ownerPreviewRoutes(app: FastifyInstance): Promise<void> {
  app.post('/:id/owner-preview', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { id: templateId } = req.params as { id: string }
    const body = (req.body ?? {}) as { collection?: unknown; item?: unknown; draft?: unknown }
    const collection = typeof body.collection === 'string' ? body.collection : ''
    const item = body.item == null ? '' : String(body.item)
    if (!collection || !item)
      return reply.code(400).send({ error: 'collection and item are required' })

    const binding = (await db('nivaro_workflow_bindings')
      .where({ template: templateId, collection })
      .first('id')) as { id: number } | undefined
    if (!binding)
      return reply.code(404).send({ error: 'That collection is not bound to this pipeline' })

    const draft = parseDraft(body.draft)
    if (typeof draft === 'string') return reply.code(400).send({ error: draft })

    // The record, read as the admin (restrict User Scopes still bind admins).
    const row = await readOne(req.user!, collection, item, req.workspaceId ?? undefined, [
      'id'
    ]).catch(() => null)
    if (!row) return reply.code(404).send({ error: 'Record not found' })

    const preview = await previewRecordOwners({ templateId, collection, item, draft })
    const labels = await recordLabelsAsViewer(req.user!, [{ collection, id: item }]).catch(
      () => ({}) as Record<string, string>
    )
    return reply.send({
      data: { ...preview, label: labels[`${collection}:${item}`] ?? `#${item}` }
    })
  })
}

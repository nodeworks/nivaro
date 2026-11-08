import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import {
  COUNT_ALL_MAX_IDS,
  countAllFigures,
  findCountAllColumn,
  parentTokens,
  resolveCountAllMatch,
  scalarOf
} from '../services/catalog-related-aggregate.js'
import { getRelations } from '../services/collections.js'
import { applyFilterToQuery, readOne } from '../services/items.js'
import { roleAllows } from '../services/layout-patch.js'
import { can } from '../services/permissions.js'
import { resolveLayout } from './collection-layouts.js'

/** The layouts this caller's record (or a new one) opens with: the resolved
 *  record form, the form it extends, and the active Summary forms their role
 *  may open. Inactive / other-role forms never answer. */
export async function layoutsForCaller(
  req: FastifyRequest,
  collection: string,
  item: string | null
): Promise<number[]> {
  const { row } = await resolveLayout({
    collection,
    item,
    role: req.user?.role ?? null,
    isAdmin: !!req.isAdmin,
    userId: req.user?.id ? String(req.user.id) : null
  })
  const ids = new Set<number>()
  if (row?.id != null) ids.add(Number(row.id))
  if (row?.parent_layout_id != null) ids.add(Number(row.parent_layout_id))
  const summaries = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'summary', is_active: true })
    .select('*')) as Record<string, unknown>[]
  for (const s of summaries)
    if (roleAllows(s as never, req.user?.role ?? null, !!req.isAdmin)) ids.add(Number(s.id))
  return [...ids]
}

/**
 * The `$parent` values for the filter, never trusted from the request as such:
 * a saved record is read AS THE CALLER and the values are its own (null = they
 * cannot see it); on a new form each value must be a record of the field's
 * related collection the caller can read — what their picker could offer.
 * Null = refuse.
 */
export async function parentValuesForCaller(
  req: FastifyRequest,
  collection: string,
  record: string,
  tokens: string[],
  supplied: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const user = req.user!
  const out: Record<string, unknown> = {}
  if (record !== 'new') {
    const row = (await readOne(user, collection, record, req.workspaceId ?? undefined).catch(
      () => null
    )) as Record<string, unknown> | null
    if (!row) return null
    for (const t of tokens) out[t] = scalarOf(row[t])
    return out
  }
  const rels = await getRelations(collection)
  for (const t of tokens) {
    const v = scalarOf(supplied[t])
    if (v === null || v === undefined || v === '') {
      out[t] = null
      continue
    }
    if (!['string', 'number'].includes(typeof v)) return null
    const rel = rels.find((r) => r.many_collection === collection && r.many_field === t)
    if (!rel?.one_collection) return null
    const seen = await readOne(
      user,
      rel.one_collection,
      v as string | number,
      req.workspaceId ?? undefined
    ).catch(() => null)
    if (!seen) return null
    out[t] = v
  }
  return out
}

/**
 * GET /api/catalog-related/count-all?collection=&field=&key=&record=<id|new>&parent=<json>&ids=1,2,3
 *
 * A catalog related column marked `count_all` by an administrator (army 11 a2
 * F3: "Open Orders" must read the same for everyone deciding on a request).
 * Answers `{data: {<item id>: <number>}}` for the asked ids only — the figure
 * over every matching row, not narrowed by the viewer's scope. Guards (army 11
 * API review #3): the column must be on a layout the caller's record resolves
 * to; `$parent` values come from that record read as the caller, or on a new
 * form only from records the caller can read; aggregate numbers only. A GET
 * (the client chunks ids) so it is a plain read for the freeze/sandbox guards.
 */
export async function catalogRelatedRoutes(app: FastifyInstance) {
  app.get('/catalog-related/count-all', { preHandler: authenticate }, async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Sign in first', code: 'UNAUTHENTICATED' })
    const q = (req.query ?? {}) as Record<string, string | undefined>
    const collection = String(q.collection ?? '')
    const field = String(q.field ?? '')
    const key = String(q.key ?? '')
    const record = String(q.record ?? '')
    if (!collection || !field || !key || !record)
      return reply.code(400).send({ error: 'collection, field, key and record are required' })
    if (!(await can(req.user, 'read', collection)))
      return reply.code(403).send({ error: 'You cannot read these records', code: 'FORBIDDEN' })
    const layoutIds = await layoutsForCaller(req, collection, record === 'new' ? null : record)
    const col = await findCountAllColumn(layoutIds, field, key)
    if (!col) return reply.code(404).send({ error: 'No such column', code: 'NOT_FOUND' })

    let supplied: Record<string, unknown> = {}
    if (q.parent) {
      try {
        const p = JSON.parse(q.parent)
        if (p && typeof p === 'object' && !Array.isArray(p)) supplied = p as Record<string, unknown>
      } catch {
        return reply.code(400).send({ error: 'parent must be JSON' })
      }
    }
    const tokens = [...parentTokens(col.match)]
    const parent = await parentValuesForCaller(req, collection, record, tokens, supplied)
    if (!parent) return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
    const filter = resolveCountAllMatch(col.match, parent)
    if (!filter) return reply.header('cache-control', 'no-store').send({ data: {} })

    const ids = String(q.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length > COUNT_ALL_MAX_IDS)
      return reply.code(400).send({ error: `At most ${COUNT_ALL_MAX_IDS} ids per call` })
    const data = await countAllFigures(col, filter, ids, (qb, f, c) =>
      // No user: the column is counted over every row — the point of count_all.
      applyFilterToQuery(qb as never, f, c)
    )
    return reply.header('cache-control', 'no-store').send({ data })
  })
}

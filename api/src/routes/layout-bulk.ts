import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { markConfigRead, nameConfigCollection } from '../services/config-live.js'
import {
  actionLabel,
  applyBulk,
  countFieldValues,
  deleteMacro,
  labelsFrom,
  listMacros,
  parseBulkAction,
  placedFields,
  previewBulk,
  saveMacro,
  type UndoItem,
  undoBulk
} from '../services/layout-bulk.js'

/**
 * One change on many layouts of a collection, under /collection-layouts:
 *
 *  - GET /bulk/fields?collection= — fields placed on its forms (the pickers).
 *  - POST /bulk/preview { collection, action, labels?, layout_ids? } — per
 *    form: change / same / skip, the sentences, and the rev the apply checks.
 *    Retire also counts the records that still hold a value.
 *  - POST /bulk/apply { …, revs } — each form through runLayoutOps (its own
 *    version + History entry); answers what Undo needs.
 *  - POST /bulk/undo { collection, items: [{layout_id, version_id, rev}] }
 *  - GET /macros, POST /macros, POST /macros/:id/delete — the caller's own
 *    recorded macros (nivaro_users.preferences.layout_macros).
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function readBody(req: FastifyRequest) {
  const body = (req.body ?? {}) as Record<string, unknown>
  const collection = typeof body.collection === 'string' ? body.collection : ''
  const only = Array.isArray(body.layout_ids)
    ? body.layout_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : undefined
  return { body, collection, only }
}

export async function layoutBulkRoutes(app: FastifyInstance) {
  // GET /bulk/fields?collection= — every field placed on a form, with how many forms hold it.
  app.get('/bulk/fields', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection || !IDENT.test(collection))
      return reply.code(400).send({ error: 'collection required' })
    return reply.send({ data: await placedFields(collection) })
  })

  app.post('/bulk/preview', { preHandler: requireAdmin }, async (req, reply) => {
    // A read under a metadata route: never flush the config caches for it.
    markConfigRead(req)
    const { body, collection, only } = readBody(req)
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'collection required' })
    const parsed = parseBulkAction(body.action)
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
    const L = labelsFrom(body.labels)
    const [forms, values] = await Promise.all([
      previewBulk(collection, parsed.action, L, only),
      parsed.action.kind === 'retire'
        ? countFieldValues(collection, parsed.action.field, req.user?.id)
        : Promise.resolve(null)
    ])
    return reply.send({ data: { label: actionLabel(parsed.action, L), forms, values } })
  })

  app.post('/bulk/apply', { preHandler: requireAdmin }, async (req, reply) => {
    const { body, collection, only } = readBody(req)
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'collection required' })
    const parsed = parseBulkAction(body.action)
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
    const L = labelsFrom(body.labels)
    const label = actionLabel(parsed.action, L)
    const revs =
      body.revs && typeof body.revs === 'object' && !Array.isArray(body.revs)
        ? (body.revs as Record<string, string>)
        : undefined
    const forms = await applyBulk({
      collection,
      action: parsed.action,
      L,
      note: label,
      userId: req.user?.id,
      only,
      revs
    })
    nameConfigCollection(req, collection)
    for (const f of forms)
      if (f.status === 'applied')
        await logActivity({
          action: 'update',
          user: req.user?.id,
          collection: 'nivaro_collection_layouts',
          item: String(f.layout_id),
          comment: `bulk change: ${label}`.slice(0, 500),
          req
        })
    return reply.send({ data: { label, forms } })
  })

  app.post('/bulk/undo', { preHandler: requireAdmin }, async (req, reply) => {
    const { body, collection } = readBody(req)
    if (!IDENT.test(collection)) return reply.code(400).send({ error: 'collection required' })
    if (!Array.isArray(body.items)) return reply.code(400).send({ error: 'items required' })
    const items: UndoItem[] = []
    for (const x of body.items as Array<Record<string, unknown>>) {
      const layoutId = Number(x?.layout_id)
      const versionId = Number(x?.version_id)
      if (!Number.isInteger(layoutId) || !Number.isInteger(versionId) || typeof x.rev !== 'string')
        return reply.code(400).send({ error: 'Each item needs layout_id, version_id and rev' })
      items.push({ layout_id: layoutId, version_id: versionId, rev: x.rev })
    }
    const forms = await undoBulk(collection, items, req.user?.id)
    nameConfigCollection(req, collection)
    for (const f of forms)
      if (f.status === 'restored')
        await logActivity({
          action: 'layout-version-restore',
          user: req.user?.id,
          collection: 'nivaro_collection_layouts',
          item: String(f.layout_id),
          comment: 'undo bulk change',
          req
        })
    return reply.send({ data: { forms } })
  })

  // Macros are the caller's own preferences, not layout config.
  app.get('/macros', { preHandler: requireAdmin }, async (req, reply) => {
    return reply.send({ data: await listMacros(String(req.user!.id)) })
  })

  app.post('/macros', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const r = await saveMacro(String(req.user!.id), (req.body ?? {}) as Record<string, unknown>)
    if ('error' in r) return reply.code(r.status).send({ error: r.error })
    return reply.send({ data: r.macro })
  })

  // A POST, not DELETE: only a POST can mark itself a non-config write (markConfigRead).
  app.post('/macros/:macroId/delete', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { macroId } = req.params as { macroId: string }
    const ok = await deleteMacro(String(req.user!.id), macroId)
    if (!ok) return reply.code(404).send({ error: 'Macro not found' })
    return reply.send({ data: { deleted: true } })
  })
}

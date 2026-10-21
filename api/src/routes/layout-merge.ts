import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { markConfigRead, nameConfigCollection } from '../services/config-live.js'
import { buildChangeLog, changeLogCsv, parsePeriod } from '../services/layout-change-log.js'
import { applyMerge, previewMerge, undoMerge } from '../services/layout-merge.js'

/**
 * Under /collection-layouts (admin-only, like the editor):
 *
 *  - POST /merge/preview { collection, keep_id, fold_id } — what merging the
 *    folded form into the kept one does: sections and fields added, the rules
 *    the differences become, who opens the merged form, a check of the newest
 *    records, and the revs the apply checks (#2661).
 *  - POST /merge/apply { …, revs: { keep, fold }, reason?, ticket? } — both
 *    forms through the editor's ops; answers what Undo needs.
 *  - POST /merge/undo { collection, keep: {layout_id, version_id, rev}, fold: {…} }
 *  - GET /change-log?from=&to=&collection=&format=csv — every layout change in
 *    a period: who, when, note, what it did (#2719). JSON by default.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function ids(req: FastifyRequest) {
  const body = (req.body ?? {}) as Record<string, unknown>
  const collection = typeof body.collection === 'string' ? body.collection : ''
  const keepId = Number(body.keep_id)
  const foldId = Number(body.fold_id)
  const ok =
    IDENT.test(collection) &&
    Number.isInteger(keepId) &&
    keepId > 0 &&
    Number.isInteger(foldId) &&
    foldId > 0
  return { body, collection, keepId, foldId, ok }
}

const undoItem = (v: unknown) => {
  const x = (v ?? {}) as Record<string, unknown>
  const layoutId = Number(x.layout_id)
  const versionId = Number(x.version_id)
  if (!Number.isInteger(layoutId) || !Number.isInteger(versionId) || typeof x.rev !== 'string')
    return null
  return { layout_id: layoutId, version_id: versionId, rev: x.rev }
}

export async function layoutMergeRoutes(app: FastifyInstance) {
  app.post('/merge/preview', { preHandler: requireAdmin }, async (req, reply) => {
    // A read under a metadata route: never flush the config caches for it.
    markConfigRead(req)
    const { collection, keepId, foldId, ok } = ids(req)
    if (!ok) return reply.code(400).send({ error: 'collection, keep_id and fold_id are required' })
    const r = await previewMerge(collection, keepId, foldId, req.user?.id)
    if ('error' in r) return reply.code(r.status).send({ error: r.error })
    return reply.send({ data: r })
  })

  app.post('/merge/apply', { preHandler: requireAdmin }, async (req, reply) => {
    const { body, collection, keepId, foldId, ok } = ids(req)
    if (!ok) return reply.code(400).send({ error: 'collection, keep_id and fold_id are required' })
    const revs = (body.revs ?? {}) as Record<string, unknown>
    if (typeof revs.keep !== 'string' || typeof revs.fold !== 'string')
      return reply.code(400).send({ error: 'revs.keep and revs.fold are required: preview first' })
    const r = await applyMerge({
      collection,
      keepId,
      foldId,
      revs: { keep: revs.keep, fold: revs.fold },
      userId: req.user?.id,
      reason: typeof body.reason === 'string' ? body.reason : null,
      ticket: typeof body.ticket === 'string' ? body.ticket : null
    })
    if ('error' in r) return reply.code(r.status).send({ error: r.error })
    nameConfigCollection(req, collection)
    const comment = `merged form ${r.fold.layout_id} into ${r.keep.layout_id}`
    for (const id of [r.keep.layout_id, r.fold.layout_id])
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_collection_layouts',
        item: String(id),
        comment,
        req
      })
    return reply.send({ data: r })
  })

  app.post('/merge/undo', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const collection = typeof body.collection === 'string' ? body.collection : ''
    const keep = undoItem(body.keep)
    const fold = undoItem(body.fold)
    if (!IDENT.test(collection) || !keep || !fold)
      return reply
        .code(400)
        .send({ error: 'collection, keep and fold (layout_id, version_id, rev) are required' })
    const forms = await undoMerge(collection, { keep, fold }, req.user?.id)
    nameConfigCollection(req, collection)
    for (const f of forms)
      if (f.status === 'restored')
        await logActivity({
          action: 'layout-version-restore',
          user: req.user?.id,
          collection: 'nivaro_collection_layouts',
          item: String(f.layout_id),
          comment: 'undo merge',
          req
        })
    return reply.send({ data: { forms } })
  })

  app.get('/change-log', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, unknown>
    const period = parsePeriod(q)
    if ('error' in period) return reply.code(400).send({ error: period.error })
    const log = await buildChangeLog(period, req.user?.id)
    if (q.format === 'csv') {
      const day = (d: Date) => d.toISOString().slice(0, 10)
      const last = new Date(period.to.getTime() - 86_400_000)
      const name = `layout-changes-${period.collection ?? 'all'}-${day(period.from)}-to-${day(last)}.csv`
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}"`)
        .send(changeLogCsv(log))
    }
    return reply.send({ data: log })
  })
}

import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { markConfigRead } from '../services/config-live.js'
import { snapshotToBundle } from '../services/layout-ops.js'
import {
  cancelSchedule,
  createSchedule,
  listSchedules,
  rescheduleSchedule,
  ScheduleError,
  schedulesAvailable
} from '../services/layout-schedules.js'
import {
  cleanVersionName,
  getLayoutVersion,
  nameCurrentLayoutState,
  nameLayoutVersion,
  sectionLastChanges,
  versionsHaveName
} from '../services/layout-versions.js'

/**
 * Layout history beyond the versions list (registered by collectionLayoutsRoutes
 * under /collection-layouts, admin only):
 *  - named versions (#2610): PATCH /:id/versions/:versionId {name}, POST /:id/versions/name
 *  - a version as an editor bundle for "Show on canvas" (#2591)
 *  - who last changed each section (#2611)
 *  - scheduled changes (#2590): /schedules, /:id/schedules
 * None of these change the layout itself, so the POSTs mark themselves config reads
 * (no metadata flush, no config:update push).
 */

const isRowId = (v: string) => /^\d{1,10}$/.test(v)

function scheduleFailure(reply: FastifyReply, err: unknown) {
  if (err instanceof ScheduleError) return reply.code(err.status).send({ error: err.message })
  throw err
}

const NEEDS_MIGRATION = 'Scheduled layout changes need migration 457'

export async function layoutHistoryRoutes(app: FastifyInstance) {
  // PATCH /collection-layouts/:id/versions/:versionId — { name } names a version so it is
  // kept beyond the rolling 30; name null/'' unnames it (it is pruned again like any other).
  app.patch('/:id/versions/:versionId', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, versionId } = req.params as { id: string; versionId: string }
    if (!isRowId(id) || !isRowId(versionId))
      return reply.code(400).send({ error: 'id must be a number' })
    if (!(await versionsHaveName()))
      return reply.code(503).send({ error: 'Named versions need migration 457' })
    const name = cleanVersionName((req.body as { name?: unknown } | null)?.name)
    const ok = await nameLayoutVersion(Number(id), Number(versionId), name)
    if (!ok) return reply.code(404).send({ error: 'Version not found' })
    await logActivity({
      action: 'layout-version-name',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: id,
      comment: name ? `named version ${versionId} "${name}"` : `unnamed version ${versionId}`,
      req
    })
    return reply.send({ data: { id: Number(versionId), name } })
  })

  // POST /collection-layouts/:id/versions/name — { name } keeps the layout as it is saved now.
  app.post('/:id/versions/name', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await versionsHaveName()))
      return reply.code(503).send({ error: 'Named versions need migration 457' })
    const name = cleanVersionName((req.body as { name?: unknown } | null)?.name)
    if (!name) return reply.code(400).send({ error: 'name required' })
    const row = await nameCurrentLayoutState(Number(id), name, req.user?.id)
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'layout-version-name',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: id,
      comment: `named the saved layout "${name}" (v${row.version})`,
      req
    })
    return reply.send({ data: { ...row, name } })
  })

  // GET /collection-layouts/:id/versions/:versionId/bundle — the version as the editor's
  // bundle (History's "Show on canvas" compares it with the draft).
  app.get('/:id/versions/:versionId/bundle', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, versionId } = req.params as { id: string; versionId: string }
    if (!isRowId(id) || !isRowId(versionId))
      return reply.code(400).send({ error: 'id must be a number' })
    const v = await getLayoutVersion(Number(id), Number(versionId))
    if (!v) return reply.code(404).send({ error: 'Version not found' })
    return reply.send({
      data: { bundle: snapshotToBundle(v, `version:${versionId}`), version: v.version }
    })
  })

  // GET /collection-layouts/:id/section-changes — { [section key]: { by, by_id, at } }
  app.get('/:id/section-changes', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    const data = await sectionLastChanges(Number(id))
    if (!data) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data })
  })

  // GET /collection-layouts/schedules?collection=&layout_id= — pending (and recently failed)
  // scheduled changes; empty until migration 457 has run.
  app.get('/schedules', { preHandler: requireAdmin }, async (req, reply) => {
    if (!(await schedulesAvailable())) return reply.send({ data: [], available: false })
    const q = req.query as { collection?: string; layout_id?: string }
    const data = await listSchedules({
      collection: typeof q.collection === 'string' && q.collection ? q.collection : undefined,
      layoutId: q.layout_id && isRowId(q.layout_id) ? Number(q.layout_id) : undefined
    })
    return reply.send({ data, available: true })
  })

  // POST /collection-layouts/:id/schedules — { ops, base_rev, run_at, note? }: the editor's
  // unsaved changes, applied by the layout-schedules cron at run_at.
  app.post('/:id/schedules', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { id } = req.params as { id: string }
    if (!isRowId(id)) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await schedulesAvailable())) return reply.code(503).send({ error: NEEDS_MIGRATION })
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      const row = await createSchedule({
        layoutId: Number(id),
        ops: body.ops,
        base_rev: body.base_rev,
        run_at: body.run_at,
        note: body.note,
        userId: req.user?.id ?? null
      })
      await logActivity({
        action: 'layout-schedule',
        user: req.user?.id,
        collection: 'nivaro_collection_layouts',
        item: id,
        comment: `scheduled ${row.op_count} change(s) for ${row.run_at}`,
        req
      })
      return reply.send({ data: row })
    } catch (err) {
      return scheduleFailure(reply, err)
    }
  })

  // PATCH /collection-layouts/schedules/:sid — { run_at } moves a pending change.
  app.patch('/schedules/:sid', { preHandler: requireAdmin }, async (req, reply) => {
    const { sid } = req.params as { sid: string }
    if (!isRowId(sid)) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await schedulesAvailable())) return reply.code(503).send({ error: NEEDS_MIGRATION })
    try {
      const row = await rescheduleSchedule(
        Number(sid),
        (req.body as { run_at?: unknown } | null)?.run_at,
        req.user?.id ?? null
      )
      if (!row) return reply.code(409).send({ error: 'This change is no longer waiting' })
      await logActivity({
        action: 'layout-schedule',
        user: req.user?.id,
        collection: 'nivaro_collection_layouts',
        item: String(row.layout_id),
        comment: `moved scheduled change ${sid} to ${row.run_at}`,
        req
      })
      return reply.send({ data: row })
    } catch (err) {
      return scheduleFailure(reply, err)
    }
  })

  // DELETE /collection-layouts/schedules/:sid — cancel a pending change (or dismiss a failed one).
  app.delete('/schedules/:sid', { preHandler: requireAdmin }, async (req, reply) => {
    const { sid } = req.params as { sid: string }
    if (!isRowId(sid)) return reply.code(400).send({ error: 'id must be a number' })
    if (!(await schedulesAvailable())) return reply.code(503).send({ error: NEEDS_MIGRATION })
    const row = (await db('nivaro_layout_schedules')
      .where({ id: Number(sid) })
      .first('layout_id')) as { layout_id: number } | undefined
    const ok = await cancelSchedule(Number(sid), req.user?.id ?? null)
    if (!ok) return reply.code(409).send({ error: 'This change is no longer waiting' })
    await logActivity({
      action: 'layout-schedule-cancel',
      user: req.user?.id,
      collection: 'nivaro_collection_layouts',
      item: row ? String(row.layout_id) : undefined,
      comment: `cancelled scheduled change ${sid}`,
      req
    })
    return reply.send({ data: { id: Number(sid), status: 'cancelled' } })
  })
}

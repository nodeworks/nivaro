import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  applyFix,
  type FindingRow,
  FixError,
  previewFix,
  undoFix
} from '../services/config-review/fixes.js'
import { REVIEW_FAMILIES, runConfigReview } from '../services/config-review/index.js'
import {
  APPLIED_KEEP,
  CLEANUP_BOUNDS,
  CLEANUP_DEFAULTS,
  decodeDetail,
  encodeDetail,
  publicDetail,
  undoableFix,
  validateCleanup
} from '../services/config-review/pure.js'
import { loadCleanupDefaults, saveCleanupDefaults } from '../services/config-review/settings.js'

/**
 * Config review (#1913 / #1961 / #2020 / #1999): the monthly report, its
 * one-click fixes (preview → apply → undo) and run-now. Admin-only. Findings
 * live in nivaro_config_health under the families review | cleanup | label.
 */

export const CONFIG_REVIEW_JOB = 'config-review-monthly'

/** Per process: one run at a time; the page polls `running`. */
let running: { since: string; by: string | null } | null = null
/** Per process: one fix at a time per finding (a double click must not apply twice). */
const busy = new Set<number>()

async function loadFinding(id: string): Promise<(FindingRow & { status: string }) | null> {
  const row = (await db('nivaro_config_health')
    .where('id', Number(id) || 0)
    .whereIn('family', REVIEW_FAMILIES)
    .first('id', 'family', 'code', 'subject', 'detail', 'status')) as
    | { id: number; family: string; code: string; subject: string; detail: string; status: string }
    | undefined
  return row ? { ...row, detail: decodeDetail(row.detail) } : null
}

function fixError(reply: FastifyReply, err: unknown) {
  if (err instanceof FixError) return reply.code(err.status).send({ error: err.message })
  throw err
}

export async function configReviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (req) => {
    const q = req.query as { family?: string; status?: string }
    let query = db('nivaro_config_health')
      .whereIn('family', REVIEW_FAMILIES)
      .orderBy([
        { column: 'severity', order: 'desc' },
        { column: 'id', order: 'asc' }
      ])
    if (REVIEW_FAMILIES.includes(q.family as never)) query = query.where('family', q.family)
    const status = ['open', 'dismissed', 'fixed'].includes(String(q.status)) ? q.status : 'open'
    query = query.where('status', status)
    const rows = (await query) as Array<Record<string, unknown> & { detail: string | null }>
    const counts = (await db('nivaro_config_health')
      .whereIn('family', REVIEW_FAMILIES)
      .groupBy('family', 'status')
      .count({ c: '*' })
      .select('family', 'status')) as Array<{ family: string; status: string; c: number }>
    const last = (await db('nivaro_job_runs')
      .where('job_id', CONFIG_REVIEW_JOB)
      .orderBy('id', 'desc')
      .first('status', 'started_at', 'finished_at', 'outcome', 'error')
      .catch(() => null)) as Record<string, unknown> | null | undefined
    return {
      data: rows.map((r) => ({ ...r, detail: publicDetail(decodeDetail(r.detail)) })),
      counts,
      running,
      last_run: last ?? null
    }
  })

  // Cleanup thresholds (#2020): the saved defaults the monthly run and the
  // page start from, with the bounds a save must respect.
  app.get('/settings', async () => ({
    data: {
      cleanup: await loadCleanupDefaults(),
      defaults: CLEANUP_DEFAULTS,
      bounds: CLEANUP_BOUNDS
    }
  }))

  app.put<{ Body: { cleanup?: unknown } }>('/settings', async (req, reply) => {
    const checked = validateCleanup(req.body?.cleanup)
    if (!checked.ok) return reply.code(400).send({ error: checked.error })
    const before = await loadCleanupDefaults()
    await saveCleanupDefaults(checked.value)
    const v = checked.value
    await logActivity({
      action: 'config-review-settings',
      user: req.user?.id ?? null,
      collection: 'nivaro_extension_settings',
      item: 'nivaro-core:config_review_cleanup',
      comment: `Cleanup defaults: drafts ${before.draftMonths}→${v.draftMonths} months, tasks ${before.taskMonths}→${v.taskMonths} months, views ${before.viewDays}→${v.viewDays} days`,
      req
    })
    return { data: { cleanup: v } }
  })

  // Run now — in the background (the empty-field scan reads every small
  // collection); the page polls GET until `running` clears.
  app.post<{
    Body: { ai?: boolean; draft_months?: number; task_months?: number; view_days?: number }
  }>('/run', async (req, reply) => {
    if (running) return reply.code(409).send({ error: 'A review is already running', running })
    const body = req.body ?? {}
    const by = req.user?.id ?? null
    running = { since: new Date().toISOString(), by }
    const { startJobRun } = await import('../services/job-runs.js')
    const run = await startJobRun('cron', CONFIG_REVIEW_JOB, {
      label: 'Config review (run now)',
      triggeredBy: by
    })
    void runConfigReview({
      ai: body.ai === true,
      draftMonths: body.draft_months,
      taskMonths: body.task_months,
      viewDays: body.view_days
    })
      .then(async (outcome) => {
        await run.complete(outcome.summary)
        await logActivity({ action: 'config-review-run', user: by, comment: outcome.summary })
      })
      .catch((err) => run.fail(err))
      .finally(() => {
        running = null
      })
    return reply.code(202).send({ data: { running } })
  })

  app.get<{ Params: { id: string }; Querystring: { label?: string } }>(
    '/:id/preview',
    async (req, reply) => {
      const f = await loadFinding(req.params.id)
      if (!f) return reply.code(404).send({ error: 'Not found' })
      try {
        const changeSet = await previewFix(f, {
          userId: req.user?.id ?? null,
          req,
          label: req.query.label
        })
        return { data: changeSet }
      } catch (err) {
        return fixError(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string }; Body: { label?: string; ids?: string[]; hash?: string } }>(
    '/:id/apply',
    async (req, reply) => {
      const f = await loadFinding(req.params.id)
      if (!f) return reply.code(404).send({ error: 'Not found' })
      if (f.status !== 'open') return reply.code(409).send({ error: `The finding is ${f.status}` })
      if (busy.has(f.id)) return reply.code(409).send({ error: 'A fix is already running' })
      busy.add(f.id)
      try {
        const userId = req.user?.id ?? null
        const { changeSet, undo, applied } = await applyFix(
          f,
          { userId, req, label: req.body?.label },
          { ids: req.body?.ids, hash: req.body?.hash }
        )
        const detail = {
          ...f.detail,
          applied: [
            {
              at: new Date().toISOString(),
              by: userId,
              title: changeSet.title,
              total: applied,
              undo
            },
            ...(f.detail.applied ?? [])
          ].slice(0, APPLIED_KEEP)
        }
        await db('nivaro_config_health')
          .where('id', f.id)
          .update({ status: 'fixed', detail: encodeDetail(detail) })
        await logActivity({
          action: 'config-review-fix',
          user: userId,
          collection: 'nivaro_config_health',
          item: String(f.id),
          comment: `${changeSet.title} (${applied} change(s))`.slice(0, 1000),
          req
        })
        return { data: { change_set: changeSet, applied, undoable: !!undo } }
      } catch (err) {
        return fixError(reply, err)
      } finally {
        busy.delete(f.id)
      }
    }
  )

  app.post<{ Params: { id: string } }>('/:id/undo', async (req, reply) => {
    const f = await loadFinding(req.params.id)
    if (!f) return reply.code(404).send({ error: 'Not found' })
    const last = undoableFix(f.detail)
    if (!last?.undo) return reply.code(409).send({ error: 'Nothing to undo' })
    if (busy.has(f.id)) return reply.code(409).send({ error: 'A fix is already running' })
    busy.add(f.id)
    try {
      const userId = req.user?.id ?? null
      const restored = await undoFix(last.undo, { userId, req })
      const detail = { ...f.detail, applied: (f.detail.applied ?? []).slice(1) }
      await db('nivaro_config_health')
        .where('id', f.id)
        .update({ status: 'open', detail: encodeDetail(detail) })
      await logActivity({
        action: 'config-review-undo',
        user: userId,
        collection: 'nivaro_config_health',
        item: String(f.id),
        comment: `Undid "${last.title}" — ${restored} restored`.slice(0, 1000),
        req
      })
      return { data: { restored } }
    } catch (err) {
      return fixError(reply, err)
    } finally {
      busy.delete(f.id)
    }
  })

  app.post<{ Params: { id: string } }>('/:id/dismiss', async (req, reply) => {
    const f = await loadFinding(req.params.id)
    if (!f) return reply.code(404).send({ error: 'Not found' })
    if (f.status === 'fixed') return reply.code(409).send({ error: 'The finding is fixed' })
    const next = f.status === 'dismissed' ? 'open' : 'dismissed'
    await db('nivaro_config_health')
      .where('id', f.id)
      .update({ status: next, dismissed_by: next === 'dismissed' ? (req.user?.id ?? null) : null })
    return { data: { status: next } }
  })
}

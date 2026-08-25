import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

/**
 * Background Jobs console reads. One source of truth (nivaro_job_runs, fed by
 * CronManager, remediations, backfills, recalcs) plus the live cron registry —
 * so "what ran, what's running, what broke" stops being five pages and a log
 * tail. Admin-only: run history names internal jobs and error details.
 */
export async function jobRunRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  /** Cooperative cancel (#302): flags the run; cancel-aware loops (rollup
   *  backfill, find-replace) stop at their next chunk boundary. Flags are
   *  in-process — a run on another replica ignores this replica's flag. */
  app.post<{ Params: { id: string } }>('/:id/cancel', async (req, reply) => {
    const { requestCancel } = await import('../services/job-cancel.js')
    requestCancel(Number(req.params.id))
    const { logActivity } = await import('../services/activity.js')
    await logActivity({
      action: 'job-run-cancel',
      user: req.user?.id,
      comment: `run #${req.params.id}`,
      req
    })
    return reply.send({ data: { cancel_requested: true } })
  })

  /** Filterable run history. */
  app.get('/', async (req) => {
    const q = req.query as {
      kind?: string
      job_id?: string
      status?: string
      page?: string
      limit?: string
    }
    const page = Math.max(1, Number(q.page) || 1)
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))

    let query = db('nivaro_job_runs as r')
      .leftJoin('nivaro_users as u', 'u.id', 'r.triggered_by')
      .select(
        'r.*',
        db.raw(
          "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as triggered_by_name"
        )
      )
      .orderBy('r.id', 'desc')
    let countQ = db('nivaro_job_runs')
    if (q.kind) {
      query = query.where('r.kind', q.kind)
      countQ = countQ.where('kind', q.kind)
    }
    if (q.status) {
      query = query.where('r.status', q.status)
      countQ = countQ.where('status', q.status)
    }
    if (q.job_id) {
      // Contains-match so "mdsi" finds ping-mdsi-shipments; escape LIKE wildcards.
      const like = `%${q.job_id.replace(/[%_[]/g, (c) => `[${c}]`)}%`
      query = query.where('r.job_id', 'like', like)
      countQ = countQ.where('job_id', 'like', like)
    }
    const [rows, totalRow] = await Promise.all([
      query.offset((page - 1) * limit).limit(limit),
      countQ.count({ c: '*' }).first()
    ])
    return { data: rows, total: Number((totalRow as { c?: number } | undefined)?.c ?? 0) }
  })

  /** The live cron roster merged with each job's latest recorded run, plus a
   *  per-extension rollup — feeds the console AND the Extensions health cards. */
  app.get('/registry', async () => {
    const crons = app.cron.list()
    // Latest run per (kind, job_id) in one window query.
    const latest = (await db.raw(
      `SELECT * FROM (
         SELECT r.*, ROW_NUMBER() OVER (PARTITION BY kind, job_id ORDER BY id DESC) AS rn
         FROM nivaro_job_runs r
       ) x WHERE x.rn = 1`
    )) as Array<Record<string, unknown>>
    const latestByJob = new Map<string, Record<string, unknown>>()
    for (const r of latest) latestByJob.set(`${r.kind}:${r.job_id}`, r)

    const since = new Date(Date.now() - 7 * 86_400_000)
    const errorCounts = (await db('nivaro_job_runs')
      .where('status', 'error')
      .where('started_at', '>=', since)
      .groupBy('kind', 'job_id')
      .count({ c: '*' })
      .select('kind', 'job_id')) as Array<{ kind: string; job_id: string; c: number }>
    const errByJob = new Map(errorCounts.map((e) => [`${e.kind}:${e.job_id}`, Number(e.c)]))

    const strip = (r: Record<string, unknown> | undefined) =>
      r
        ? {
            status: r.status,
            started_at: r.started_at,
            duration_ms: r.duration_ms,
            outcome: r.outcome,
            error: r.error
          }
        : null

    return {
      data: {
        crons: crons.map((c) => ({
          id: c.id,
          expression: c.expression,
          extension_id: c.extensionId ?? null,
          next_run: c.nextRun,
          paused: c.paused ?? false,
          heavy: c.heavy ?? false,
          idempotent: c.idempotent ?? 'unknown',
          last: strip(latestByJob.get(`cron:${c.id}`)),
          errors_7d: errByJob.get(`cron:${c.id}`) ?? 0
        })),
        running: await db('nivaro_job_runs')
          .where('status', 'running')
          .orderBy('id', 'desc')
          .limit(50)
      }
    }
  })
}

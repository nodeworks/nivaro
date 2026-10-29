import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { cronTicksEnabled } from '../plugins/cron.js'
import { describeJobRunRow, parseProgress, skippedRows } from '../services/job-run-sentences.js'
import { readJobLog } from '../services/job-runs.js'

/** Kinds that hold real capacity: while one runs, admins see "System busy". */
const BUSY_KINDS = new Set([
  'backfill',
  'recalc',
  'bulk',
  'export',
  'tuning',
  'render',
  'remediation'
])
const BUSY_WINDOW_MS = 2 * 3_600_000

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

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

  /** One run's live log (#1974): the lines written so far; `after` = the last seq the page has. */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/:id/log',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: 'Invalid run id' })
      const run = await db('nivaro_job_runs').where('id', id).first()
      if (!run) return reply.code(404).send({ error: 'Not found' })
      const lines = await readJobLog(id, Number(req.query.after) || 0)
      return {
        data: {
          run: {
            id: run.id,
            status: run.status,
            progress: run.progress ?? null,
            outcome: run.outcome ?? null,
            error: run.error ? String(run.error).split('\n')[0].slice(0, 500) : null
          },
          lines
        }
      }
    }
  )

  /**
   * #2024 — what heavy work is running right now, for the header's "System busy"
   * chip: heavy cron ticks and long-running kinds (backfills, recalcs, bulk
   * writes, exports, renders), plus imports in flight. The estimate is the
   * median of the same job's last completed runs; no history = no estimate.
   */
  app.get('/busy', async () => {
    const heavyCrons = new Map(
      app.cron
        .list()
        .filter((c) => c.heavy)
        .map((c) => [c.id, c])
    )
    const since = new Date(Date.now() - BUSY_WINDOW_MS)
    const running = (await db('nivaro_job_runs')
      .where('status', 'running')
      .where('started_at', '>=', since)
      .orderBy('id', 'desc')
      .limit(50)) as Array<Record<string, unknown>>
    const hot = running.filter(
      (r) =>
        BUSY_KINDS.has(String(r.kind)) || (r.kind === 'cron' && heavyCrons.has(String(r.job_id)))
    )
    const now = Date.now()
    const items = await Promise.all(
      hot.map(async (r) => {
        const past = (await db('nivaro_job_runs')
          .where({ kind: r.kind, job_id: r.job_id, status: 'completed' })
          .whereNotNull('duration_ms')
          .orderBy('id', 'desc')
          .limit(7)
          .pluck('duration_ms')) as unknown[]
        const expected = median(past.map(Number).filter((n) => Number.isFinite(n) && n > 0))
        const elapsed = now - new Date(String(r.started_at)).getTime()
        const cron = heavyCrons.get(String(r.job_id))
        return {
          id: Number(r.id),
          kind: String(r.kind),
          label: String(r.label ?? cron?.description ?? r.job_id).slice(0, 120),
          started_at: r.started_at,
          elapsed_ms: elapsed,
          expected_ms: expected,
          remaining_ms: expected == null ? null : Math.max(0, expected - elapsed),
          overrun: expected != null && elapsed > expected
        }
      })
    )
    const imports = (await db('nivaro_import_jobs')
      .where('status', 'processing')
      .where('started_at', '>=', since)
      .limit(10)
      .select('id', 'collection', 'started_at', 'processed_rows', 'total_rows')
      .catch(() => [])) as Array<Record<string, unknown>>
    for (const j of imports) {
      const elapsed = now - new Date(String(j.started_at)).getTime()
      const done = Number(j.processed_rows) || 0
      const total = Number(j.total_rows) || 0
      const expected = done > 0 && total > done ? Math.round((elapsed / done) * total) : null
      items.push({
        id: -1,
        kind: 'import',
        label: `Import into ${String(j.collection)}`.slice(0, 120),
        started_at: j.started_at,
        elapsed_ms: elapsed,
        expected_ms: expected,
        remaining_ms: expected == null ? null : Math.max(0, expected - elapsed),
        overrun: false
      })
    }
    return {
      data: {
        busy: items.length > 0,
        items,
        heavy_slot: app.cron ? await app.cron.heavySlotHolder().catch(() => null) : null
      }
    }
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
      // Contains-match so "sweep" finds every *-sweep job; escape LIKE wildcards.
      const like = `%${q.job_id.replace(/[%_[]/g, (c) => `[${c}]`)}%`
      query = query.where('r.job_id', 'like', like)
      countQ = countQ.where('job_id', 'like', like)
    }
    const [rows, totalRow] = await Promise.all([
      query.offset((page - 1) * limit).limit(limit),
      countQ.count({ c: '*' }).first()
    ])
    // #21 — each run as one sentence (per-job formatter, else the generic reading) and how many
    // rows it passed over; `skipped_ids` = the run recorded them (GET /:id/skipped opens them).
    const described = (rows as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      ...describeJobRunRow(r)
    }))
    return { data: described, total: Number((totalRow as { c?: number } | undefined)?.c ?? 0) }
  })

  /** #21 — the rows one run passed over (progress `skipped`, ≤ 200), each with its reason. */
  app.get<{ Params: { id: string } }>('/:id/skipped', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: 'Invalid run id' })
    const run = (await db('nivaro_job_runs')
      .where('id', id)
      .first('id', 'job_id', 'label', 'kind', 'status', 'progress', 'duration_ms', 'outcome')) as
      | Record<string, unknown>
      | undefined
    if (!run) return reply.code(404).send({ error: 'Not found' })
    const progress = parseProgress(run.progress)
    const rows = skippedRows(progress)
    const total = Number(progress?.skipped_total ?? rows.length) || rows.length
    return {
      data: {
        run: { id: run.id, job_id: run.job_id, ...describeJobRunRow(run) },
        rows,
        total,
        truncated: total > rows.length
      }
    }
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
          default_expression: c.defaultExpression,
          overridden: c.overridden,
          extension_id: c.extensionId ?? null,
          next_run: c.nextRun,
          paused: c.paused ?? false,
          heavy: c.heavy ?? false,
          idempotent: c.idempotent ?? 'unknown',
          description: c.description ?? null,
          // #831 — the zone the schedule is read in, and why
          timezone: c.timezone ?? null,
          timezone_source: c.timezone_source ?? null,
          supports_dry_run: c.supports_dry_run ?? false,
          gate: c.gate ?? null,
          after: c.after ?? null,
          last: strip(latestByJob.get(`cron:${c.id}`)),
          errors_7d: errByJob.get(`cron:${c.id}`) ?? 0
        })),
        ticks_enabled: cronTicksEnabled(),
        // #1080 — which process fires scheduled jobs (the lease holder).
        scheduler: app.cron ? await app.cron.schedulerStatus() : null,
        running: await db('nivaro_job_runs')
          .where('status', 'running')
          .orderBy('id', 'desc')
          .limit(50)
      }
    }
  })
}

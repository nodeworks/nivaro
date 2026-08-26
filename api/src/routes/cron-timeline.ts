import { Cron } from 'croner'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'

// ─── Cron overlap timeline (#654) ────────────────────────────────────────────
// One payload answering "what ran when, what was SUPPOSED to run when, and
// where do heavy jobs pile up": every registered cron's occurrences expanded
// over the window (croner nextRun loop over the same expression the scheduler
// runs, capped so a per-minute cron can't balloon the response) plus the
// actual nivaro_job_runs rows (kind=cron) with durations for real bars.

const OCCURRENCE_CAP = 200
const RUNS_CAP = 5000

function parseHours(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 24
  return Math.min(Math.floor(n), 24 * 7)
}

export async function cronTimelineRoutes(app: FastifyInstance) {
  // GET /cron-timeline?hours=24
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const hours = parseHours((req.query as { hours?: string }).hours)
    const now = new Date()
    const from = new Date(now.getTime() - hours * 3_600_000)

    const jobs = app.cron.list()

    const runRows = (await db('nivaro_job_runs')
      .where('kind', 'cron')
      .where('started_at', '>=', from)
      .select('job_id', 'status', 'started_at', 'finished_at', 'duration_ms')
      .orderBy('started_at', 'asc')
      .limit(RUNS_CAP)) as {
      job_id: string
      status: string
      started_at: string | Date
      finished_at: string | Date | null
      duration_ms: number | null
    }[]

    const runsByJob = new Map<string, typeof runRows>()
    for (const run of runRows) {
      const list = runsByJob.get(run.job_id)
      if (list) list.push(run)
      else runsByJob.set(run.job_id, [run])
    }

    const data = jobs.map((job) => {
      // Expand scheduled occurrences across the window. A parse failure (or an
      // exotic expression croner can't step) degrades to an empty tick lane —
      // the actual-run bars still tell the story.
      const occurrences: string[] = []
      let truncated = false
      try {
        const probe = new Cron(job.expression)
        let cursor: Date | null = new Date(from)
        while (cursor) {
          cursor = probe.nextRun(cursor)
          if (!cursor || cursor.getTime() > now.getTime()) break
          if (occurrences.length >= OCCURRENCE_CAP) {
            truncated = true
            break
          }
          occurrences.push(cursor.toISOString())
        }
        probe.stop()
      } catch {
        /* unparseable expression — empty occurrence lane */
      }

      return {
        id: job.id,
        expression: job.expression,
        extension_id: job.extensionId ?? null,
        heavy: job.heavy === true,
        idempotent: job.idempotent ?? 'unknown',
        paused: job.paused === true,
        next_run: job.nextRun ? new Date(job.nextRun).toISOString() : null,
        occurrences,
        occurrences_truncated: truncated,
        runs: (runsByJob.get(job.id) ?? []).map((run) => ({
          status: run.status,
          started_at: new Date(run.started_at).toISOString(),
          finished_at: run.finished_at ? new Date(run.finished_at).toISOString() : null,
          duration_ms: run.duration_ms != null ? Number(run.duration_ms) : null
        }))
      }
    })

    return reply.send({
      data: {
        window_hours: hours,
        from: from.toISOString(),
        to: now.toISOString(),
        jobs: data
      }
    })
  })
}

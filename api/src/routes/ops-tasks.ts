/**
 * Operational tasks console (#827) — every task core or an extension
 * registered, with its last runs; dry run by default; output tail while it
 * runs. Admin only: these repair and backfill data.
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import {
  cancelOpsTaskRun,
  getOpsTaskRun,
  listOpsTasks,
  recentOpsTaskRuns,
  runningRunFor,
  startOpsTask,
  taskAvailability
} from '../services/ops-tasks.js'

export async function opsTaskRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const defs = listOpsTasks()
    const keys = defs.map((d) => `task:${d.key}`)
    const history = keys.length
      ? await db('nivaro_job_runs as r')
          .leftJoin('nivaro_users as u', 'u.id', 'r.triggered_by')
          .whereIn('r.job_id', keys)
          .orderBy('r.id', 'desc')
          .limit(keys.length * 10)
          .select(
            'r.id',
            'r.job_id',
            'r.label',
            'r.status',
            'r.started_at',
            'r.finished_at',
            'r.duration_ms',
            'r.outcome',
            'r.error',
            db.raw(
              "LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as by_name"
            )
          )
          .catch(() => [] as Array<Record<string, unknown>>)
      : []
    const byKey = new Map<string, Array<Record<string, unknown>>>()
    for (const h of history as Array<Record<string, unknown>>) {
      const key = String(h.job_id).slice('task:'.length)
      const list = byKey.get(key) ?? []
      if (list.length < 10) list.push(h)
      byKey.set(key, list)
    }
    const data = await Promise.all(
      defs.map(async (d) => {
        const a = await taskAvailability(d)
        const live = runningRunFor(d.key)
        return {
          key: d.key,
          owner: d.owner,
          label: d.label,
          description: d.description,
          group: d.group ?? null,
          leaves_behind: d.leaves_behind ?? null,
          follow_up: d.follow_up ?? null,
          cli: d.cli ?? null,
          has_dry_run: typeof d.dryRun === 'function',
          available: a.ok,
          unavailable_reason: a.reason,
          running: live
            ? { id: live.id, mode: live.mode, started_at: live.started_at, progress: live.progress }
            : null,
          runs: (byKey.get(d.key) ?? []).map((h) => ({
            id: h.id,
            label: h.label,
            status: h.status,
            started_at: h.started_at,
            finished_at: h.finished_at,
            duration_ms: h.duration_ms,
            outcome: h.outcome,
            error: h.error ? String(h.error).split('\n')[0].slice(0, 300) : null,
            by: h.by_name || null
          }))
        }
      })
    )
    return { data }
  })

  app.post('/:key/run', async (req, reply) => {
    const { key } = req.params as { key: string }
    const body = (req.body ?? {}) as { execute?: boolean }
    try {
      const run = await startOpsTask(key, {
        execute: body.execute === true,
        userId: req.user?.id ?? null
      })
      return reply.code(202).send({ data: run })
    } catch (err) {
      const e = err as { statusCode?: number; message?: string; run?: unknown }
      return reply
        .code(e.statusCode ?? 500)
        .send({ error: e.message ?? 'run failed', run: e.run ?? null })
    }
  })

  app.get('/runs/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    const live = Number.isFinite(id) ? getOpsTaskRun(id) : null
    if (live) return { data: live }
    const row = Number.isFinite(id) ? await db('nivaro_job_runs').where({ id }).first() : null
    if (!row || !String((row as { job_id?: string }).job_id ?? '').startsWith('task:'))
      return reply.code(404).send({ error: 'Run not found' })
    // A run from before this process started: the durable record, no tail.
    const r = row as Record<string, unknown>
    return {
      data: {
        id: r.id,
        key: String(r.job_id).slice('task:'.length),
        mode: /dry run/.test(String(r.label ?? '')) ? 'dry' : 'execute',
        status: r.status,
        started_at: r.started_at,
        finished_at: r.finished_at,
        by: r.triggered_by ?? null,
        progress: null,
        outcome: r.outcome ? { summary: r.outcome } : null,
        error: r.error ?? null,
        output: ['(output is kept only while the process that ran it is up)']
      }
    }
  })

  app.get('/runs', async (req) => {
    const { key } = req.query as { key?: string }
    return { data: recentOpsTaskRuns(key) }
  })

  app.post('/runs/:id/cancel', async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!cancelOpsTaskRun(id))
      return reply.code(404).send({ error: 'No running task with that id' })
    return { data: { id, cancelling: true } }
  })
}

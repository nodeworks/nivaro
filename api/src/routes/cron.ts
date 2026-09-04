import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { previewCronRuns } from '../plugins/cron.js'
import { logActivity } from '../services/activity.js'

type OverrideRow = {
  expression: string
  note?: string | null
  updated_by?: string | null
  updated_at?: string
}

async function readOverrides(): Promise<Record<string, OverrideRow>> {
  const { db } = await import('../db/index.js')
  const row = (await db('nivaro_settings').orderBy('id', 'asc').first('cron_overrides')) as
    | { cron_overrides?: string | null }
    | undefined
  if (!row?.cron_overrides) return {}
  try {
    const parsed = JSON.parse(row.cron_overrides)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, OverrideRow>) : {}
  } catch {
    return {}
  }
}

async function writeOverrides(map: Record<string, OverrideRow>): Promise<void> {
  const { db } = await import('../db/index.js')
  const row = (await db('nivaro_settings').orderBy('id', 'asc').first('id')) as
    | { id: number }
    | undefined
  if (!row) return
  await db('nivaro_settings')
    .where({ id: row.id })
    .update({ cron_overrides: Object.keys(map).length ? JSON.stringify(map) : null })
}

// ─── Cron administration ─────────────────────────────────────────────────────
// Scheduled jobs (core + extension-registered) were previously only observable
// from the process itself. These routes let an admin see what is scheduled and
// re-run a job out of band — the operator need after a nightly job fails, and
// the only practical way to exercise a cron-driven integration on demand.

export async function cronRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireAdmin }, async () => {
    const overrides = await readOverrides()
    return {
      data: app.cron.list().map((j) => ({ ...j, override: overrides[j.id] ?? null }))
    }
  })

  // Next fire times for an expression — the editor's live preview. Invalid
  // expressions answer 400 with croner's own message.
  app.get<{ Querystring: { expression?: string } }>(
    '/preview',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const expression = String(req.query.expression ?? '').trim()
      if (!expression) return reply.code(400).send({ error: 'expression is required' })
      try {
        return { data: { expression, next_runs: previewCronRuns(expression, 5) } }
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : 'Invalid cron expression' })
      }
    }
  )

  // Override a job's schedule (or revert with expression: null). Applies live
  // on this replica and persists in settings.cron_overrides, which every
  // replica hydrates at boot before extensions register — so the override
  // binds regardless of which code registered the job.
  app.patch<{ Params: { id: string }; Body: { expression?: string | null; note?: string | null } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const entry = app.cron.list().find((j) => j.id === id)
      if (!entry) return reply.code(404).send({ error: 'No scheduled job with that id' })
      const body = req.body ?? {}
      const expression = body.expression == null ? null : String(body.expression).trim()
      const map = await readOverrides()
      if (expression === null || expression === '' || expression === entry.defaultExpression) {
        app.cron.revert(id)
        delete map[id]
        await writeOverrides(map)
        await logActivity({ action: 'cron-revert', user: req.user?.id, req, comment: id })
      } else {
        try {
          app.cron.override(id, expression)
        } catch (err) {
          return reply
            .code(400)
            .send({ error: err instanceof Error ? err.message : 'Invalid cron expression' })
        }
        map[id] = {
          expression,
          note: body.note ?? map[id]?.note ?? null,
          updated_by: req.user?.id ?? null,
          updated_at: new Date().toISOString()
        }
        await writeOverrides(map)
        await logActivity({
          action: 'cron-override',
          user: req.user?.id,
          req,
          comment: `${id}: ${entry.defaultExpression} → ${expression}`
        })
      }
      const after = app.cron.list().find((j) => j.id === id)
      return { data: { ...after, override: map[id] ?? null } }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/:id/revert',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      if (!app.cron.list().some((j) => j.id === id)) {
        return reply.code(404).send({ error: 'No scheduled job with that id' })
      }
      app.cron.revert(id)
      const map = await readOverrides()
      delete map[id]
      await writeOverrides(map)
      await logActivity({ action: 'cron-revert', user: req.user?.id, req, comment: id })
      return { data: app.cron.list().find((j) => j.id === id) }
    }
  )

  // #198 — pause/resume a cron without a deploy. Persisted in
  // settings.paused_crons so a restart keeps the choice; the schedule itself
  // stays registered so resume is instant.
  for (const action of ['pause', 'resume'] as const) {
    app.post<{ Params: { id: string } }>(
      `/:id/${action}`,
      { preHandler: requireAdmin },
      async (req, reply) => {
        const { id } = req.params
        if (!app.cron.list().some((j) => j.id === id)) {
          return reply.code(404).send({ error: 'No scheduled job with that id' })
        }
        if (action === 'pause') app.cron.pause(id)
        else app.cron.resume(id)
        const { db } = await import('../db/index.js')
        const paused = app.cron
          .list()
          .filter((j) => j.paused)
          .map((j) => j.id)
        await db('nivaro_settings')
          .orderBy('id', 'asc')
          .first('id')
          .then((row) =>
            row
              ? db('nivaro_settings')
                  .where({ id: row.id })
                  .update({ paused_crons: JSON.stringify(paused) })
              : null
          )
          .catch(() => {})
        await logActivity({ action: `cron-${action}`, user: req.user?.id, req, comment: id })
        return { data: { id, paused: action === 'pause' } }
      }
    )
  }

  app.post<{ Params: { id: string } }>(
    '/:id/run',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const known = app.cron.list().some((j) => j.id === id)
      if (!known) return reply.code(404).send({ error: 'No scheduled job with that id' })

      const startedAt = Date.now()
      try {
        await app.cron.runNow(id, req.user?.id ?? null)
        await logActivity({
          action: 'cron-run-now',
          user: req.user?.id,
          req,
          comment: `${id} (${Date.now() - startedAt}ms)`
        })
        return { data: { id, ran: true, duration_ms: Date.now() - startedAt } }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await logActivity({
          action: 'cron-run-now-failed',
          user: req.user?.id,
          req,
          comment: `${id}: ${message.slice(0, 300)}`
        })
        return reply.code(500).send({ error: message })
      }
    }
  )
}

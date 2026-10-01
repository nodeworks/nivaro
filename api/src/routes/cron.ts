import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { JobBusyError, previewCronRuns } from '../plugins/cron.js'
import { logActivity } from '../services/activity.js'

type OverrideRow = {
  /** Absent when only the zone is overridden (#831). */
  expression?: string
  /** #831 — IANA zone this job is pinned to (absent = the instance zone). */
  timezone?: string
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

/** Remove one field from an override row, and the row once it is empty. */
function clearOverrideField(
  map: Record<string, OverrideRow>,
  id: string,
  key: 'expression' | 'timezone'
) {
  const row = map[id]
  if (!row) return
  delete row[key]
  if (!row.expression && !row.timezone) delete map[id]
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

async function readChains(): Promise<Record<string, string>> {
  const { db } = await import('../db/index.js')
  const row = (await db('nivaro_settings').orderBy('id', 'asc').first('cron_chains')) as
    | { cron_chains?: string | null }
    | undefined
  if (!row?.cron_chains) return {}
  try {
    const parsed = JSON.parse(row.cron_chains)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

async function writeChains(map: Record<string, string>): Promise<void> {
  const { db } = await import('../db/index.js')
  const row = (await db('nivaro_settings').orderBy('id', 'asc').first('id')) as
    | { id: number }
    | undefined
  if (!row) return
  await db('nivaro_settings')
    .where({ id: row.id })
    .update({ cron_chains: Object.keys(map).length ? JSON.stringify(map) : null })
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
  app.get<{ Querystring: { expression?: string; timezone?: string } }>(
    '/preview',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const expression = String(req.query.expression ?? '').trim()
      if (!expression) return reply.code(400).send({ error: 'expression is required' })
      try {
        const tz = req.query.timezone || app.cron.getInstanceTimezone() || undefined
        return {
          data: { expression, timezone: tz ?? null, next_runs: previewCronRuns(expression, 5, tz) }
        }
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
  // #32 — a job's dry-run handler: the report of what a tick would do.
  app.post<{ Params: { id: string } }>(
    '/:id/dry-run',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      if (!app.cron.list().some((j) => j.id === id)) {
        return reply.code(404).send({ error: 'No scheduled job with that id' })
      }
      const t0 = Date.now()
      try {
        const r = await app.cron.dryRun(id)
        if (!r.supported) return reply.code(400).send({ error: 'This job has no dry-run handler' })
        await logActivity({ action: 'cron-dry-run', user: req.user?.id, req, comment: id })
        return { data: { report: r.report, duration_ms: Date.now() - t0 } }
      } catch (err) {
        return reply
          .code(500)
          .send({ error: err instanceof Error ? err.message : 'Dry run failed' })
      }
    }
  )

  app.patch<{
    Params: { id: string }
    Body: {
      expression?: string | null
      note?: string | null
      after?: string | null
      timezone?: string | null
    }
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params
    const entry = app.cron.list().find((j) => j.id === id)
    if (!entry) return reply.code(404).send({ error: 'No scheduled job with that id' })
    const body = req.body ?? {}
    // #54 — chaining is its own edit: `after` present = set/clear the chain
    // and stop; the schedule stays registered as the revert target.
    if ('after' in body) {
      const after =
        body.after == null || String(body.after).trim() === '' ? null : String(body.after).trim()
      if (after && !app.cron.list().some((j) => j.id === after)) {
        return reply.code(400).send({ error: `No scheduled job named "${after}"` })
      }
      try {
        app.cron.setAfter(id, after)
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Bad chain' })
      }
      const chains = await readChains()
      if (after) chains[id] = after
      else delete chains[id]
      await writeChains(chains)
      await logActivity({
        action: 'cron-chain',
        user: req.user?.id,
        req,
        comment: after ? `${id} runs after ${after}` : `${id} unchained`
      })
      return { data: app.cron.list().find((j) => j.id === id) }
    }
    // #831 — pin the job to a zone (null/'' = back to the instance zone).
    if ('timezone' in body) {
      const tz = body.timezone == null ? '' : String(body.timezone).trim()
      try {
        app.cron.setTimezone(id, tz || null)
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Bad time zone' })
      }
      const map = await readOverrides()
      if (tz) {
        map[id] = {
          ...(map[id] ?? {}),
          timezone: tz,
          updated_by: req.user?.id ?? null,
          updated_at: new Date().toISOString()
        }
      } else clearOverrideField(map, id, 'timezone')
      await writeOverrides(map)
      await logActivity({
        action: 'cron-timezone',
        user: req.user?.id,
        req,
        comment: tz ? `${id} runs on ${tz}` : `${id} back to the instance zone`
      })
      return { data: { ...app.cron.list().find((j) => j.id === id), override: map[id] ?? null } }
    }
    const expression = body.expression == null ? null : String(body.expression).trim()
    const map = await readOverrides()
    if (expression === null || expression === '' || expression === entry.defaultExpression) {
      app.cron.revert(id)
      clearOverrideField(map, id, 'expression')
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
        ...(map[id] ?? {}),
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
  })

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
      clearOverrideField(map, id, 'expression')
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
        // #1085 — an unsafe job already running elsewhere: refused, nothing ran.
        if (err instanceof JobBusyError) {
          await logActivity({
            action: 'cron-run-now-refused',
            user: req.user?.id,
            req,
            comment: `${id}: ${message.slice(0, 300)}`
          })
          return reply.code(409).send({ error: message, code: err.code, holder: err.holder })
        }
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

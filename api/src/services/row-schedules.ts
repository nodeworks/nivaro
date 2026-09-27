/**
 * Schedules that live in a table row: a retention policy, a scheduled report,
 * a sync job, a scheduled flow. They used to be registered when the process
 * started and at no other time, so a schedule created in the afternoon first
 * ran after the next restart.
 *
 * `reconcile` makes the cron roster match the rows: new rows are scheduled,
 * changed expressions are rescheduled, removed or switched-off rows are
 * unscheduled. Routes call it after a change and move the schedules epoch, so
 * every other process on the database does the same within its poll.
 */
import type { FastifyInstance } from 'fastify'
import { SCHEDULES_EPOCH, bumpEpoch } from '../db/config-epoch.js'
import { db } from '../db/index.js'

export interface DesiredSchedule {
  expression: string
  run: () => Promise<void>
  description?: string
}

export interface ReconcileResult {
  scheduled: string[]
  rescheduled: string[]
  unscheduled: string[]
  invalid: Array<{ id: string; error: string }>
}

/** Pure planning step, exported for tests. */
export function planReconcile(
  current: Array<{ id: string; expression: string }>,
  desired: Map<string, { expression: string }>,
  prefix: string
): { add: string[]; change: string[]; remove: string[] } {
  const mine = current.filter((c) => c.id.startsWith(prefix))
  const have = new Map(mine.map((c) => [c.id, c.expression]))
  const add: string[] = []
  const change: string[] = []
  for (const [id, d] of desired) {
    if (!have.has(id)) add.push(id)
    else if (have.get(id) !== d.expression) change.push(id)
  }
  const remove = mine.filter((c) => !desired.has(c.id)).map((c) => c.id)
  return { add, change, remove }
}

export function reconcile(
  app: FastifyInstance,
  prefix: string,
  desired: Map<string, DesiredSchedule>
): ReconcileResult {
  const out: ReconcileResult = { scheduled: [], rescheduled: [], unscheduled: [], invalid: [] }
  if (!app.cron) return out
  const current = app.cron.list().map((j) => ({
    id: j.id,
    // The expression the row asked for — an admin's override of it is kept.
    expression: j.defaultExpression ?? j.expression
  }))
  const plan = planReconcile(current, desired, prefix)
  for (const id of plan.remove) {
    app.cron.unschedule(id)
    out.unscheduled.push(id)
  }
  for (const id of [...plan.add, ...plan.change]) {
    const d = desired.get(id) as DesiredSchedule
    try {
      if (plan.change.includes(id)) app.cron.unschedule(id)
      app.cron.schedule(
        id,
        d.expression,
        d.run,
        d.description ? { description: d.description } : {}
      )
      ;(plan.change.includes(id) ? out.rescheduled : out.scheduled).push(id)
    } catch (err) {
      out.invalid.push({ id, error: (err as Error)?.message ?? 'Invalid schedule' })
    }
  }
  return out
}

type Resync = (app: FastifyInstance) => Promise<ReconcileResult>
const resyncers = new Map<string, Resync>()

export function registerScheduleResync(name: string, fn: Resync): void {
  resyncers.set(name, fn)
}

export async function resyncSchedules(
  app: FastifyInstance,
  name: string
): Promise<ReconcileResult | null> {
  const fn = resyncers.get(name)
  if (!fn || !app.cron || process.env.CLOUD_META_DB_URL) return null
  try {
    const res = await fn(app)
    const n = res.scheduled.length + res.rescheduled.length + res.unscheduled.length
    if (n > 0 || res.invalid.length > 0) app.log.info({ name, ...res }, 'Schedules brought in step')
    return res
  } catch (err) {
    app.log.warn({ err, name }, 'Schedules could not be brought in step')
    return null
  }
}

export async function resyncAllSchedules(app: FastifyInstance): Promise<void> {
  for (const name of resyncers.keys()) await resyncSchedules(app, name)
}

/** Tell every other process on this database that a schedule changed. */
export function announceScheduleChange(): void {
  void bumpEpoch(SCHEDULES_EPOCH)
}

/**
 * For a route plugin whose rows carry schedules: after any successful write,
 * bring this process in step and tell the others.
 */
export function resyncAfterWrites(app: FastifyInstance, name: string): void {
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    if (reply.statusCode >= 400) return
    // A manual run changes no schedule.
    if (/\/(run|test|preview|dry-run)(\/|$|\?)/.test(req.url)) return
    await resyncSchedules(req.server, name)
    announceScheduleChange()
  })
}

// ── the two sources that had no registration outside boot ───────────────────
export const RETENTION_PREFIX = 'retention-policy-'
export const REPORT_PREFIX = 'scheduled-report-'

registerScheduleResync('retention', async (app) => {
  const rows = (await db('nivaro_retention_policies')
    .where({ is_active: true })
    .whereNotNull('cron_schedule')
    .select('id', 'name', 'cron_schedule')) as Array<{
    id: number | string
    name: string | null
    cron_schedule: string
  }>
  const desired = new Map<string, DesiredSchedule>()
  for (const p of rows) {
    if (!String(p.cron_schedule ?? '').trim()) continue
    desired.set(`${RETENTION_PREFIX}${p.id}`, {
      expression: p.cron_schedule,
      description: p.name ? `Retention policy: ${p.name}` : undefined,
      run: async () => {
        try {
          const fresh = await db('nivaro_retention_policies').where({ id: p.id }).first()
          if (!fresh?.is_active) return
          const { executeRetentionPolicy } = await import('./retention.js')
          await executeRetentionPolicy(fresh, undefined, false)
        } catch (err) {
          app.log.error({ err }, `[retention] policy ${p.id} cron failed`)
        }
      }
    })
  }
  return reconcile(app, RETENTION_PREFIX, desired)
})

registerScheduleResync('scheduled-reports', async (app) => {
  const rows = (await db('nivaro_scheduled_reports')
    .where({ is_active: true })
    .select('id', 'name', 'cron_schedule')) as Array<{
    id: number | string
    name: string | null
    cron_schedule: string | null
  }>
  const desired = new Map<string, DesiredSchedule>()
  for (const r of rows) {
    if (!String(r.cron_schedule ?? '').trim()) continue
    desired.set(`${REPORT_PREFIX}${r.id}`, {
      expression: String(r.cron_schedule),
      description: r.name ? `Scheduled report: ${r.name}` : undefined,
      run: async () => {
        try {
          const fresh = await db('nivaro_scheduled_reports').where({ id: r.id }).first()
          if (!fresh?.is_active) return
          const { runScheduledReport } = await import('./scheduled-reports.js')
          await runScheduledReport(fresh)
        } catch (err) {
          app.log.error({ err }, `[scheduled-reports] report ${r.id} cron failed`)
        }
      }
    })
  }
  return reconcile(app, REPORT_PREFIX, desired)
})

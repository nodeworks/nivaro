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
 *
 * Hub shared deployment (one process, many apps): every row schedule belongs to one app. Its rows
 * are reconciled inside that app, so each entry binds to it (plugins/cron.ts `boundCronKey`) and
 * copied databases (both apps have `scheduled-report-1`) never touch each other's. An app is
 * hydrated when it becomes ready and every five minutes, dropped when it leaves, and a change is
 * announced to every replica on a Redis channel naming the app (the schedules epoch is off on a
 * multi-tenant deployment). Nothing schedules a row-schedule id outside an app there.
 */
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { bumpEpoch, SCHEDULES_EPOCH } from '../db/config-epoch.js'
import { db } from '../db/index.js'
import { getTenantId, withTenant } from '../db/tenant-context.js'
import { appBox } from './app-state.js'
import { isNivaroCloud, perAppJobs } from './deployment-mode.js'
import { onAppLeft, onAppReady } from './tenancy/app-lifecycle.js'
import { appReadyForRequests } from './tenancy/app-migrations.js'
import { getTenantRegistry } from './tenancy/registry.js'
import type { TenantRecord } from './tenancy/types.js'

export interface DesiredSchedule {
  expression: string
  run: () => Promise<void>
  description?: string
  idempotent?: 'safe' | 'unsafe' | 'unknown'
}

export interface ReconcileResult {
  scheduled: string[]
  rescheduled: string[]
  unscheduled: string[]
  invalid: Array<{ id: string; error: string }>
}

/** Pure planning step, exported for tests. */
export function planReconcile(
  current: Array<{ id: string; expression: string; timezone?: string; timezone_source?: string }>,
  desired: Map<string, { expression: string; timezone?: string }>,
  prefix: string
): { add: string[]; change: string[]; remove: string[] } {
  const mine = current.filter((c) => c.id.startsWith(prefix))
  const have = new Map(mine.map((c) => [c.id, c]))
  const add: string[] = []
  const change: string[] = []
  for (const [id, d] of desired) {
    const c = have.get(id)
    if (!c) add.push(id)
    else if (c.expression !== d.expression) change.push(id)
    // A wanted zone (Hub shared: the app's own) that the entry is not in is a reschedule — unless
    // an admin pinned the entry's zone (that override wins either way).
    else if (d.timezone && c.timezone_source !== 'override' && c.timezone !== d.timezone)
      change.push(id)
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
    expression: j.defaultExpression ?? j.expression,
    timezone: j.timezone,
    timezone_source: j.timezone_source
  }))
  // Hub shared deployment, inside an app: the app's own business zone (loaded by resyncSchedules)
  // — the deployment's cron zone is not any one app's. Self-hosted and cloud: none, as before.
  const zone = perAppJobs() && getTenantId() ? (appZone.value ?? undefined) : undefined
  const wanted = new Map<string, DesiredSchedule & { timezone?: string }>()
  for (const [id, d] of desired) wanted.set(id, zone ? { ...d, timezone: zone } : d)
  const plan = planReconcile(current, wanted, prefix)
  for (const id of plan.remove) {
    app.cron.unschedule(id)
    out.unscheduled.push(id)
  }
  for (const id of [...plan.add, ...plan.change]) {
    const d = wanted.get(id) as DesiredSchedule & { timezone?: string }
    try {
      if (plan.change.includes(id)) app.cron.unschedule(id)
      app.cron.schedule(id, d.expression, d.run, {
        ...(d.description ? { description: d.description } : {}),
        ...(d.idempotent ? { idempotent: d.idempotent } : {}),
        ...(d.timezone ? { timezone: d.timezone } : {})
      })
      ;(plan.change.includes(id) ? out.rescheduled : out.scheduled).push(id)
    } catch (err) {
      out.invalid.push({ id, error: (err as Error)?.message ?? 'Invalid schedule' })
    }
  }
  return out
}

/** Hub shared deployment: the app's business zone, read by resyncSchedules before a source runs
 *  and used by reconcile (which is synchronous) inside that app. Per app; unused elsewhere. */
const appZone = appBox<string | null>(() => null)

type Resync = (app: FastifyInstance) => Promise<ReconcileResult>
const resyncers = new Map<string, Resync>()

export function registerScheduleResync(name: string, fn: Resync): void {
  resyncers.set(name, fn)
}

/** Test seam: forget a source a test registered. */
export function _unregisterScheduleResyncForTests(name: string): void {
  resyncers.delete(name)
}

/**
 * Bring one source's schedules in step with its rows. Nivaro Cloud: never (null). Hub shared
 * deployment: inside an app only — its rows, its bound entries; outside any app there is no
 * database to read and an entry would bind to no app (null).
 */
export async function resyncSchedules(
  app: FastifyInstance,
  name: string
): Promise<ReconcileResult | null> {
  const fn = resyncers.get(name)
  if (!fn || !app.cron || isNivaroCloud()) return null
  if (perAppJobs() && !getTenantId()) return null
  try {
    if (perAppJobs()) {
      const { appTimeZone } = await import('./user-time.js')
      appZone.value = await appTimeZone()
    }
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

/** The deployment-wide channel a shared deployment announces schedule changes on. */
export const rowSchedulesChannel = (): string =>
  `${process.env.REDIS_CHANNEL_PREFIX ?? ''}nvr:row-schedules`

// Hub shared deployment: the Redis client announcements are published on (set at boot by
// registerRowScheduleLifecycle; null elsewhere).
let publisher: Pick<Redis, 'publish'> | null = null

/**
 * Tell every other process that a schedule changed. Self-hosted (and cloud): move the schedules
 * epoch, as before. Hub shared deployment: publish `<app id>|<source name or *>` on the
 * deployment's channel, from inside the app the change belongs to (outside any app: nothing).
 */
export function announceScheduleChange(name?: string): void {
  if (perAppJobs()) {
    const tenantId = getTenantId()
    if (!tenantId || !publisher) return
    publisher.publish(rowSchedulesChannel(), `${tenantId}|${name ?? '*'}`).catch(() => {})
    return
  }
  void bumpEpoch(SCHEDULES_EPOCH)
}

/**
 * Hub shared deployment: one announcement heard on the channel. Resolves the named app and, when
 * it is listed, active and ready, runs the named source's resync — or
 * every source for `*` — inside it. Anything else is skipped silently: an app this process has
 * not listed yet is hydrated when it becomes ready and by the five-minute resync.
 */
export async function onRowScheduleMessage(app: FastifyInstance, raw: string): Promise<void> {
  const bar = raw.indexOf('|')
  if (bar <= 0) return
  const tenantId = raw.slice(0, bar)
  const name = raw.slice(bar + 1)
  const registry = getTenantRegistry()
  if (!registry) return
  let t: TenantRecord | null = null
  try {
    t = (await registry.byId?.(tenantId)) ?? null
    if (!t) t = (await registry.listActive()).find((x) => x.id === tenantId) ?? null
  } catch {
    return
  }
  // Like the per-app fan-out: never an app the Hub is moving or updating, nor a half-migrated one.
  if (!t || t.status !== 'active') return
  if (!appReadyForRequests(t.id)) return
  try {
    await withTenant(
      t,
      async () => {
        if (name === '*' || name === '') await resyncAllSchedules(app)
        else await resyncSchedules(app, name)
      },
      t.origin
    )
  } catch (err) {
    app.log.warn({ err, tenant: t.id, name }, 'Schedules could not be brought in step')
  }
}

/** Every source, the activity-views one included (it registers when its module loads). */
async function resyncEverySource(app: FastifyInstance): Promise<void> {
  await import('./activity-views.js')
  await resyncAllSchedules(app)
}

/**
 * Hub shared deployment: row schedules per app. Call once at boot, outside any app, before the
 * app migrations start (an app already ready when its hook registers never fires it):
 *   - an app that becomes ready has every source reconciled inside it;
 *   - an app that leaves has its bound entries dropped;
 *   - `row-schedules-resync` (every five minutes, once per app) catches anything missed;
 *   - a subscriber hears every replica's announcements (see onRowScheduleMessage).
 * Self-hosted and Nivaro Cloud: nothing (self-hosted keeps its boot resync and the epoch).
 */
export function registerRowScheduleLifecycle(app: FastifyInstance): void {
  if (!perAppJobs()) return
  onAppReady('row-schedules', () => resyncEverySource(app))
  onAppLeft('row-schedules', (tenantId) => {
    app.cron?.unscheduleTenant(tenantId)
  })
  // Described in services/cron-descriptions.ts; scope in services/cron-scope.ts.
  app.cron?.schedule('row-schedules-resync', '*/5 * * * *', () => resyncEverySource(app), {
    idempotent: 'safe',
    scope: 'app'
  })
  const redis = (app as unknown as { redis?: Redis }).redis
  if (!redis) return
  publisher = redis
  const channel = rowSchedulesChannel()
  const sub = redis.duplicate()
  sub.on('error', () => {})
  sub.on('message', (ch: string, raw: string) => {
    if (ch !== channel) return
    void onRowScheduleMessage(app, raw).catch(() => {})
  })
  sub.subscribe(channel).catch((err: unknown) => {
    app.log.warn({ err }, 'Row-schedule announcements could not be subscribed to')
  })
  app.addHook('onClose', async () => {
    if (publisher === redis) publisher = null
    await sub.quit().catch(() => {})
  })
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
    announceScheduleChange(name)
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
      // A rerun judges the same people again and skips anyone already
      // redacted, so a repeated tick changes nothing twice.
      idempotent: 'safe',
      run: async () => {
        const fresh = await db('nivaro_retention_policies').where({ id: p.id }).first()
        if (!fresh?.is_active) return
        const { runRetentionPolicy } = await import('./retention.js')
        // Same path as Run now: honours dry_run_mode, records the run in
        // nivaro_retention_runs. A refusal (directory sync off or stale) or an
        // error fails the job so Background Jobs shows it instead of "completed".
        let result: Awaited<ReturnType<typeof runRetentionPolicy>>
        try {
          result = await runRetentionPolicy(fresh, { dryRun: false, source: 'schedule' })
        } catch (err) {
          app.log.error({ err }, `[retention] policy ${p.id} cron failed`)
          throw err
        }
        if (result.refused) throw new Error(`Retention policy ${p.id} refused: ${result.refused}`)
        if (result.errors.length > 0) {
          throw new Error(
            `Retention policy ${p.id}: ${result.errors.length} error(s) — ${result.errors[0]}`.slice(
              0,
              500
            )
          )
        }
        app.log.info(
          `[retention] policy ${p.id} ${result.dryRun ? 'dry run' : 'live run'}: ${result.affectedCount} affected`
        )
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

import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Maintenance lifecycle (#214/#303) + smoke checks (#299): scheduled windows
 * flip maintenance mode on entry and off on exit; the exit runs a smoke check
 * and — when it passes — auto-sends the "we're back" broadcast, so the
 * all-clear is a verified statement, not a hope. The same smoke check runs
 * after a deploy (version change) for a minute-one verdict.
 */

export interface SmokeResult {
  ok: boolean
  checks: Array<{ name: string; ok: boolean; detail?: string }>
}

export async function runSmokeCheck(app: FastifyInstance): Promise<SmokeResult> {
  const checks: SmokeResult['checks'] = []
  const add = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn()
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) })
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    }
  }
  await add('database', async () => {
    await db.raw('SELECT 1')
  })
  await add('redis', async () => {
    const redis = (app as unknown as { redis?: { ping: () => Promise<string> } }).redis
    if (!redis) throw new Error('not connected')
    await redis.ping()
  })
  await add('migrations', async () => {
    const n = (await db('nivaro_migrations').count('* as n').first()) as { n: number }
    return `${n.n} applied`
  })
  await add('collections-read', async () => {
    const n = (await db('nivaro_collections').count('* as n').first()) as { n: number }
    if (Number(n.n) === 0) throw new Error('zero registered collections')
    return `${n.n} collections`
  })
  await add('api-self', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/version' })
    if (res.statusCode !== 200) throw new Error(`GET /api/version → ${res.statusCode}`)
  })
  return { ok: checks.every((c) => c.ok), checks }
}

/** Per-minute sweep: activate due windows, complete expired ones. */
export async function sweepMaintenanceWindows(app: FastifyInstance): Promise<void> {
  const now = new Date()
  const { bustMaintenanceCache } = await import('./security.js')

  const due = (await db('nivaro_maintenance_windows')
    .where('status', 'scheduled')
    .where('starts_at', '<=', now)
    .where('ends_at', '>', now)) as Array<{ id: number; title: string; message: string | null }>
  for (const w of due) {
    await db('nivaro_settings')
      .orderBy('id', 'asc')
      .first('id')
      .then((row) =>
        row
          ? db('nivaro_settings').where({ id: row.id }).update({
              maintenance_mode: 1,
              maintenance_message:
                w.message ?? `Scheduled maintenance (${w.title}) — changes are temporarily disabled.`
            })
          : null
      )
    await db('nivaro_maintenance_windows')
      .where({ id: w.id })
      .update({ status: 'active', activated_at: now })
    bustMaintenanceCache()
    app.log.warn(`Maintenance window "${w.title}" started — maintenance mode ON`)
  }

  const expired = (await db('nivaro_maintenance_windows')
    .where('status', 'active')
    .where('ends_at', '<=', now)) as Array<{ id: number; title: string; send_all_clear: boolean | number }>
  for (const w of expired) {
    await db('nivaro_settings')
      .orderBy('id', 'asc')
      .first('id')
      .then((row) =>
        row
          ? db('nivaro_settings').where({ id: row.id }).update({ maintenance_mode: 0 })
          : null
      )
    bustMaintenanceCache()
    await db('nivaro_maintenance_windows')
      .where({ id: w.id })
      .update({ status: 'completed', completed_at: now })
    // #303 — verified all-clear: smoke first, broadcast only on a pass.
    const smoke = await runSmokeCheck(app)
    if (!smoke.ok) {
      const { trackError } = await import('./error-tracking.js')
      await trackError({
        source: 'server',
        route: 'maintenance-window',
        severity: 'high',
        message: `Maintenance window "${w.title}" ended but the smoke check FAILED: ${smoke.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join(', ')} — no all-clear was sent`
      })
      continue
    }
    if (w.send_all_clear) {
      try {
        await db('nivaro_announcements').insert({
          subject: 'Maintenance complete',
          message: `Scheduled maintenance (${w.title}) is finished and the system checked out healthy — you're good to continue.`,
          severity: 'info',
          channels: JSON.stringify(['message']),
          audience: null,
          is_active: 0,
          created_at: now
        })
        const row = (await db('nivaro_announcements').orderBy('id', 'desc').first('id')) as { id: number }
        const { deliverAnnouncement } = await import('../routes/announcements.js')
        await deliverAnnouncement(app, row.id)
      } catch (err) {
        app.log.warn({ err }, 'All-clear broadcast failed')
      }
    }
    app.log.info(`Maintenance window "${w.title}" completed — maintenance mode OFF`)
  }
}

/** #299 — post-deploy smoke: when the running version differs from the last
 *  one this Redis saw, run the smoke suite once and record a verdict. */
export async function postDeploySmoke(app: FastifyInstance): Promise<void> {
  try {
    const redis = (app as unknown as { redis?: { get: (k: string) => Promise<string | null>; set: (k: string, v: string) => Promise<unknown> } }).redis
    if (!redis) return
    const prev = await redis.get('nvr:last-version')
    if (prev === NIVARO_VERSION) return
    await redis.set('nvr:last-version', NIVARO_VERSION)
    if (!prev) return // first ever boot — nothing to compare against
    const smoke = await runSmokeCheck(app)
    if (smoke.ok) {
      app.log.info(`Post-deploy smoke PASSED on ${prev} → ${NIVARO_VERSION} (${smoke.checks.length} checks)`)
    } else {
      const { trackError } = await import('./error-tracking.js')
      await trackError({
        source: 'server',
        route: 'post-deploy-smoke',
        severity: 'critical',
        message: `Deploy ${prev} → ${NIVARO_VERSION}: smoke check FAILED — ${smoke.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join(', ')}`
      })
    }
  } catch {
    /* smoke is advisory — never affect boot */
  }
}

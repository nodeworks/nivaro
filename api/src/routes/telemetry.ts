import type { FastifyInstance } from 'fastify'
import { runInBackgroundPool } from '../db/pool-context.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { JobBusyError } from '../plugins/cron.js'
import { logActivity } from '../services/activity.js'
import type { HealthStore } from '../services/infra-swarm/health.js'
import { clientGoneSignal } from '../services/read-gate.js'
import {
  DRILL_JOB_ID,
  isDrillRunning,
  listDrillRuns,
  runRestoreDrill
} from '../services/recovery/drill.js'
import {
  effectiveRecovery,
  getRecoverySettings,
  RecoverySettingsError,
  saveRecoverySettings
} from '../services/recovery/settings.js'
import { markDrillQueued, recoveryStatus } from '../services/recovery/status.js'
import { type AskTurn, askTelemetry, TelemetryAskError } from '../services/telemetry-ai.js'
import { telemetryStatus } from '../services/telemetry-status.js'
import { storeEnabled } from '../services/telemetry-store.js'
import { listStoredTraces } from '../services/telemetry-traces.js'

/**
 * The external telemetry stack, seen from Nivaro (#2544): settings, what this process sends,
 * what arrived, the stack's own health, recent slow traces, and asking AI about it.
 * Administrators only.
 *
 * Recovery (#2801 / #2802):
 *   GET   /recovery                 the RPO / RTO panel: targets, backups, restore drill, chaos
 *                                   recovery, one judged row each (?fresh=1 re-reads msdb)
 *   PATCH /recovery/settings        targets, runbook link, drill settings (this instance only)
 *   POST  /restore-drill/run        202: the drill runs in the background (heavy slot);
 *                                   ?dry_run=1 answers at once — msdb + FILELISTONLY only
 *   GET   /restore-drill/runs/:id   one drill's full stored result
 */
export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/status', async () => ({ data: await telemetryStatus() }))

  app.get<{ Querystring: { fresh?: string } }>('/recovery', async (req) => ({
    data: await recoveryStatus({ fresh: req.query.fresh === '1' })
  }))

  app.patch('/recovery/settings', async (req, reply) => {
    try {
      const next = await saveRecoverySettings(req.body ?? {})
      await logActivity({
        action: 'recovery-settings',
        user: req.user?.id,
        collection: 'nivaro_settings_overrides',
        comment: 'Recovery settings changed',
        req
      })
      return { data: next }
    } catch (err) {
      if (err instanceof RecoverySettingsError)
        return reply.code(400).send({ error: err.message, code: 'RECOVERY_SETTINGS' })
      throw err
    }
  })

  app.post<{ Querystring: { dry_run?: string } }>('/restore-drill/run', async (req, reply) => {
    const settings = effectiveRecovery(await getRecoverySettings())
    if (settings.cloud)
      return reply
        .code(409)
        .send({ error: 'Restore drills do not run on cloud instances', code: 'DRILL_OFF' })
    if (req.query.dry_run === '1' || req.query.dry_run === 'true') {
      // Read-only: msdb, the server's rights and paths, RESTORE FILELISTONLY. Nothing stored.
      const result = await runInBackgroundPool(() => runRestoreDrill({ dryRun: true, settings }))
      return { data: result }
    }
    if (!settings.drill_enabled)
      return reply.code(409).send({
        error:
          'The restore drill is off on this instance. Turn it on in the settings (or RESTORE_DRILL=on), or run a dry run.',
        code: 'DRILL_OFF'
      })
    if (isDrillRunning() || (await listDrillRuns(1)).some((r) => r.status === 'running'))
      return reply
        .code(409)
        .send({ error: 'A restore drill is already running', code: 'DRILL_RUNNING' })
    const userId = req.user?.id ?? null
    markDrillQueued(true)
    // The CronManager owns the run: its job row, the cluster-wide heavy slot (it may wait its
    // turn), the unsafe-twice guard and the background pool.
    void app.cron
      .runNow(DRILL_JOB_ID, userId)
      .catch((err) => {
        if (!(err instanceof JobBusyError)) req.log.error({ err }, 'restore drill run failed')
      })
      .finally(() => markDrillQueued(false))
    await logActivity({
      action: 'restore-drill-run',
      user: userId ?? undefined,
      collection: 'nivaro_job_runs',
      comment: 'Restore drill started',
      req
    })
    return reply.code(202).send({ data: { started: true } })
  })

  app.get<{ Params: { id: string } }>('/restore-drill/runs/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const row = (await listDrillRuns(50)).find((r) => r.id === id)
    if (!row) return reply.code(404).send({ error: 'No such restore drill run', code: 'NOT_FOUND' })
    return { data: row }
  })

  // The slowest (or failed) traced requests of the last `minutes` (default 60, up to a week).
  app.get<{ Querystring: { minutes?: string; errors_only?: string; limit?: string } }>(
    '/traces',
    async (req, reply) => {
      if (!storeEnabled())
        return reply
          .code(409)
          .send({ error: 'The telemetry store is not configured', code: 'STORE_OFF' })
      const minutes = Math.min(7 * 1440, Math.max(5, Number(req.query.minutes) || 60))
      const now = Date.now()
      try {
        const rows = await listStoredTraces({
          from: now - minutes * 60_000,
          to: now,
          errorsOnly: req.query.errors_only === 'true',
          limit: Math.min(25, Math.max(1, Number(req.query.limit) || 10))
        })
        return { data: { minutes, traces: rows } }
      } catch (err) {
        req.log.warn({ err }, 'telemetry traces read failed')
        return reply
          .code(503)
          .send({ error: 'The traces store did not answer', code: 'STORE_UNAVAILABLE' })
      }
    }
  )

  // Ask AI about the telemetry: a few questions a minute per person (each runs several tools).
  const recent = new Map<string, number[]>()
  app.post<{ Body: { question?: string; history?: AskTurn[] } }>('/ask', async (req, reply) => {
    const who = String(req.user?.id ?? '')
    const now = Date.now()
    const mine = (recent.get(who) ?? []).filter((t) => now - t < 60_000)
    if (mine.length >= 6)
      return reply
        .code(429)
        .send({ error: 'Too many questions in a minute; try again shortly', code: 'RATE_LIMITED' })
    mine.push(now)
    recent.set(who, mine)
    try {
      const out = await askTelemetry(String(req.body?.question ?? ''), req.user!, {
        history: Array.isArray(req.body?.history) ? req.body.history : [],
        signal: clientGoneSignal(reply.raw),
        redis: app.redis as unknown as HealthStore
      })
      return { data: out }
    } catch (err) {
      if (err instanceof TelemetryAskError)
        return reply.code(err.status).send({ error: err.message, code: 'TELEMETRY_ASK' })
      throw err
    }
  })
}

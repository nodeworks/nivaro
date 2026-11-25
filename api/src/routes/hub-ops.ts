import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam } from '../services/hub/apps.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import { claimOpsLease, releaseOpsLease } from '../services/hub/ops/health-row.js'
import {
  collectIssues,
  issueGroupDetail,
  issueReadStates,
  listIssueGroups
} from '../services/hub/ops/issues.js'
import {
  checkSecret,
  isSecretKind,
  KINDS,
  markRotated,
  readPolicies,
  rotateHubToken,
  rotationHistory,
  runDueChecks,
  SECRETS,
  SecretRotateError,
  savePolicy,
  scanSecrets,
  secretInventory,
  sendReminders,
  validatePolicy
} from '../services/hub/ops/secrets.js'
import {
  checkDriverStorageNow,
  collectDriverStorage,
  collectFilesUsage,
  driverStorage,
  storageOverview
} from '../services/hub/ops/storage.js'
import { PromotionError } from '../services/hub/promote-lock.js'

/**
 * Hub operations (enhancements 10, 19, 20), mounted under /api/hub only with HUB=on:
 *
 *   GET  /ops/issues?app_id&environment_id&kind&severity&status&multi&q  admin + owner
 *   GET  /ops/issues/reads                         admin + owner  when each environment was read
 *   GET  /ops/issues/:sig                          admin + owner  one signature per environment
 *   POST /ops/collect                              admin          read issues + storage now (202)
 *   GET  /ops/storage                              admin + owner  drivers (admins) + environments
 *   GET  /drivers/:id/storage                      admin          the driver's last reading
 *   POST /drivers/:id/storage/check                admin          read the agent now
 *   GET  /secrets                                  admin          inventory + policies
 *   GET  /secrets/history?ref=                     admin          one secret's rotations
 *   PUT  /secrets/policies/:kind                   admin          {every_days, remind_days}
 *   POST /secrets/rotate {ref, confirm}            admin          hub token of a Docker env
 *   POST /secrets/rotated {ref}                    admin          after an existing rotate route
 *   POST /secrets/check {ref}                      admin          the readiness check now
 *
 * Owners see only the environments of apps they own. Every write is logged; the root
 * maintenance freeze covers them. Never a secret value, a sealed string or an app's raw text.
 * Crons (Hub only, where crons tick): hub-ops-collect (every 15 min) and hub-secrets (every 15
 * min: scan for rotations, due readiness checks, reminders).
 */

type Body = Record<string, unknown>

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

function userId(req: FastifyRequest): string {
  return String(req.user?.id ?? '')
}

function viewer(req: FastifyRequest) {
  return { userId: userId(req), isAdmin: !!req.isAdmin }
}

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

const REF_RE = /^[a-z_]{3,32}:[A-Za-z0-9_:-]{1,90}$/

/** One collection run (the caller holds the ops lease). */
async function collectHeld(): Promise<{ issues: number; files: number; drivers: number }> {
  try {
    const issues = await collectIssues()
    const files = await collectFilesUsage()
    const drivers = await collectDriverStorage()
    return { issues: issues.read, files, drivers }
  } finally {
    await releaseOpsLease().catch(() => undefined)
  }
}

/**
 * The ops collection (cron + Read now): single flight across processes (the ops lease), on the
 * background pool. null = another run holds the lease.
 */
export async function collectOps(): Promise<{
  issues: number
  files: number
  drivers: number
} | null> {
  return runInBackgroundPool(async () => {
    if (!(await claimOpsLease())) return null
    return collectHeld()
  })
}

export async function hubOpsRoutes(app: FastifyInstance): Promise<void> {
  if (!hubModeEnabled()) return

  // ── issues ────────────────────────────────────────────────────────────────────────────────
  app.get('/ops/issues', { preHandler: requireAuth }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>
    const kind = q.kind === 'crash' || q.kind === 'server' ? q.kind : null
    const status = q.status === 'open' || q.status === 'resolved' ? q.status : null
    const data = await listIssueGroups(viewer(req), {
      app_id: idParam(q.app_id),
      environment_id: idParam(q.environment_id),
      kind,
      severity: typeof q.severity === 'string' && q.severity ? q.severity.slice(0, 20) : null,
      status,
      multi: q.multi === '1' || q.multi === 'true',
      q: typeof q.q === 'string' ? q.q.slice(0, 200) : null
    })
    return { data }
  })

  app.get('/ops/issues/reads', { preHandler: requireAuth }, async (req) => ({
    data: await issueReadStates(viewer(req))
  }))

  app.get('/ops/issues/:sig', { preHandler: requireAuth }, async (req, reply) => {
    const sig = String((req.params as { sig?: string }).sig ?? '').toLowerCase()
    const rows = await issueGroupDetail(viewer(req), sig)
    if (!rows.length) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    return { data: rows }
  })

  app.post('/ops/collect', { preHandler: requireAdmin }, async (req, reply) => {
    // Taken here so a second click answers at once; the run itself goes on in the background.
    if (!(await claimOpsLease()))
      return fail(reply, 409, 'COLLECT_RUNNING', 'The apps are being read already.')
    await logActivity({
      action: 'hub-ops-collect',
      user: userId(req),
      collection: 'nivaro_hub_issue_groups',
      req
    })
    void runInBackgroundPool(() => collectHeld()).catch((err) =>
      req.log.warn({ err: (err as Error | null)?.name ?? 'Error' }, 'hub ops: collect failed')
    )
    return reply.code(202).send({ data: { started: true } })
  })

  // ── storage ───────────────────────────────────────────────────────────────────────────────
  app.get('/ops/storage', { preHandler: requireAuth }, async (req) => ({
    data: await storageOverview(viewer(req))
  }))

  app.get('/drivers/:id/storage', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    return { data: await driverStorage(id) }
  })

  app.post('/drivers/:id/storage/check', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const row = await checkDriverStorageNow(id)
    if (!row) return fail(reply, 404, 'NOT_FOUND', 'Not a Docker driver')
    return { data: row }
  })

  // ── secrets ───────────────────────────────────────────────────────────────────────────────
  app.get('/secrets', { preHandler: requireAdmin }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store')
    const [items, policies] = await Promise.all([secretInventory(), readPolicies()])
    return { data: { items, policies, kinds: KINDS } }
  })

  app.get('/secrets/history', { preHandler: requireAdmin }, async (req, reply) => {
    const ref = String((req.query as { ref?: string } | null)?.ref ?? '')
    if (!REF_RE.test(ref)) return fail(reply, 400, 'BAD_REF', 'ref names no secret')
    return { data: await rotationHistory(ref) }
  })

  app.put('/secrets/policies/:kind', { preHandler: requireAdmin }, async (req, reply) => {
    const kind = (req.params as { kind?: string }).kind
    if (!isSecretKind(kind)) return fail(reply, 404, 'NOT_FOUND', 'No such kind of secret')
    const v = validatePolicy(kind, body(req))
    if (!v.ok) return fail(reply, 400, v.code, v.message)
    await savePolicy(kind, v, userId(req))
    await logActivity({
      action: 'hub-secret-policy',
      user: userId(req),
      collection: 'nivaro_hub_secret_policies',
      item: kind,
      comment:
        v.every_days == null
          ? `${KINDS[kind].label}: no schedule`
          : `${KINDS[kind].label}: every ${v.every_days} days, reminder ${v.remind_days} days before`,
      req
    })
    return { data: (await readPolicies())[kind] }
  })

  app.post('/secrets/rotate', { preHandler: requireAdmin }, async (req, reply) => {
    const b = body(req)
    const ref = typeof b.ref === 'string' ? b.ref : ''
    const m = /^hub_token:(\d{1,15})$/.exec(ref)
    if (!m)
      return fail(
        reply,
        400,
        'NOT_HELPER_ROTATED',
        'The Hub rotates only a Docker environment’s hub token here; rotate other secrets where they live.'
      )
    const envId = Number(m[1])
    const env = (await db('nivaro_hub_environments').where({ id: envId }).first('key')) as
      | { key: string }
      | undefined
    if (!env) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    if (b.confirm !== env.key)
      return fail(reply, 400, 'CONFIRM_REQUIRED', `Type the environment key (${env.key}) to rotate`)
    try {
      // An emergency rotation after a leak may start outside the deploy windows (admin, own
      // session, typed reason: services/hub/changes/emergency.ts); freezes still hold it.
      const emergency = await import('../services/hub/changes/emergency.js')
      let outside: { reason: string } | null
      try {
        outside = emergency.outsideWindowOf(req, b)
      } catch (e) {
        if (e instanceof emergency.OutsideWindowError)
          return fail(reply, e.status, e.code, e.message)
        throw e
      }
      const appRow = (await db('nivaro_hub_environments').where({ id: envId }).first('app_id')) as
        | { app_id: number }
        | undefined
      const appIds = appRow ? [Number(appRow.app_id)] : []
      const closed = outside
        ? await emergency.windowWasClosed({ appIds, action: 'apply', envId })
        : false
      const out = await rotateHubToken(envId, {
        id: userId(req),
        ...(outside ? { outsideWindow: outside } : {})
      })
      if (outside && closed)
        await emergency.recordOutsideWindow({
          req,
          userId: userId(req),
          action: 'apply',
          appIds,
          where: env.key,
          reason: outside.reason,
          collection: 'nivaro_hub_deploys',
          item: String(out.deploy_id)
        })
      await logActivity({
        action: 'hub-secret-rotate',
        user: userId(req),
        collection: SECRETS,
        item: ref,
        comment: `Hub token rotated; Apply now started (deploy ${out.deploy_id})`,
        req
      })
      return reply.code(202).send({ data: out })
    } catch (err) {
      if (err instanceof SecretRotateError) return fail(reply, err.status, err.code, err.message)
      if (err instanceof PromotionError)
        return reply
          .code(err.status === 404 ? 404 : 409)
          .send({ error: err.message, code: err.code, blockers: err.blockers })
      throw err
    }
  })

  app.post('/secrets/rotated', { preHandler: requireAdmin }, async (req, reply) => {
    const ref = typeof body(req).ref === 'string' ? String(body(req).ref) : ''
    if (!REF_RE.test(ref)) return fail(reply, 400, 'BAD_REF', 'ref names no secret')
    const out = await markRotated(ref, userId(req))
    if (!out.rotated)
      return fail(reply, 409, 'NOT_ROTATED', 'That secret has not changed since it was last seen.')
    await logActivity({
      action: 'hub-secret-rotate',
      user: userId(req),
      collection: SECRETS,
      item: ref,
      comment: 'Rotation recorded; readiness check in 5 minutes',
      req
    })
    return { data: out }
  })

  app.post('/secrets/check', { preHandler: requireAdmin }, async (req, reply) => {
    const ref = typeof body(req).ref === 'string' ? String(body(req).ref) : ''
    if (!REF_RE.test(ref)) return fail(reply, 400, 'BAD_REF', 'ref names no secret')
    const row = await db(SECRETS).where({ ref }).first('ref')
    if (!row) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const out = await checkSecret(ref)
    const state = out.state === 'wait' ? 'pending' : out.state
    await db(SECRETS)
      .where({ ref })
      .update({ check_state: state, check_detail: out.detail.slice(0, 300) })
    await logActivity({
      action: 'hub-secret-check',
      user: userId(req),
      collection: SECRETS,
      item: ref,
      comment: `${state}: ${out.detail}`.slice(0, 300),
      req
    })
    return { data: { state, detail: out.detail } }
  })

  // ── scheduled work (Hub only; the scheduler fires only where crons tick, one leader) ───────
  app.cron?.schedule(
    'hub-ops-collect',
    '*/15 * * * *',
    async () => {
      const r = await collectOps()
      if (!r) {
        app.log.info('hub-ops-collect: another run holds the lease; skipped')
        return
      }
      app.log.info(
        `hub-ops-collect: issues from ${r.issues} environments, files from ${r.files}, storage of ${r.drivers} drivers`
      )
    },
    {
      quiet: true,
      idempotent: 'safe',
      description:
        'Every 15 minutes (Hub only) — reads each environment’s issue/crash group summaries and stored-files usage over its hub or deployment link, and each Docker driver’s volume storage from its agent; warns administrators and owners when a driver’s storage passes 80 % / 90 %. Replaces nivaro_hub_issue_groups rows per environment; writes nivaro_hub_ops_health.'
    }
  )
  app.cron?.schedule(
    'hub-secrets',
    '7,22,37,52 * * * *',
    async () => {
      const scan = await scanSecrets()
      const checks = await runDueChecks()
      const reminded = await sendReminders()
      app.log.info(
        `hub-secrets: ${scan.found} secrets, ${scan.rotated.length} rotations seen, ${checks.ran} checks (${checks.failed} failed), ${reminded} reminders`
      )
    },
    {
      quiet: true,
      idempotent: 'safe',
      description:
        'Every 15 minutes (Hub only) — fingerprints every secret the Hub holds (sealed values, never opened) to see rotations, runs the readiness check 5 minutes after each rotation, and reminds administrators of secrets due for rotation (once per due date). Writes nivaro_hub_secrets and nivaro_hub_secret_rotations only.'
    }
  )
}

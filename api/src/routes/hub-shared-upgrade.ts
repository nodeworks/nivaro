import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { idParam } from '../services/hub/apps.js'
import { startWithChecklist } from '../services/hub/changes/checklist.js'
import { PromotionError } from '../services/hub/promote-lock.js'
import {
  appsOnShared,
  rollbackExempt,
  sharedFreezeRefusal,
  sharedRunningVersion
} from '../services/hub/releases/freeze.js'
import { HubSecretError } from '../services/hub/secrets.js'
import { getShared, type SharedDeployment } from '../services/hub/shared/store.js'
import {
  planSharedUpgrade,
  SharedUpgradeError,
  type SharedUpgradeKind
} from '../services/hub/shared/upgrade-plan.js'
import {
  cancelSharedUpgrade,
  healSharedBeforeRead,
  listSharedDeploys,
  readSharedDeploy,
  recoverSharedOnceAtBoot,
  startSharedReapply,
  startSharedUpgrade
} from '../services/hub/shared/upgrade-run.js'
import { setSharedReapply } from './hub-shared.js'

/**
 * Nivaro Hub phase 6 (Task 5): deploy, upgrade and roll back a Docker shared deployment, mounted
 * under /api/hub by hub.ts (HUB=on only). Every route is for a Hub administrator.
 *
 *   POST /shared/:id/upgrade/plan     {version, kind?} → {data: SharedUpgradePlan}
 *   POST /shared/:id/upgrade          {version, kind?, plan_hash, confirm, overrides?, downgrade?}
 *                                     → 202 {data: {shared_deploy_id}}; 409 PLAN_CHANGED carries
 *                                     the new plan (`plan`); BLOCKED / APP_BLOCKED too;
 *                                     409 DOWNGRADE_NEEDS_CONFIRM (plan.downgrade, an upgrade to
 *                                     an older version without `downgrade: true`, P6-29);
 *                                     400 CONFIRM_MISMATCH / BAD_DOWNGRADE
 *   GET  /shared/:id/deploys          {data: [...]} — the deployment's runs, newest first
 *   GET  /shared-deploys/:id          {data: run + plan + apps (mirror rows) + log}
 *   POST /shared-deploys/:id/cancel   {data: {interrupted?}}; 409 NOT_RUNNING
 *
 * Also registers the token-rotation re-apply (routes/hub-shared.ts setSharedReapply, R7) and heals
 * runs a previous process left `running` once at boot.
 */

function refuse(reply: FastifyReply, status: number, code: string, message: string, extra = {}) {
  return reply.code(status).send({ statusCode: status, error: message, message, code, ...extra })
}

async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (e) {
    if (e instanceof SharedUpgradeError)
      return refuse(reply, e.statusCode, e.code, e.message, e.plan ? { plan: e.plan } : {})
    if (e instanceof PromotionError)
      return refuse(reply, e.status === 503 ? 503 : 409, e.code, e.message)
    if (e instanceof HubSecretError) return refuse(reply, 400, e.code, e.message)
    throw e
  }
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

function kindOf(v: unknown): SharedUpgradeKind | null {
  if (v === undefined || v === null || v === 'upgrade') return 'upgrade'
  return v === 'rollback' ? 'rollback' : null
}

/**
 * What a shared deployment's link answers as its version (bounded 3 s), or null (no answer, a
 * deployment not running yet). The rollback exemption judges what RUNS, never the pin alone.
 */
export async function sharedLiveVersion(shared: SharedDeployment): Promise<string | null> {
  if (shared.status === 'retired') return null
  try {
    const { deploymentClient } = await import('../services/hub/shared/deployment-client.js')
    let timer: NodeJS.Timeout | undefined
    const st = await Promise.race([
      deploymentClient(shared).status(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3000)
      })
    ]).finally(() => clearTimeout(timer))
    const v = (st as { version?: unknown } | null)?.version
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

/** APP_WINDOW_CLOSED warnings for the apps placed on a shared deployment (best effort). */
async function appWindowWarnings(sharedId: number): Promise<Array<{ code: string; text: string }>> {
  try {
    const { db } = await import('../db/index.js')
    const { envPolicy } = await import('../services/hub/owner-access.js')
    const { closedAppWindows } = await import('../services/hub/releases/windows.js')
    const rows = (await db('nivaro_hub_environments as e')
      .join('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
      .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
      .where('p.shared_deployment_id', sharedId)
      .select('e.id as env_id', 'a.id as app_id', 'a.key as app_key')) as Array<{
      env_id: number
      app_id: number
      app_key: string
    }>
    const apps = await Promise.all(
      rows.map(async (r) => ({
        app_id: Number(r.app_id),
        key: String(r.app_key),
        production: (await envPolicy(Number(r.env_id)))?.production ?? true
      }))
    )
    return (await closedAppWindows(apps)).map((w) => ({ code: 'APP_WINDOW_CLOSED', text: w.text }))
  } catch {
    return []
  }
}

export function hubSharedUpgradeRoutes(app: FastifyInstance): void {
  app.addHook('onReady', async () => recoverSharedOnceAtBoot(app.log))
  setSharedReapply((shared, by) => startSharedReapply(shared, by))

  app.post('/shared/:id/upgrade/plan', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such shared deployment.')
    const b = body(req)
    const kind = kindOf(b.kind)
    if (!kind) return refuse(reply, 400, 'BAD_KIND', 'kind is upgrade or rollback.')
    if (typeof b.version !== 'string' || !b.version)
      return refuse(reply, 400, 'BAD_VERSION', 'The version is x.y.z (a Nivaro release).')
    const version = b.version
    return guarded(reply, async () => {
      await healSharedBeforeRead(id)
      const plan = await planSharedUpgrade(id, version, kind)
      // A placed app's OWN deploy window that is closed is a warning, never a block (the
      // Hub-wide windows and every app's freezes are what refuse an upgrade).
      const warnings = await appWindowWarnings(id)
      return {
        data: warnings.length
          ? { ...plan, warnings: [...(plan.warnings ?? []), ...warnings] }
          : plan
      }
    })
  })

  app.post('/shared/:id/upgrade', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such shared deployment.')
    // Release operations: every placed app's freezes (the frozen app named) and the Hub-wide
    // deploy windows stop an upgrade; only a rollback below the version the deployment RUNS —
    // its link's answer, else its last successful run, never the stored pin alone — is exempt
    // from freezes, windows and the checklist. An administrator's emergency start skips the
    // windows only (services/hub/changes/emergency.ts).
    const b = body(req)
    const emergency = await import('../services/hub/changes/emergency.js')
    let outside: { reason: string } | null
    try {
      outside = emergency.outsideWindowOf(req, b)
    } catch (e) {
      if (e instanceof emergency.OutsideWindowError)
        return refuse(reply, e.status, e.code, e.message)
      throw e
    }
    const shared = await getShared(id)
    const running = shared ? await sharedRunningVersion(id, await sharedLiveVersion(shared)) : null
    const kind = kindOf(b.kind) ?? 'upgrade'
    const version = typeof b.version === 'string' ? b.version : undefined
    const realRollback = kind === 'rollback' && !!version && rollbackExempt(version, running)
    const apps = realRollback ? [] : await appsOnShared(id).catch(() => [] as number[])
    const closed =
      outside && !realRollback
        ? await emergency.windowWasClosed({ appIds: apps, action: 'upgrade' })
        : false
    const frozen = await sharedFreezeRefusal(id, {
      kind,
      ...(version ? { version } : {}),
      running,
      ...(outside ? { skipWindows: true } : {})
    })
    if (frozen) return refuse(reply, frozen.status, frozen.code, frozen.message)
    return guarded(reply, async () => {
      const start = () => startSharedUpgrade(id, b, userId(req))
      // An upgrade of a deployment carrying production apps needs their pre-deploy checklist
      // ticked (services/hub/changes); a real rollback never waits on one.
      const out = realRollback
        ? await start()
        : await startWithChecklist(
            {
              target: { kind: 'shared', sharedId: id },
              action: 'upgrade',
              version: version ?? null,
              runId: b.checklist_run_id
            },
            'shared_deploy',
            start,
            (o) => o.shared_deploy_id
          )
      if (outside && closed)
        await emergency.recordOutsideWindow({
          req,
          userId: userId(req),
          action: 'upgrade',
          appIds: apps,
          where: shared ? `shared deployment ${shared.key}` : `shared deployment #${id}`,
          reason: outside.reason,
          collection: 'nivaro_hub_shared_deploys',
          item: String(out.shared_deploy_id)
        })
      return reply.code(202).send({ data: out })
    })
  })

  app.get('/shared/:id/deploys', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await getShared(id)))
      return refuse(reply, 404, 'NOT_FOUND', 'No such shared deployment.')
    await healSharedBeforeRead(id)
    return { data: await listSharedDeploys(id) }
  })

  app.get('/shared-deploys/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such shared deploy.')
    const first = await readSharedDeploy(id)
    if (!first) return refuse(reply, 404, 'NOT_FOUND', 'No such shared deploy.')
    if (first.status === 'running') {
      await healSharedBeforeRead(first.shared_deployment_id)
      return { data: (await readSharedDeploy(id)) ?? first }
    }
    return { data: first }
  })

  app.post('/shared-deploys/:id/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such shared deploy.')
    return guarded(reply, async () => ({ data: await cancelSharedUpgrade(id, userId(req)) }))
  })
}

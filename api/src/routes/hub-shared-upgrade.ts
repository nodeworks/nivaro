import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { idParam } from '../services/hub/apps.js'
import { PromotionError } from '../services/hub/promote-lock.js'
import { HubSecretError } from '../services/hub/secrets.js'
import { getShared } from '../services/hub/shared/store.js'
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
 *   POST /shared/:id/upgrade          {version, kind?, plan_hash, confirm, overrides?}
 *                                     → 202 {data: {shared_deploy_id}}; 409 PLAN_CHANGED carries
 *                                     the new plan (`plan`); BLOCKED / APP_BLOCKED too;
 *                                     400 CONFIRM_MISMATCH
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
      return { data: await planSharedUpgrade(id, version, kind) }
    })
  })

  app.post('/shared/:id/upgrade', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such shared deployment.')
    return guarded(reply, async () => {
      const out = await startSharedUpgrade(id, body(req), userId(req))
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

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { checkLimitsInput } from '../services/capacity/limits.js'
import { idParam } from '../services/hub/apps.js'
import { moveAdvice } from '../services/hub/capacity/advisor.js'
import { capacityOverview, capacityTrend } from '../services/hub/capacity/overview.js'
import {
  cancelRebalance,
  createRebalance,
  listRebalances,
  planRebalance,
  RebalanceError,
  readRebalance,
  type StartRebalanceBody,
  tickRebalances
} from '../services/hub/capacity/rebalance.js'
import { runCapacitySample } from '../services/hub/capacity/sample.js'
import {
  getLimits,
  normalizeSettings,
  readSettings,
  setLimits,
  writeSettings
} from '../services/hub/capacity/store.js'
import { moveOpenRefusal } from '../services/hub/move-open.js'
import { deploymentClient } from '../services/hub/shared/deployment-client.js'
import { getShared } from '../services/hub/shared/store.js'

/**
 * Nivaro Hub capacity (ideas 9, 13, 15, 16), mounted under /api/hub by hub.ts (HUB=on only).
 * Every route is for a Hub administrator (403 otherwise); every write is logged.
 *
 *   GET  /capacity?days=30                    → {data: CapacityOverview} (daily trend)
 *   GET  /capacity/environments/:envId?days=  → {data: {trend, latest}} (hourly)
 *   GET  /capacity/shared/:id?days=           → {data: {trend, latest}} (hourly)
 *   POST /capacity/sample                     → {data: SampleResult} (the job, now)
 *   GET  /capacity/settings | PUT {…}         → advisor thresholds
 *   GET  /capacity/limits/:envId | PUT {requests_per_minute, jobs, storage_mb} (null = none)
 *                                             → 409 MOVE_OPEN while a move holds the env
 *   GET  /capacity/advice                     → {data: Advice[]} (suggestions, plan links)
 *   POST /capacity/rebalance/plan {shared_ids, max_moves}  → {data: RebalanceProposal}
 *   POST /capacity/rebalances {shared_ids, moves, window, confirm:'rebalance'} → 202 {data:{id}}
 *   GET  /capacity/rebalances | /capacity/rebalances/:id
 *   POST /capacity/rebalances/:id/cancel      → stops before the next move
 *
 * Jobs: `hub-capacity-sample` every 15 minutes, `hub-rebalance-tick` every minute (cron leader).
 */

const ENVS = 'nivaro_hub_environments'
const PLACEMENTS = 'nivaro_hub_placements'

function refuse(reply: FastifyReply, status: number, code: string, message: string, extra = {}) {
  return reply.code(status).send({ statusCode: status, error: message, message, code, ...extra })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

function daysOf(req: FastifyRequest, dflt = 30): number {
  const n = Number((req.query as { days?: unknown } | undefined)?.days)
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : dflt
}

async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (e) {
    if (e instanceof RebalanceError) return refuse(reply, e.statusCode, e.code, e.message)
    throw e
  }
}

/** The shared deployment an environment is placed on, or null. */
async function sharedOfEnv(envId: number): Promise<number | null> {
  const env = (await db(ENVS).where({ id: envId }).first('placement_id')) as
    | { placement_id: number | null }
    | undefined
  if (!env?.placement_id) return null
  const p = (await db(PLACEMENTS)
    .where({ id: env.placement_id })
    .first('kind', 'shared_deployment_id')) as
    | { kind: string; shared_deployment_id: number | null }
    | undefined
  return p?.kind === 'shared' && p.shared_deployment_id != null
    ? Number(p.shared_deployment_id)
    : null
}

export function hubCapacityRoutes(app: FastifyInstance): void {
  app.get('/capacity', { preHandler: requireAdmin }, async (req) => ({
    data: await capacityOverview(daysOf(req))
  }))

  app.get('/capacity/environments/:envId', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = idParam((req.params as { envId?: string }).envId)
    if (envId === null) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    return reply.send({ data: await capacityTrend({ envId }, daysOf(req)) })
  })

  app.get('/capacity/shared/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id?: string }).id)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such shared deployment.')
    return reply.send({ data: await capacityTrend({ sharedId: id }, daysOf(req)) })
  })

  app.post('/capacity/sample', { preHandler: requireAdmin }, async () => ({
    data: await runCapacitySample()
  }))

  app.get('/capacity/settings', { preHandler: requireAdmin }, async () => ({
    data: await readSettings()
  }))

  app.put('/capacity/settings', { preHandler: requireAdmin }, async (req) => {
    const s = normalizeSettings(body(req))
    await writeSettings(s, userId(req))
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: 'nivaro_hub_capacity_settings',
      item: 'capacity',
      req,
      changed_fields: ['fits', 'outgrew', 'most_share', 'min_samples']
    })
    return { data: s }
  })

  app.get('/capacity/limits/:envId', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = idParam((req.params as { envId?: string }).envId)
    if (envId === null || !(await db(ENVS).where({ id: envId }).first('id')))
      return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    return reply.send({ data: await getLimits(envId) })
  })

  app.put('/capacity/limits/:envId', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = idParam((req.params as { envId?: string }).envId)
    if (envId === null || !(await db(ENVS).where({ id: envId }).first('id')))
      return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    const checked = checkLimitsInput(req.body)
    if (!checked.ok)
      return refuse(reply, 400, 'BAD_LIMIT', checked.message, { field: checked.field })
    // A move reads the environment's placement and tenant entry: limits wait for it to end.
    const open = await moveOpenRefusal({ envIds: [envId] })
    if (open) return refuse(reply, 409, open.code, open.message, { move_id: open.move_id })
    const changed = await setLimits(envId, checked.limits, userId(req))
    if (changed) {
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: 'nivaro_hub_app_limits',
        item: String(envId),
        req,
        changed_fields: Object.keys(checked.limits).length
          ? Object.keys(checked.limits)
          : ['requests_per_minute', 'jobs', 'storage_mb']
      })
      // Its deployment re-reads the tenant list now rather than at its next poll (best effort).
      const sharedId = await sharedOfEnv(envId)
      const shared = sharedId ? await getShared(sharedId) : null
      if (shared)
        void deploymentClient(shared)
          .refresh()
          .catch(() => undefined)
    }
    return reply.send({ data: await getLimits(envId), changed })
  })

  app.get('/capacity/advice', { preHandler: requireAdmin }, async () => ({
    data: await moveAdvice()
  }))

  app.post('/capacity/rebalance/plan', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const b = body(req)
      return reply.send({ data: await planRebalance(b.shared_ids, b.max_moves) })
    })
  )

  app.post('/capacity/rebalances', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = await createRebalance(body(req) as unknown as StartRebalanceBody, userId(req))
      await logActivity({
        action: 'create',
        user: userId(req),
        collection: 'nivaro_hub_rebalances',
        item: String(id),
        req
      })
      return reply.code(202).send({ data: { id } })
    })
  )

  app.get('/capacity/rebalances', { preHandler: requireAdmin }, async () => ({
    data: await listRebalances()
  }))

  app.get('/capacity/rebalances/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id?: string }).id)
    const r = id === null ? null : await readRebalance(id)
    if (!r) return refuse(reply, 404, 'NOT_FOUND', 'No such rebalance.')
    return reply.send({ data: r })
  })

  app.post('/capacity/rebalances/:id/cancel', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = idParam((req.params as { id?: string }).id)
      if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such rebalance.')
      const r = await cancelRebalance(id)
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: 'nivaro_hub_rebalances',
        item: String(id),
        req,
        changed_fields: ['status']
      })
      return reply.send({ data: r })
    })
  )

  if (app.cron) {
    app.cron.schedule(
      'hub-capacity-sample',
      '*/15 * * * *',
      async () => {
        const r = await runCapacitySample()
        if (r.failed)
          app.log.info(
            `hub-capacity-sample: ${r.shared} shared, ${r.environments} environments, ${r.failed} did not answer`
          )
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every 15 minutes (Hub only) — reads the capacity figures of every shared deployment and hub-linked environment (counts, timings, bytes) into nivaro_hub_capacity_samples and prunes rows older than 31 days. Writes only that table.'
      }
    )
    app.cron.schedule(
      'hub-rebalance-tick',
      '* * * * *',
      async () => {
        await tickRebalances()
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every minute (Hub only) — advances open rebalances: starts the next planned move (a normal move) inside its quiet window, waits while it runs, stops at the first move that does not succeed. Does nothing when no rebalance is open.'
      }
    )
  }
}

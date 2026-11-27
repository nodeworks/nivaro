import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { markConfigRead } from '../services/config-live.js'
import { hubScopeLevel } from '../services/hub/api/scopes.js'
import { idParam, isAppOwner } from '../services/hub/apps.js'
import { HUB_PRODUCT_NAME } from '../services/hub/brand.js'
import { creationOpenRefusal } from '../services/hub/create/store.js'
import { moveOpenRefusal } from '../services/hub/move-open.js'
import {
  chargebackCsv,
  chargebackRefusal,
  chargebackReport,
  checkCostCenter,
  normalizeChargeback,
  readChargeback,
  setCostCenter,
  writeChargeback
} from '../services/hub/placement/chargeback.js'
import {
  checkPeerInput,
  checkPeerKey,
  createPeer,
  deletePeer,
  type FederationDeps,
  federatedFleet,
  getPeer,
  listPeers,
  peerOrigin,
  peerToken,
  publicPeer,
  readPeerFleet,
  updatePeer
} from '../services/hub/placement/federation.js'
import {
  checkRegionInput,
  createRegion,
  deleteRegion,
  getRegion,
  listRegions,
  PlacementError,
  placeEnvironment,
  placementMap,
  plainText,
  setHostRegion,
  updateRegion
} from '../services/hub/placement/regions.js'
import { createEstimate, liveCosts, stackEstimate } from '../services/hub/providers/costs-live.js'
import { ResourceChangeError } from '../services/hub/providers/engine/contract.js'
import {
  checkBudgetInput,
  costSettingsRefusal,
  normalizeCostSettings,
  readBudget,
  readCostSettings,
  writeBudget,
  writeCostSettings
} from '../services/hub/providers/estimate.js'
import { environmentFreezeRefusal } from '../services/hub/releases/freeze.js'
import { HubSecretError } from '../services/hub/secrets.js'
import { NIVARO_VERSION } from '../version.js'
import { actorOf } from './hub-providers.js'

/**
 * Nivaro Hub placement (ideas 48, 49, 50), mounted under /api/hub by hub.ts (HUB=on only). Every
 * route is for a Hub administrator except GET /federation/self (any caller the Hub gate lets in:
 * another Hub's key with hub:read asks it). Every write is logged.
 *
 * Hosts and regions (48):
 *   GET    /placement                              the map: regions → Docker hosts → what runs
 *                                                  there, hosts in no region, unplaced envs
 *   GET    /regions | POST /regions | PATCH /regions/:id | DELETE /regions/:id
 *   PUT    /placement/hosts/:driverId              {region_id|null, label} a host's region
 *   POST   /placement/environments/:envId/place    {driver_id, stack} run an UNPLACED environment
 *                                                  on that host (a new Docker stack placement);
 *                                                  409 ALREADY_PLACED (move it instead), MOVE_OPEN
 *   An environment that already runs moves to another host through the move engine
 *   (/environments/:envId/moves/plan, kind between_stacks): never through these routes.
 * Cost chargeback (49):
 *   GET    /chargeback | /chargeback.csv           rough monthly cost per app, department, owner
 *   GET    /chargeback/settings | PUT {currency, rates, window_days}
 *   PUT    /chargeback/apps/:appId                 {department, cost_center}
 * Live costs and estimates (Task 44a; estimates are reads — no plan, no audit row, open during
 * maintenance; owners see their own apps, administrators set budgets and the limit):
 *   POST   /environments/:envId/stack/estimate     {size?, replicas?, settings?} → {before, after}
 *   POST   /apps/create/estimate                   the Create app body → per environment figures
 *   GET    /costs/live?app_id=&environment_id=     now, month to date, forecast, billed
 *   GET    /apps/:id/cost-budget | PUT {monthly_cents, auto_approve_under_cents}
 *   GET    /costs/settings | PUT {cost_auto_approve_under_cents}
 * Federation (50, read only — nothing is ever sent to another Hub but two GETs):
 *   GET    /federation/self                        who answers and which Hub scope the caller's
 *                                                  key has (another Hub asks it)
 *   GET    /federation/peers | POST | PATCH /:id | DELETE /:id | POST /:id/check
 *   GET    /federation/fleet?fresh=1               every enabled peer's apps, read only, cached
 */

export interface PlacementRouteDeps {
  federation?: FederationDeps
}

function refuse(reply: FastifyReply, status: number, code: string, message: string, extra = {}) {
  return reply.code(status).send({ statusCode: status, error: message, message, code, ...extra })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (e) {
    if (e instanceof PlacementError) return refuse(reply, e.statusCode, e.code, e.message)
    if (e instanceof HubSecretError) return refuse(reply, 400, e.code, e.message)
    if (e instanceof ResourceChangeError) return refuse(reply, e.status, e.code, e.message)
    throw e
  }
}

const param = (req: FastifyRequest, name: string) =>
  idParam((req.params as Record<string, string | undefined>)[name])

export function hubPlacementRoutes(app: FastifyInstance, deps: PlacementRouteDeps = {}): void {
  // ─── hosts and regions ────────────────────────────────────────────────────

  app.get('/placement', { preHandler: requireAdmin }, async () => ({
    data: await placementMap()
  }))

  app.get('/regions', { preHandler: requireAdmin }, async () => ({ data: await listRegions() }))

  app.post('/regions', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const f = checkRegionInput(body(req))
      const r = await createRegion(f, userId(req) || null)
      await logActivity({
        action: 'create',
        user: userId(req),
        collection: 'nivaro_hub_regions',
        item: String(r.id),
        req
      })
      return reply.code(201).send({ data: r })
    })
  )

  app.patch('/regions/:id', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = param(req, 'id')
      const cur = id === null ? null : await getRegion(id)
      if (!cur || id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such region.')
      const f = checkRegionInput(body(req), cur)
      const r = await updateRegion(id, f)
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: 'nivaro_hub_regions',
        item: String(id),
        req,
        changed_fields: Object.keys(body(req))
      })
      return reply.send({ data: r })
    })
  )

  app.delete('/regions/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = param(req, 'id')
    if (id === null || !(await deleteRegion(id)))
      return refuse(reply, 404, 'NOT_FOUND', 'No such region.')
    await logActivity({
      action: 'delete',
      user: userId(req),
      collection: 'nivaro_hub_regions',
      item: String(id),
      req
    })
    return reply.code(204).send()
  })

  app.put('/placement/hosts/:driverId', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const driverId = param(req, 'driverId')
      if (driverId === null) return refuse(reply, 404, 'NOT_FOUND', 'No such driver.')
      const b = body(req)
      const raw = b.region_id
      if (raw !== null && raw !== undefined && (typeof raw !== 'number' || !Number.isInteger(raw)))
        return refuse(reply, 400, 'BAD_REGION', 'region_id is a region id, or null for none.')
      const out = await setHostRegion(
        driverId,
        (raw as number | null | undefined) ?? null,
        plainText(b.label, 120)
      )
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: 'nivaro_hub_region_drivers',
        item: String(driverId),
        req,
        changed_fields: ['region_id', 'label']
      })
      return reply.send({ data: { driver_id: driverId, ...out } })
    })
  )

  app.post(
    '/placement/environments/:envId/place',
    { preHandler: requireAdmin },
    async (req, reply) =>
      guarded(reply, async () => {
        const envId = param(req, 'envId')
        if (envId === null) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
        const open = await moveOpenRefusal({ envIds: [envId] })
        if (open)
          return refuse(reply, open.status, open.code, open.message, { move_id: open.move_id })
        // Review M2: an app creation in progress places this environment itself.
        const creating = await creationOpenRefusal(envId)
        if (creating) return refuse(reply, creating.status, 'CREATION_RUNNING', creating.message)
        // Review L1: a freeze also holds placement edits (deploy windows do not: nothing deploys).
        const frozen = await environmentFreezeRefusal(envId, 'placement', { skipWindows: true })
        if (frozen) return refuse(reply, frozen.status, frozen.code, frozen.message)
        const b = body(req)
        const driverId = typeof b.driver_id === 'number' ? b.driver_id : Number.NaN
        if (!Number.isInteger(driverId))
          return refuse(reply, 400, 'BAD_DRIVER', 'driver_id names the Docker host.')
        const stack = typeof b.stack === 'string' ? b.stack.trim() : ''
        const out = await placeEnvironment(envId, driverId, stack)
        await logActivity({
          action: 'hub-env-place',
          user: userId(req),
          collection: 'nivaro_hub_environments',
          item: String(envId),
          comment: JSON.stringify({ driver_id: driverId, stack, placement_id: out.placement_id }),
          req
        })
        return reply.code(201).send({ data: out })
      })
  )

  // ─── cost chargeback ──────────────────────────────────────────────────────

  app.get('/chargeback', { preHandler: requireAdmin }, async () => ({
    data: await chargebackReport()
  }))

  app.get('/chargeback.csv', { preHandler: requireAdmin }, async (req, reply) => {
    const r = await chargebackReport()
    await logActivity({
      action: 'hub-chargeback-export',
      user: userId(req),
      comment: JSON.stringify({ apps: r.apps.length }),
      req
    })
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', 'attachment; filename="hub-chargeback.csv"')
      .send(chargebackCsv(r))
  })

  app.get('/chargeback/settings', { preHandler: requireAdmin }, async () => ({
    data: await readChargeback()
  }))

  app.put('/chargeback/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const b = body(req)
    const why = chargebackRefusal(b)
    if (why) return refuse(reply, 400, 'BAD_SETTINGS', why)
    const cur = await readChargeback()
    const s = normalizeChargeback({
      ...cur,
      ...b,
      rates: { ...cur.rates, ...((b.rates as Record<string, unknown> | undefined) ?? {}) }
    })
    await writeChargeback(s)
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: 'nivaro_hub_chargeback_settings',
      item: 'chargeback',
      req,
      changed_fields: Object.keys(b)
    })
    return reply.send({ data: s })
  })

  app.put('/chargeback/apps/:appId', { preHandler: requireAdmin }, async (req, reply) => {
    const appId = param(req, 'appId')
    if (appId === null || !(await db('nivaro_hub_apps').where({ id: appId }).first('id')))
      return refuse(reply, 404, 'NOT_FOUND', 'No such app.')
    const c = await setCostCenter(appId, checkCostCenter(body(req)), userId(req) || null)
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: 'nivaro_hub_app_cost_centers',
      item: String(appId),
      req,
      changed_fields: ['department', 'cost_center']
    })
    return reply.send({ data: c })
  })

  // ─── federation ───────────────────────────────────────────────────────────

  // Another Hub asks this with its key (hub:read): who answers, and which Hub scope the key has.
  // Nothing else: no apps, no names, no settings.
  app.get('/federation/self', { preHandler: requireAuth }, async (req, reply) => {
    // Review L3: for another Hub's key (the Hub gate requires hub:read on it); a person's own
    // session reaches it only as a Hub administrator.
    if (req.authMethod !== 'api_key' && req.isAdmin !== true)
      return refuse(reply, 403, 'HUB_SCOPE_MISSING', 'This answers an API key with hub:read.')
    return {
      data: {
        product: HUB_PRODUCT_NAME,
        version: NIVARO_VERSION,
        auth: req.authMethod === 'api_key' ? 'api_key' : (req.authMethod ?? 'session'),
        key_scope: req.authMethod === 'api_key' ? hubScopeLevel(req.apiKeyScopes) : null
      }
    }
  })

  app.get('/federation/peers', { preHandler: requireAdmin }, async () => ({
    data: (await listPeers()).map(publicPeer)
  }))

  app.post('/federation/peers', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const f = checkPeerInput(body(req))
      // The key is proven read-only on the other Hub before it is stored.
      const self = await checkPeerKey(f.base_url, f.token as string, deps.federation)
      const p = await createPeer(f, userId(req) || null)
      await logActivity({
        action: 'create',
        user: userId(req),
        collection: 'nivaro_hub_peers',
        item: String(p.id),
        req
      })
      return reply.code(201).send({ data: publicPeer(p), peer: self })
    })
  )

  app.patch('/federation/peers/:id', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = param(req, 'id')
      const cur = id === null ? null : await getPeer(id)
      if (!cur || id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such Hub.')
      const f = checkPeerInput(body(req), cur)
      if (f.token) await checkPeerKey(f.base_url, f.token, deps.federation)
      const p = await updatePeer(id, f)
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: 'nivaro_hub_peers',
        item: String(id),
        req,
        changed_fields: Object.keys(body(req)).map((k) => (k === 'token' ? 'token' : k))
      })
      return reply.send({ data: p ? publicPeer(p) : null })
    })
  )

  app.delete('/federation/peers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = param(req, 'id')
    if (id === null || !(await deletePeer(id)))
      return refuse(reply, 404, 'NOT_FOUND', 'No such Hub.')
    await logActivity({
      action: 'delete',
      user: userId(req),
      collection: 'nivaro_hub_peers',
      item: String(id),
      req
    })
    return reply.code(204).send()
  })

  app.post('/federation/peers/:id/check', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = param(req, 'id')
      const p = id === null ? null : await getPeer(id)
      if (!p) return refuse(reply, 404, 'NOT_FOUND', 'No such Hub.')
      const origin = peerOrigin(p.base_url)
      if (!origin) return refuse(reply, 409, 'BAD_URL', 'The stored address is not usable.')
      const self = await checkPeerKey(origin, peerToken(p), deps.federation)
      const fleet = await readPeerFleet(p, deps.federation, { fresh: true })
      await logActivity({
        action: 'hub-peer-check',
        user: userId(req),
        collection: 'nivaro_hub_peers',
        item: String(p.id),
        comment: JSON.stringify({ ok: fleet.ok, rows: fleet.rows.length }),
        req
      })
      return reply.send({ data: { peer: self, fleet } })
    })
  )

  app.get('/federation/fleet', { preHandler: requireAdmin }, async (req) => {
    const fresh = (req.query as { fresh?: string } | undefined)?.fresh === '1'
    return { data: await federatedFleet(deps.federation, { fresh }) }
  })

  // ─── live costs and estimates (Task 44a) ──────────────────────────────────

  /** Administrators, or an owner of the app (an app the caller does not own reads as missing). */
  const mayRead = async (req: FastifyRequest, appId: number) =>
    req.isAdmin === true || (await isAppOwner(appId, userId(req)))

  app.post('/environments/:envId/stack/estimate', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      markConfigRead(req)
      const envId = param(req, 'envId')
      const env =
        envId === null
          ? undefined
          : ((await db('nivaro_hub_environments').where({ id: envId }).first('app_id')) as
              | { app_id: number }
              | undefined)
      if (envId === null || !env || !(await mayRead(req, Number(env.app_id))))
        return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
      const b = body(req)
      return reply.send({
        data: await stackEstimate(envId, {
          size: b.size,
          replicas: b.replicas,
          settings: b.settings
        })
      })
    })
  )

  app.post('/apps/create/estimate', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      markConfigRead(req)
      return reply.send({ data: await createEstimate(body(req), actorOf(req)) })
    })
  )

  app.get('/costs/live', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const q = (req.query ?? {}) as Record<string, string | undefined>
      const appId = q.app_id ? idParam(q.app_id) : null
      const envId = q.environment_id ? idParam(q.environment_id) : null
      if ((q.app_id && appId === null) || (q.environment_id && envId === null))
        return refuse(reply, 400, 'BAD_FILTER', 'app_id and environment_id are ids.')
      let appIds: number[] | null = appId === null ? null : [appId]
      if (envId !== null) {
        const env = (await db('nivaro_hub_environments').where({ id: envId }).first('app_id')) as
          | { app_id: number }
          | undefined
        if (!env || (appId !== null && Number(env.app_id) !== appId))
          return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
        appIds = [Number(env.app_id)]
      }
      if (req.isAdmin !== true) {
        const owned = (
          (await db('nivaro_hub_app_owners')
            .where({ user_id: userId(req) })
            .select('app_id')) as Array<{
            app_id: number
          }>
        ).map((r) => Number(r.app_id))
        if (appIds && !appIds.every((id) => owned.includes(id)))
          return refuse(reply, 404, 'NOT_FOUND', 'No such app.')
        appIds = appIds ?? owned
      }
      return reply.send({ data: await liveCosts({ appIds, environmentId: envId }) })
    })
  )

  app.get('/apps/:id/cost-budget', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const id = param(req, 'id')
      const exists =
        id !== null && (await db('nivaro_hub_apps').where({ id }).first('id')) !== undefined
      if (id === null || !exists || !(await mayRead(req, id)))
        return refuse(reply, 404, 'NOT_FOUND', 'No such app.')
      return reply.send({
        data: (await readBudget(id)) ?? {
          app_id: id,
          monthly_cents: 0,
          auto_approve_under_cents: null,
          last_alert_month: null,
          last_alert_pct: null,
          updated_by: null,
          updated_at: null
        }
      })
    })
  )

  app.put('/apps/:id/cost-budget', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const id = param(req, 'id')
      if (id === null || (await db('nivaro_hub_apps').where({ id }).first('id')) === undefined)
        return refuse(reply, 404, 'NOT_FOUND', 'No such app.')
      const input = checkBudgetInput(body(req))
      if (typeof input === 'string') return refuse(reply, 400, 'BAD_BUDGET', input)
      const out = await writeBudget(id, input, userId(req) || null)
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: 'nivaro_hub_cost_budgets',
        item: String(id),
        req,
        changed_fields: Object.keys(body(req))
      })
      return reply.send({ data: out })
    })
  )

  app.get('/costs/settings', { preHandler: requireAuth }, async () => ({
    data: await readCostSettings()
  }))

  app.put('/costs/settings', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const why = costSettingsRefusal(req.body)
      if (why) return refuse(reply, 400, 'BAD_SETTINGS', why)
      const next = normalizeCostSettings({ ...(await readCostSettings()), ...body(req) })
      await writeCostSettings(next)
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: 'nivaro_extension_settings',
        item: 'nivaro-hub/costs',
        req,
        changed_fields: Object.keys(body(req))
      })
      return reply.send({ data: next })
    })
  )
}

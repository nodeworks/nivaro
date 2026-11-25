import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { insertReturningId } from '../db/dialect/ef.js'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  baseUrlCheck,
  environmentFromRow,
  idParam,
  isAppOwner,
  isHubKey,
  isSigninMode,
  isUserIdShape,
  listApps,
  listEnvironments,
  listOwners,
  readApp,
  stringListColumn,
  unknownUserIds
} from '../services/hub/apps.js'
import {
  appsOfPlacement,
  createComponent,
  deleteComponent,
  followPlacementDriver,
  listComponents,
  placementDriverRefusal,
  readComponent,
  updateComponent,
  validateComponentInput
} from '../services/hub/components.js'
import {
  CreationError,
  deleteCreationRows,
  withEnvironmentsQuiet
} from '../services/hub/create/run.js'
import {
  HUB_DEPLOYS_MAX_LIMIT,
  HUB_DEPLOYS_TTL_S,
  type HubDeploy,
  hubDeploysKey,
  hubDeploysKeys,
  listEnvironmentDeploys
} from '../services/hub/deploys.js'
import {
  type DeleteRefusal,
  dockerEnvironmentDeleteRefusal,
  forgetPlacementStack,
  type StackEditRefusal,
  stackEditRefusal
} from '../services/hub/docker/stack-guards.js'
import {
  createDriver,
  createPlacement,
  deleteDriver,
  deletePlacement,
  getDriver,
  getPlacement,
  listDrivers,
  placementStackRefusal,
  placementTargetRefusal,
  publicDriver,
  releasePlacement,
  SHARED_PLACEMENT_MESSAGE,
  updateDriver,
  updatePlacement,
  validateDriverInput,
  validatePlacementInput
} from '../services/hub/drivers.js'
import { GitlabWriteError } from '../services/hub/gitlab-write.js'
import { hubTokenColumns, linkTokenInUse } from '../services/hub/link-token.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import { moveOpenRefusal } from '../services/hub/move-open.js'
import { ownerGuardOnRoute } from '../services/hub/owner-access.js'
import {
  gatherPlanInput,
  PromotionError,
  unrecordedComponents
} from '../services/hub/promote-gather.js'
import { buildPromotionPlan, compareVersions } from '../services/hub/promote-plan.js'
import {
  cancelPromotion,
  healBeforeRead,
  listHubDeploys,
  readHubDeploy,
  recoverOnceAtBoot,
  startPromotion
} from '../services/hub/promote-run.js'
import { HUB_MASK, HubSecretError } from '../services/hub/secrets.js'
import {
  PlaceSharedError,
  patchSharedPlacement,
  recoverPlacementsOnceAtBoot
} from '../services/hub/shared/place.js'
import { getShared } from '../services/hub/shared/store.js'
import {
  hubStatusKey,
  readAppStatus,
  readEnvironmentStatus,
  type StatusCache
} from '../services/hub/status.js'
import { readJobLog } from '../services/job-runs.js'
import { hubCapacityRoutes } from './hub-capacity.js'
import { hubChangeRoutes } from './hub-changes.js'
import { hubPhase3Routes } from './hub-create.js'
import { hubDataRoutes } from './hub-data.js'
import { hubDockerRoutes } from './hub-docker.js'
import { hubMoveRoutes } from './hub-move.js'
import { hubPeopleRoutes } from './hub-people.js'
import { hubPlacementRoutes } from './hub-placement.js'
import { hubReleaseRoutes } from './hub-releases.js'
import { hubScaleRoutes } from './hub-scale.js'
import { hubSharedRoutes } from './hub-shared.js'
import { hubSharedTenantsRoutes } from './hub-shared-tenants.js'
import { hubSharedUpgradeRoutes } from './hub-shared-upgrade.js'

/**
 * Nivaro Hub API, mounted at /api/hub. Nothing is registered unless hub mode is on (HUB=on,
 * never in cloud mode), so an ordinary install answers 404 on every path here.
 *
 * Reads need a signed-in person: admins see every app, anyone else only the apps they own (an
 * app they do not own answers 404, never 403). Every write is admin-only and logged.
 *
 * Sections are separate functions so later phases append their own (drivers, status, …).
 */
export async function hubRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return
  // Owners: deploy-class actions on non-production only (services/hub/owner-access.ts).
  app.addHook('onRoute', ownerGuardOnRoute)
  // Once per process start: promotions a previous process left `running` become `interrupted`.
  app.addHook('onReady', async () => recoverOnceAtBoot(app.log))
  // Phase 6: placement runs a previous process left running (services/hub/shared/place.ts).
  app.addHook('onReady', async () => recoverPlacementsOnceAtBoot(app.log))
  appRoutes(app)
  ownerRoutes(app)
  environmentRoutes(app)
  driverRoutes(app)
  placementRoutes(app)
  componentRoutes(app)
  statusRoutes(app)
  deployRoutes(app)
  promotionRoutes(app)
  hubDockerRoutes(app) // phase 4
  hubPhase3Routes(app)
  hubSharedRoutes(app) // phase 6
  app.register(hubSharedTenantsRoutes) // phase 6: GET /shared/:key/tenants (deployment bearer)
  hubSharedUpgradeRoutes(app) // phase 6: shared stack deploy/upgrade/rollback (Task 5)
  hubMoveRoutes(app) // phase 6: moves between shared and dedicated placements (+ boot heal)
  hubPeopleRoutes(app) // people directory + offboarding, owner policy, phone (hub-people.ts)
  hubCapacityRoutes(app) // capacity view, move advisor, per-app limits, rebalance
  hubReleaseRoutes(app) // release trains, schedules, freezes, auto-rollback, release notes
  hubChangeRoutes(app) // change calendar, deploy windows, pre-deploy checklists
  hubDataRoutes(app) // data care: backups, restore drills, refreshes, move rehearsals
  hubScaleRoutes(app) // scaling: manual + automatic replicas and limits of Docker stacks
  hubPlacementRoutes(app) // hosts + regions, cost chargeback, read-only federation with Hubs
}

const APPS = 'nivaro_hub_apps'
const OWNERS = 'nivaro_hub_app_owners'
const ENVS = 'nivaro_hub_environments'
const DRIVERS = 'nivaro_hub_drivers'
const PLACEMENTS = 'nivaro_hub_placements'

type Body = Record<string, unknown>

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Not found')

function userId(req: FastifyRequest): string {
  return String(req.user?.id ?? '')
}

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

/** Runs a write; a hub secret that cannot be sealed answers 400 with its code. */
async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (e) {
    if (e instanceof HubSecretError) return fail(reply, 400, e.code, e.message)
    throw e
  }
}

function now() {
  return new Date()
}

type HubRedis = StatusCache & { del(...keys: string[]): Promise<unknown> }

/** The app's Redis client when one is decorated (tests and Redis-less boots have none). */
function redisOf(app: FastifyInstance): HubRedis | null {
  return (app as unknown as { redis?: HubRedis }).redis ?? null
}

/** A cache call never holds a request past this. */
const CACHE_BOUND_MS = 300
const TIMED_OUT = Symbol('timed-out')

/** `p`, or TIMED_OUT after CACHE_BOUND_MS; a rejection is TIMED_OUT too (fail open). */
async function bounded<T>(p: () => Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(p),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), CACHE_BOUND_MS)
      })
    ])
  } catch {
    return TIMED_OUT
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Drops an environment's cached status and deploy history so the next read asks again. Best
 * effort: a Redis that fails or hangs never fails (or holds) the write past 300 ms.
 */
async function forgetEnvironment(app: FastifyInstance, envId: number) {
  const redis = redisOf(app)
  if (!redis) return
  await Promise.all([
    bounded(() => Promise.resolve(redis.del(hubStatusKey(envId)))),
    bounded(() => Promise.resolve(redis.del(...hubDeploysKeys(envId))))
  ])
}

/** P4-31: an edit that would orphan a running stack, answered with the field it names. */
const stackRunning = (reply: FastifyReply, r: StackEditRefusal) =>
  reply.code(r.status).send({ error: r.message, code: r.code, field: r.field })

/** Ids of the environments deployed through a placement, or through any placement of a driver. */

async function environmentsUsing(by: { placement: number } | { driver: number }) {
  const rows = (
    'placement' in by
      ? await db(ENVS).where({ placement_id: by.placement }).select('id')
      : await db(`${ENVS} as e`)
          .join(`${PLACEMENTS} as p`, 'p.id', 'e.placement_id')
          .where('p.driver_id', by.driver)
          .select('e.id as id')
  ) as Array<{ id: number }>
  return rows.map((r) => Number(r.id))
}

/** Drops the cached deploy history of these environments (their placement or driver changed). */
async function forgetDeploys(app: FastifyInstance, envIds: number[]) {
  const redis = redisOf(app)
  if (!redis || !envIds.length) return
  await bounded(() => Promise.resolve(redis.del(...envIds.flatMap((id) => hubDeploysKeys(id)))))
}

function originOf(url: unknown): string | null {
  try {
    return new URL(String(url)).origin
  } catch {
    return null
  }
}

/** The app's environments plus every environment its creation rows name (phase 3). */
async function creationEnvironments(appId: number): Promise<number[]> {
  const envs = (await db(ENVS).where({ app_id: appId }).select('id')) as Array<{ id: number }>
  const made = (await db('nivaro_hub_creations')
    .where({ app_id: appId })
    .select('environment_id')) as Array<{ environment_id: number }>
  return [
    ...new Set([...envs.map((e) => Number(e.id)), ...made.map((c) => Number(c.environment_id))])
  ]
}

/**
 * Runs a delete holding these environments' locks; CREATION_RUNNING (409) while one is held. A
 * lock the Hub cannot take or read (Redis down) answers its own status: 503 LOCK_UNAVAILABLE.
 */
async function quiet(reply: FastifyReply, envIds: number[], run: () => Promise<unknown>) {
  try {
    return await withEnvironmentsQuiet(envIds, run)
  } catch (e) {
    if (e instanceof CreationError) return fail(reply, e.status, e.code, e.message)
    if (e instanceof PromotionError) return fail(reply, e.status, e.code, e.message)
    throw e
  }
}

// ─── Apps ────────────────────────────────────────────────────────────────────

function appRoutes(app: FastifyInstance) {
  app.get('/apps', { preHandler: requireAuth }, async (req) => {
    return { data: await listApps(userId(req), req.isAdmin === true) }
  })

  app.get('/apps/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    const found = await readApp(id)
    if (!found) return notFound(reply)
    if (!req.isAdmin && !(await isAppOwner(id, userId(req)))) return notFound(reply)
    const [environments, owners] = await Promise.all([listEnvironments(id), listOwners(id)])
    return { data: { ...found, environments, owners } }
  })

  app.post('/apps', { preHandler: requireAdmin }, async (req, reply) => {
    const b = body(req)
    if (!isHubKey(b.key))
      return fail(
        reply,
        400,
        'BAD_KEY',
        'key must start with a-z and hold 2–63 lowercase letters, digits or dashes'
      )
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name || name.length > 200)
      return fail(reply, 400, 'BAD_NAME', 'name is required (up to 200 characters)')
    const signin = b.signin_mode ?? 'direct'
    if (!isSigninMode(signin))
      return fail(reply, 400, 'BAD_SIGNIN_MODE', "signin_mode must be 'direct' or 'hub'")
    if (b.adopted !== undefined && typeof b.adopted !== 'boolean')
      return fail(reply, 400, 'BAD_ADOPTED', 'adopted must be true or false')
    if (await db(APPS).where({ key: b.key }).first('id'))
      return fail(reply, 409, 'KEY_TAKEN', `An app with key "${b.key}" already exists`)
    const id = await insertReturningId(db, APPS, {
      key: b.key,
      name,
      signin_mode: signin,
      adopted: b.adopted === true,
      extensions: '[]',
      created_by: userId(req) || null,
      created_at: now(),
      updated_at: now()
    })
    const created = await readApp(Number(id))
    await logActivity({
      action: 'create',
      user: userId(req),
      collection: APPS,
      item: String(id),
      req
    })
    return { data: created }
  })

  app.patch('/apps/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await readApp(id))) return notFound(reply)
    const b = body(req)
    const patch: Body = {}
    if (b.key !== undefined) {
      if (!isHubKey(b.key))
        return fail(
          reply,
          400,
          'BAD_KEY',
          'key must start with a-z and hold 2–63 lowercase letters, digits or dashes'
        )
      if (await db(APPS).where({ key: b.key }).whereNot({ id }).first('id'))
        return fail(reply, 409, 'KEY_TAKEN', `An app with key "${b.key}" already exists`)
      // P4-31: a running stack's owner labels name the app key.
      if (b.key !== (await readApp(id))?.key) {
        const envIds = (
          (await db(ENVS).where({ app_id: id }).select('id')) as Array<{ id: number }>
        ).map((r) => Number(r.id))
        const running = await stackEditRefusal(envIds, 'key')
        if (running) return stackRunning(reply, running)
      }
      patch.key = b.key
    }
    if (b.name !== undefined) {
      const name = typeof b.name === 'string' ? b.name.trim() : ''
      if (!name || name.length > 200)
        return fail(reply, 400, 'BAD_NAME', 'name is required (up to 200 characters)')
      patch.name = name
    }
    if (b.signin_mode !== undefined) {
      if (!isSigninMode(b.signin_mode))
        return fail(reply, 400, 'BAD_SIGNIN_MODE', "signin_mode must be 'direct' or 'hub'")
      patch.signin_mode = b.signin_mode
    }
    if (b.adopted !== undefined) {
      if (typeof b.adopted !== 'boolean')
        return fail(reply, 400, 'BAD_ADOPTED', 'adopted must be true or false')
      patch.adopted = b.adopted
    }
    if (b.extensions !== undefined) {
      const list = stringListColumn(b.extensions)
      if (list === null)
        return fail(reply, 400, 'BAD_EXTENSIONS', 'extensions must be a list of extension ids')
      patch.extensions = list
    }
    if (Object.keys(patch).length) {
      await db(APPS)
        .where({ id })
        .update({ ...patch, updated_at: now() })
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: APPS,
        item: String(id),
        req,
        changed_fields: Object.keys(patch)
      })
    }
    return { data: await readApp(id) }
  })

  app.delete('/apps/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await readApp(id))) return notFound(reply)
    // Refused CREATION_RUNNING while a creation leg (or promotion) holds one of its environments.
    const envIds = await creationEnvironments(id)
    return quiet(reply, envIds, async () => {
      if (await db(ENVS).where({ app_id: id }).first('id'))
        return fail(
          reply,
          409,
          'HAS_ENVIRONMENTS',
          'Remove the app’s environments before deleting it'
        )
      await db.transaction(async (trx) => {
        await deleteCreationRows(trx, envIds)
        await trx(OWNERS).where({ app_id: id }).del()
        await trx(APPS).where({ id }).del()
      })
      await logActivity({
        action: 'delete',
        user: userId(req),
        collection: APPS,
        item: String(id),
        req
      })
      return { data: { id } }
    })
  })
}

// ─── Owners ──────────────────────────────────────────────────────────────────

function ownerRoutes(app: FastifyInstance) {
  app.put('/apps/:id/owners', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await readApp(id))) return notFound(reply)
    const raw = body(req).user_ids
    if (!Array.isArray(raw) || raw.some((u) => typeof u !== 'string' || !u.trim()))
      return fail(reply, 400, 'BAD_OWNERS', 'user_ids must be a list of user ids')
    const ids: string[] = []
    for (const u of raw as string[]) {
      const v = u.trim()
      if (!ids.some((x) => x.toLowerCase() === v.toLowerCase())) ids.push(v)
    }
    // Refuse a non-uuid id before any query: a uuid column fails to convert it (500).
    const malformed = ids.filter((u) => !isUserIdShape(u))
    if (malformed.length)
      return fail(reply, 400, 'UNKNOWN_USER', `No such user: ${malformed.join(', ')}`)
    const unknown = await unknownUserIds(ids)
    if (unknown.length)
      return fail(reply, 400, 'UNKNOWN_USER', `No such user: ${unknown.join(', ')}`)
    await db.transaction(async (trx) => {
      await trx(OWNERS).where({ app_id: id }).del()
      if (ids.length)
        await trx(OWNERS).insert(
          ids.map((user_id) => ({ app_id: id, user_id, created_at: now(), updated_at: now() }))
        )
    })
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: APPS,
      item: String(id),
      comment: 'Owners changed',
      req,
      changed_fields: ['owners']
    })
    return { data: await listOwners(id) }
  })
}

// ─── Environments ────────────────────────────────────────────────────────────

/** Validates the environment fields present in `b`; `creating` requires key + base_url. */
function environmentPatch(
  b: Body,
  creating: boolean
): { patch: Body } | { error: string; code: string } {
  const patch: Body = {}
  if (creating || b.key !== undefined) {
    if (!isHubKey(b.key))
      return {
        code: 'BAD_KEY',
        error: 'key must start with a-z and hold 2–63 lowercase letters, digits or dashes'
      }
    patch.key = b.key
  }
  if (creating || b.base_url !== undefined) {
    const checked = baseUrlCheck(b.base_url)
    if ('error' in checked) return { code: 'BAD_BASE_URL', error: checked.error }
    patch.base_url = checked.url
  }
  if (b.position !== undefined) {
    if (
      !Number.isInteger(b.position) ||
      (b.position as number) < 0 ||
      (b.position as number) > 1000
    )
      return { code: 'BAD_POSITION', error: 'position must be a whole number from 0 to 1000' }
    patch.position = b.position
  }
  if (b.hostnames !== undefined) {
    const list = stringListColumn(
      Array.isArray(b.hostnames)
        ? b.hostnames.map((h) => (typeof h === 'string' ? h.toLowerCase() : h))
        : b.hostnames,
      253
    )
    if (list === null)
      return { code: 'BAD_HOSTNAMES', error: 'hostnames must be a list of host names' }
    patch.hostnames = list
  }
  if (b.placement_id !== undefined) {
    if (b.placement_id !== null && idParam(b.placement_id) === null)
      return { code: 'BAD_PLACEMENT', error: 'placement_id must be a placement id or null' }
    patch.placement_id = b.placement_id === null ? null : Number(b.placement_id)
  }
  if (!creating && b.version_pin !== undefined) {
    const pin = b.version_pin
    if (pin !== null && (typeof pin !== 'string' || pin.trim().length > 64))
      return {
        code: 'BAD_VERSION_PIN',
        error: 'version_pin must be a version (up to 64 characters) or null'
      }
    patch.version_pin = typeof pin === 'string' && pin.trim() ? pin.trim() : null
  }
  if (!creating && b.hub_managed !== undefined) {
    if (typeof b.hub_managed !== 'boolean')
      return { code: 'BAD_HUB_MANAGED', error: 'hub_managed must be true or false' }
    patch.hub_managed = b.hub_managed
  }
  return { patch }
}

/** The app's own HUB_TOKEN floor (services/hub/mode.ts hubLinkToken): shorter never links. */
const MIN_HUB_TOKEN = 32

type TokenRefusal = { error: string; code: string; field: 'hub_token' }

/**
 * The hub token as sent: undefined (absent: PATCH keeps the stored one), null, or text —
 * whitespace-only text is a clear (''). Refused, with the field named (ruling X-7):
 * anything but text (BAD_SECRET); the mask or anything holding '•' (HUB_TOKEN_MASK — it is never
 * sealed as a token); a typed token under 32 characters (HUB_TOKEN_TOO_SHORT, the app's rule).
 */
function tokenInput(raw: unknown): { token: unknown } | TokenRefusal {
  if (raw === undefined || raw === null) return { token: raw }
  const refuse = (code: string, error: string): TokenRefusal => ({
    code,
    error,
    field: 'hub_token'
  })
  if (typeof raw !== 'string') return refuse('BAD_SECRET', 'The hub token must be text.')
  if (!raw.trim()) return { token: '' }
  if (raw.includes('•'))
    return refuse(
      'HUB_TOKEN_MASK',
      'The hub token is the mask (••••••), not a token: type the token, or leave the field out to keep the stored one.'
    )
  if (raw.length < MIN_HUB_TOKEN)
    return refuse(
      'HUB_TOKEN_TOO_SHORT',
      `The hub token must be at least ${MIN_HUB_TOKEN} characters (the app's own HUB_TOKEN rule).`
    )
  return { token: raw }
}

const refuseToken = (reply: FastifyReply, r: TokenRefusal) =>
  reply.code(400).send({ error: r.error, code: r.code, field: r.field })

/**
 * A placement an environment may name: it exists (400 BAD_PLACEMENT) and no other environment
 * names it (409 PLACEMENT_IN_USE) — a dedicated placement belongs to one environment.
 */
async function placementRefusal(
  placementId: unknown,
  envId: number | null
): Promise<{ status: number; code: string; error: string } | null> {
  if (placementId === undefined || placementId === null) return null
  const id = Number(placementId)
  if (!(await db(PLACEMENTS).where({ id }).first('id')))
    return {
      status: 400,
      code: 'BAD_PLACEMENT',
      error: 'placement_id must name an existing placement'
    }
  const q = db(ENVS).where({ placement_id: id })
  if (envId !== null) q.whereNot({ id: envId })
  if (await q.first('id'))
    return {
      status: 409,
      code: 'PLACEMENT_IN_USE',
      error: 'Another environment already uses this placement'
    }
  return null
}

/** Phase 6: the kind of placement `id` (null = none, or no such placement). */
async function placementKind(id: number | null | undefined): Promise<string | null> {
  if (id == null) return null
  const row = (await db(PLACEMENTS).where({ id }).first('kind')) as { kind: string } | undefined
  return row?.kind ?? null
}

async function readEnvironmentRow(id: number): Promise<Record<string, unknown> | undefined> {
  return db(ENVS).where({ id }).first()
}

function environmentRoutes(app: FastifyInstance) {
  app.post('/apps/:id/environments', { preHandler: requireAdmin }, async (req, reply) => {
    const appId = idParam((req.params as { id: string }).id)
    if (appId === null || !(await readApp(appId))) return notFound(reply)
    const b = body(req)
    const checked = environmentPatch(b, true)
    if ('error' in checked) return fail(reply, 400, checked.code, checked.error)
    const { patch } = checked
    const incoming = tokenInput(b.hub_token)
    if ('error' in incoming) return refuseToken(reply, incoming)
    if (await db(ENVS).where({ app_id: appId, key: patch.key }).first('id'))
      return fail(reply, 409, 'KEY_TAKEN', `This app already has an environment "${patch.key}"`)
    const refused = await placementRefusal(patch.placement_id, null)
    if (refused) return fail(reply, refused.status, refused.code, refused.error)
    // Phase 6: an environment reaches a shared deployment only through place-shared (or a move).
    if ((await placementKind(patch.placement_id as number | null | undefined)) === 'shared')
      return fail(
        reply,
        409,
        'USE_PLACE_SHARED',
        'Create the environment without a placement, then place it on the shared deployment.'
      )
    if (await linkTokenInUse(incoming.token, null))
      return fail(reply, 409, 'TOKEN_IN_USE', 'Another environment already uses this hub token')
    return guarded(reply, async () => {
      // Ruling X-4: sealed with its app-link lookup, through the one helper.
      const token = hubTokenColumns(typeof incoming.token === 'string' ? incoming.token : null)
      if (patch.position === undefined) {
        const last = (await db(ENVS).where({ app_id: appId }).max({ p: 'position' }).first()) as
          | { p: number | null }
          | undefined
        patch.position = last?.p == null ? 0 : Number(last.p) + 1
      }
      const id = await insertReturningId(db, ENVS, {
        app_id: appId,
        status: 'active',
        hostnames: '[]',
        ...patch,
        ...token,
        created_at: now(),
        updated_at: now()
      })
      const row = await readEnvironmentRow(Number(id))
      await logActivity({
        action: 'create',
        user: userId(req),
        collection: ENVS,
        item: String(id),
        req
      })
      return { data: row ? environmentFromRow(row) : null }
    })
  })

  app.patch('/environments/:envId', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { envId: string }).envId)
    const current = id === null ? undefined : await readEnvironmentRow(id)
    if (id === null || !current) return notFound(reply)
    const b = body(req)
    const checked = environmentPatch(b, false)
    if ('error' in checked) return fail(reply, 400, checked.code, checked.error)
    const { patch } = checked
    // Final review moves I-2 (P6-37): an open move (an interrupted one holds no lock) relies on
    // the environment's placement, stack and names staying as it found them.
    if (
      ['placement_id', 'key', 'hostnames', 'base_url', 'version_pin'].some(
        (f) => patch[f as keyof typeof patch] !== undefined
      ) ||
      (b.hub_token !== undefined && b.hub_token !== HUB_MASK)
    ) {
      const open = await moveOpenRefusal({ envIds: [id] })
      if (open) return fail(reply, open.status, open.code, open.message)
    }
    // P4-31: a running stack's labels name the environment key, and the Hub finds it through
    // the placement: neither may change while the stack runs.
    const before = current.placement_id == null ? null : Number(current.placement_id)
    // Phase 6: onto or off a shared deployment is a move (it copies files, switches routing and
    // checks the version), never a placement edit; a shared deployment owns the version pin.
    if (patch.placement_id !== undefined && (patch.placement_id ?? null) !== before) {
      const kinds = [
        await placementKind(before),
        await placementKind(patch.placement_id as number | null)
      ]
      if (kinds.includes('shared'))
        return fail(
          reply,
          409,
          'USE_MOVE',
          'Moving an environment onto or off a shared deployment is a move: use Move instead.'
        )
      // Hub placement (review L1): a freeze also holds placement edits (deploy windows do not).
      const { environmentFreezeRefusal } = await import('../services/hub/releases/freeze.js')
      const frozen = await environmentFreezeRefusal(id, 'placement', { skipWindows: true })
      if (frozen) return fail(reply, frozen.status, frozen.code, frozen.message)
    }
    if (
      patch.version_pin !== undefined &&
      (patch.version_pin ?? null) !== (current.version_pin ?? null) &&
      (await placementKind(before)) === 'shared'
    )
      return fail(reply, 409, 'SHARED_PLACEMENT', SHARED_PLACEMENT_MESSAGE)
    const stackEdit =
      patch.key !== undefined && patch.key !== current.key
        ? await stackEditRefusal([id], 'key')
        : patch.placement_id !== undefined && (patch.placement_id ?? null) !== before
          ? await stackEditRefusal([id], 'placement_id')
          : // P4-35: the Hub owns version_pin while a stack runs (Apply now and restart read it).
            patch.version_pin !== undefined &&
              (patch.version_pin ?? null) !== (current.version_pin ?? null)
            ? await stackEditRefusal([id], 'version_pin')
            : null
    if (stackEdit) return stackRunning(reply, stackEdit)
    const incoming = tokenInput(b.hub_token)
    if ('error' in incoming) return refuseToken(reply, incoming)
    const sent = incoming.token
    if (
      patch.key !== undefined &&
      (await db(ENVS)
        .where({ app_id: current.app_id, key: patch.key })
        .whereNot({ id })
        .first('id'))
    )
      return fail(reply, 409, 'KEY_TAKEN', `This app already has an environment "${patch.key}"`)
    const refused = await placementRefusal(patch.placement_id, id)
    if (refused) return fail(reply, refused.status, refused.code, refused.error)
    if (await linkTokenInUse(sent, id))
      return fail(reply, 409, 'TOKEN_IN_USE', 'Another environment already uses this hub token')
    // The stored token never follows the app to another address: a new origin needs the token
    // typed again (or cleared). Absent and the mask both mean "keep the stored one".
    const storedToken = (current.hub_token as string | null) ?? null
    if (
      storedToken &&
      patch.base_url !== undefined &&
      originOf(patch.base_url) !== originOf(current.base_url) &&
      (sent === undefined || sent === HUB_MASK)
    )
      return fail(
        reply,
        400,
        'SECRET_REQUIRED',
        'Enter the hub token again when the address changes'
      )
    return guarded(reply, async () => {
      // Absent and the mask keep the stored token; a new one (or a clear) goes through the one
      // helper, so its lookup is written with it (ruling X-4).
      if (sent !== undefined && sent !== HUB_MASK)
        Object.assign(patch, hubTokenColumns(typeof sent === 'string' ? sent : null))
      if (Object.keys(patch).length) {
        await db.transaction(async (trx) => {
          await trx(ENVS)
            .where({ id })
            .update({ ...patch, updated_at: now() })
          // Moved off its dedicated placement: the old one goes unless another env names it.
          if (patch.placement_id !== undefined && patch.placement_id !== before)
            await releasePlacement(trx, before)
        })
        await logActivity({
          action: 'update',
          user: userId(req),
          collection: ENVS,
          item: String(id),
          req,
          changed_fields: Object.keys(patch)
        })
      }
      await forgetEnvironment(app, id)
      const row = await readEnvironmentRow(id)
      return { data: row ? environmentFromRow(row) : null }
    })
  })

  app.delete('/environments/:envId', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { envId: string }).envId)
    const current = id === null ? undefined : await readEnvironmentRow(id)
    if (id === null || !current) return notFound(reply)
    // ONE lock scope (phase 3's quiet = the environment's promotion lock): refused
    // CREATION_RUNNING while a creation leg or a promotion holds it. Inside it, phase 4: a Docker
    // stack this environment still runs must be removed first (STACK_*); then its creation row
    // (phase 3) and its sign-in client and switcher rows (phase 7, ruling P7-18) go with it.
    return quiet(reply, [id], async () => {
      // Re-review FW1-M-2: an open move (an interrupted one holds no lock) needs the
      // environment and its placements to resume or roll back.
      const open = await moveOpenRefusal({ envIds: [id] })
      if (open) return fail(reply, open.status, open.code, open.message)
      let stackRefusal: DeleteRefusal | null
      try {
        stackRefusal = await dockerEnvironmentDeleteRefusal(id)
      } catch (err) {
        if (err instanceof PromotionError) return fail(reply, err.status, err.code, err.message)
        throw err
      }
      if (stackRefusal) return fail(reply, 409, stackRefusal.code, stackRefusal.message)
      await db.transaction(async (trx) => {
        await deleteCreationRows(trx, [id])
        // No FKs on the hub tables: children are deleted explicitly.
        await trx('nivaro_hub_oidc_clients').where({ environment_id: id }).del()
        await trx('nivaro_hub_signins').where({ environment_id: id }).del()
        // X-6a: its stack settings (phase 4, sealed secrets) go with it too.
        await trx('nivaro_hub_stack_settings').where({ environment_id: id }).del()
        await trx(ENVS).where({ id }).del()
        // Its dedicated placement goes with it, unless another environment still names it.
        await releasePlacement(
          trx,
          current.placement_id == null ? null : Number(current.placement_id)
        )
      })
      await forgetEnvironment(app, id)
      await logActivity({
        action: 'delete',
        user: userId(req),
        collection: ENVS,
        item: String(id),
        req
      })
      return { data: { id } }
    })
  })
}

/**
 * The environment `envId` names when the caller may read it: admins any, anyone else only one
 * of an app they own. Everything else is undefined (the route answers 404, never 403).
 */
async function readableEnvironment(
  req: FastifyRequest
): Promise<Record<string, unknown> | undefined> {
  const id = idParam((req.params as { envId: string }).envId)
  if (id === null) return undefined
  const row = await readEnvironmentRow(id)
  if (!row) return undefined
  if (!req.isAdmin && !(await isAppOwner(Number(row.app_id), userId(req)))) return undefined
  return row
}

function statusTarget(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    key: String(row.key),
    base_url: String(row.base_url),
    hub_token: (row.hub_token as string | null) ?? null,
    // Phase 6 (R3): a shared-placed environment is read through its deployment.
    placement_id: row.placement_id == null ? null : Number(row.placement_id)
  }
}

function isFresh(req: FastifyRequest): boolean {
  const v = (req.query as { fresh?: unknown } | undefined)?.fresh
  return v === '1' || v === 'true'
}

// ─── Drivers ─────────────────────────────────────────────────────────────────

function driverRoutes(app: FastifyInstance) {
  app.get('/drivers', { preHandler: requireAdmin }, async () => {
    return { data: (await listDrivers()).map(publicDriver) }
  })

  app.post('/drivers', { preHandler: requireAdmin }, async (req, reply) => {
    return guarded(reply, async () => {
      const checked = validateDriverInput(body(req))
      if (!checked.ok) return fail(reply, 400, checked.code, checked.message)
      const created = await createDriver(checked.row)
      await logActivity({
        action: 'create',
        user: userId(req),
        collection: DRIVERS,
        item: String(created.id),
        req
      })
      return { data: publicDriver(created) }
    })
  })

  app.patch('/drivers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const existing = id === null ? null : await getDriver(id)
    if (id === null || !existing) return notFound(reply)
    const b = body(req)
    return guarded(reply, async () => {
      const checked = validateDriverInput(b, existing)
      if (!checked.ok) return fail(reply, 400, checked.code, checked.message)
      const updated = await updateDriver(id, checked.row)
      if (!updated) return notFound(reply)
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: DRIVERS,
        item: String(id),
        req,
        // Field names only — never the token.
        changed_fields: ['kind', 'name', 'config', 'secret'].filter((k) => b[k] !== undefined)
      })
      await forgetDeploys(app, await environmentsUsing({ driver: id }))
      return { data: publicDriver(updated) }
    })
  })

  app.delete('/drivers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    const done = await deleteDriver(id)
    if (!done.ok) {
      if (done.code === 'IN_USE')
        return fail(reply, 409, 'IN_USE', 'An environment still uses this driver')
      if (done.code === 'DRIVER_IN_USE')
        return fail(
          reply,
          409,
          'DRIVER_IN_USE',
          `The shared deployment ${done.shared} deploys through this driver — point it at another driver, or retire it, first`
        )
      return notFound(reply)
    }
    await logActivity({
      action: 'delete',
      user: userId(req),
      collection: DRIVERS,
      item: String(id),
      req
    })
    return reply.code(204).send()
  })
}

// ─── Placements ──────────────────────────────────────────────────────────────

const noDriver = (reply: FastifyReply) =>
  fail(reply, 400, 'BAD_DRIVER', 'driver_id must name an existing driver')

function placementRoutes(app: FastifyInstance) {
  app.post('/placements', { preHandler: requireAdmin }, async (req, reply) => {
    const checked = validatePlacementInput(body(req))
    if (!checked.ok) return fail(reply, 400, checked.code, checked.message)
    // Phase 6: a placement on a shared deployment (no driver). Its pool is judged against the
    // deployment's budget when an environment is placed on it (place-shared or a move).
    if (checked.row.kind === 'shared') {
      const shared = await getShared(checked.row.shared_deployment_id)
      if (!shared)
        return fail(reply, 400, 'BAD_SHARED', 'shared_deployment_id must name a shared deployment')
      if (shared.status === 'retired')
        return fail(
          reply,
          409,
          'SHARED_RETIRED',
          'This shared deployment is retired; nothing can be placed on it.'
        )
      const made = await createPlacement(checked.row)
      await logActivity({
        action: 'create',
        user: userId(req),
        collection: PLACEMENTS,
        item: String(made.id),
        req
      })
      return { data: { id: made.id } }
    }
    const driver = await getDriver(checked.row.driver_id)
    if (!driver) return noDriver(reply)
    const badTarget = placementTargetRefusal(driver.kind, checked.row.target)
    if (badTarget) return fail(reply, 400, badTarget.code, badTarget.message)
    const takenStack = await placementStackRefusal(driver.id, checked.row.target) // phase 4
    if (takenStack) return fail(reply, takenStack.status, takenStack.code, takenStack.message)
    const created = await createPlacement(checked.row)
    await logActivity({
      action: 'create',
      user: userId(req),
      collection: PLACEMENTS,
      item: String(created.id),
      req
    })
    return { data: { id: created.id } }
  })

  app.get('/placements/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const found = id === null ? null : await getPlacement(id)
    if (!found) return notFound(reply)
    return { data: found }
  })

  app.patch('/placements/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const existing = id === null ? null : await getPlacement(id)
    if (id === null || !existing) return notFound(reply)
    const b = body(req)
    // Phase 6: a placement keeps its kind — dedicated ↔ shared is a move.
    if (b.kind !== undefined && b.kind !== existing.kind)
      return fail(
        reply,
        409,
        'USE_MOVE',
        'A placement keeps its kind: moving onto or off a shared deployment is a move.'
      )
    if (existing.kind === 'shared') {
      const checkedShared = validatePlacementInput({
        kind: 'shared',
        shared_deployment_id: b.shared_deployment_id ?? existing.shared_deployment_id,
        target: b.target ?? existing.target
      })
      if (!checkedShared.ok) return fail(reply, 400, checkedShared.code, checkedShared.message)
      if (checkedShared.row.kind !== 'shared') return notFound(reply)
      try {
        const updated = await patchSharedPlacement(existing, checkedShared.row)
        await logActivity({
          action: 'update',
          user: userId(req),
          collection: PLACEMENTS,
          item: String(id),
          req,
          changed_fields: ['target'].filter((k) => b[k] !== undefined)
        })
        return { data: updated }
      } catch (err) {
        if (err instanceof PlaceSharedError)
          return fail(reply, err.statusCode, err.code, err.message)
        if (err instanceof PromotionError) return fail(reply, err.status, err.code, err.message)
        throw err
      }
    }
    const checked = validatePlacementInput({
      kind: 'dedicated',
      driver_id: b.driver_id ?? existing.driver_id,
      target: b.target ?? existing.target
    })
    if (!checked.ok) return fail(reply, 400, checked.code, checked.message)
    if (checked.row.kind === 'shared') return notFound(reply)
    const moved = checked.row.driver_id !== existing.driver_id
    const driver = await getDriver(checked.row.driver_id)
    if (moved && !driver) return noDriver(reply)
    if (driver) {
      const badTarget = placementTargetRefusal(driver.kind, checked.row.target)
      if (badTarget) return fail(reply, 400, badTarget.code, badTarget.message)
      const takenStack = await placementStackRefusal(driver.id, checked.row.target, id) // phase 4
      if (takenStack) return fail(reply, takenStack.status, takenStack.code, takenStack.message)
    }
    if (moved) {
      const mixed = await placementDriverRefusal(id, checked.row.driver_id)
      if (mixed) return fail(reply, mixed.status, mixed.code, mixed.message)
    }
    // P4-31: the Hub finds a running stack through this placement's driver and stack name.
    const stackMoved = (checked.row.target?.stack ?? null) !== (existing.target?.stack ?? null)
    if (moved || stackMoved) {
      const running = await stackEditRefusal(
        await environmentsUsing({ placement: id }),
        moved ? 'driver_id' : 'target.stack'
      )
      if (running) return stackRunning(reply, running)
    }
    // Phase 6: a forgotten stack stays forgotten while the placement names the same stack on
    // the same driver (validation never takes forgotten_at from a body).
    const forgotten = existing.target.forgotten_at
    if (forgotten && !moved && !stackMoved) checked.row.target.forgotten_at = forgotten
    const updated = await updatePlacement(id, checked.row)
    if (!updated) return notFound(reply)
    if (moved) await followPlacementDriver(id, checked.row.driver_id)
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: PLACEMENTS,
      item: String(id),
      req,
      changed_fields: ['kind', 'driver_id', 'target'].filter((k) => b[k] !== undefined)
    })
    await forgetDeploys(app, await environmentsUsing({ placement: id }))
    return { data: updated }
  })

  // A placement no environment names (e.g. left by an adopt whose environment failed).
  app.delete('/placements/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    const done = await deletePlacement(id)
    if (!done.ok) {
      if (done.code === 'IN_USE')
        return fail(reply, 409, 'IN_USE', 'An environment still uses this placement')
      if (done.code === 'PLACEMENT_IN_USE')
        return fail(reply, 409, 'PLACEMENT_IN_USE', 'A move in progress uses this placement')
      return notFound(reply)
    }
    await logActivity({
      action: 'delete',
      user: userId(req),
      collection: PLACEMENTS,
      item: String(id),
      req
    })
    return reply.code(204).send()
  })

  // Phase 6: the agent is gone and the stack with it — the Hub stops guarding a stack it can no
  // longer see. {confirm: <stack name>}; 409 STACK_RUNNING while the agent reports it there.
  app.post('/placements/:id/forget-stack', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    try {
      const out = await forgetPlacementStack(id, body(req).confirm)
      if (!out.ok) return fail(reply, out.status, out.code, out.message)
      await logActivity({
        action: 'hub-stack-forget',
        user: userId(req),
        collection: PLACEMENTS,
        item: String(id),
        req,
        comment: JSON.stringify({ stack: out.stack, agent: out.agent })
      })
      const envIds = await environmentsUsing({ placement: id })
      for (const envId of envIds) await forgetEnvironment(app, envId)
      return { data: { id, stack: out.stack, forgotten_at: out.forgotten_at, agent: out.agent } }
    } catch (err) {
      if (err instanceof PromotionError) return fail(reply, err.status, err.code, err.message)
      throw err
    }
  })
}

// ─── Components ──────────────────────────────────────────────────────────────

const COMPONENTS = 'nivaro_hub_components'

function componentRoutes(app: FastifyInstance) {
  // Readable by admins and by an owner of the app deployed through the placement (anyone else
  // gets 404); writes are Hub-admin only.
  app.get('/placements/:id/components', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await getPlacement(id))) return notFound(reply)
    if (!req.isAdmin) {
      let owns = false
      for (const appId of await appsOfPlacement(id))
        if (await isAppOwner(appId, userId(req))) {
          owns = true
          break
        }
      if (!owns) return notFound(reply)
    }
    return { data: await listComponents(id) }
  })

  app.post('/placements/:id/components', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await getPlacement(id))) return notFound(reply)
    const checked = await validateComponentInput(id, body(req))
    if (!checked.ok) return fail(reply, checked.status, checked.code, checked.message)
    const made = await createComponent(id, checked.row)
    if (!made.ok) return fail(reply, made.status, made.code, made.message)
    await logActivity({
      action: 'create',
      user: userId(req),
      collection: COMPONENTS,
      item: String(made.row.id),
      req
    })
    await forgetDeploys(app, await environmentsUsing({ placement: id }))
    return { data: made.row }
  })

  app.patch('/components/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const existing = id === null ? null : await readComponent(id)
    if (id === null || !existing) return notFound(reply)
    const b = body(req)
    const checked = await validateComponentInput(existing.placement_id, b, existing)
    if (!checked.ok) return fail(reply, checked.status, checked.code, checked.message)
    const made = await updateComponent(existing, checked.row)
    if (!made.ok) return fail(reply, made.status, made.code, made.message)
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: COMPONENTS,
      item: String(id),
      req,
      changed_fields: Object.keys(checked.row).filter((k) => b[k] !== undefined)
    })
    await forgetDeploys(app, await environmentsUsing({ placement: existing.placement_id }))
    return { data: made.row }
  })

  app.delete('/components/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const existing = id === null ? null : await readComponent(id)
    if (id === null || !existing) return notFound(reply)
    await deleteComponent(id)
    await logActivity({
      action: 'delete',
      user: userId(req),
      collection: COMPONENTS,
      item: String(id),
      req
    })
    await forgetDeploys(app, await environmentsUsing({ placement: existing.placement_id }))
    return reply.code(204).send()
  })
}

// ─── Status ──────────────────────────────────────────────────────────────────

function statusRoutes(app: FastifyInstance) {
  app.get('/environments/:envId/status', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    return {
      data: await readEnvironmentStatus(statusTarget(row), {
        fresh: isFresh(req),
        redis: redisOf(app)
      })
    }
  })

  app.get('/apps/:id/status', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await readApp(id))) return notFound(reply)
    if (!req.isAdmin && !(await isAppOwner(id, userId(req)))) return notFound(reply)
    const rows = (await db(ENVS)
      .where({ app_id: id })
      .orderBy([
        { column: 'position', order: 'asc' },
        { column: 'id', order: 'asc' }
      ])) as Record<string, unknown>[]
    return {
      data: await readAppStatus(rows.map(statusTarget), {
        fresh: isFresh(req),
        redis: redisOf(app)
      })
    }
  })
}

// ─── Deploys ─────────────────────────────────────────────────────────────────

function deployLimit(req: FastifyRequest): number {
  const raw = (req.query as { limit?: unknown } | undefined)?.limit
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return 20
  return Math.max(1, Math.min(n, HUB_DEPLOYS_MAX_LIMIT))
}

type DeployAnswer = { data: HubDeploy[]; reason?: 'NO_DRIVER' }

/** A cached deploy-history answer, or null (miss, unreadable, or Redis slow/down). */
async function cachedDeploys(redis: HubRedis, key: string): Promise<DeployAnswer | null> {
  const raw = await bounded(() => redis.get(key))
  if (raw === TIMED_OUT || !raw) return null
  try {
    const v = JSON.parse(raw) as DeployAnswer
    return v && Array.isArray(v.data) ? v : null
  } catch {
    return null
  }
}

function deployRoutes(app: FastifyInstance) {
  // Read-only deploy history. Kept 60 s per environment + limit (nvr:hub:deploys:<env>:<limit>)
  // so an open page does not ask GitLab for N+1 calls on every visit; ?fresh=1 skips it, and an
  // environment, placement or driver write forgets it. Only answers are kept, never refusals.
  app.get('/environments/:envId/deploys', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    const limit = deployLimit(req)
    const redis = redisOf(app)
    const key = hubDeploysKey(Number(row.id), limit)
    if (redis && !isFresh(req)) {
      const hit = await cachedDeploys(redis, key)
      if (hit) return hit
    }
    try {
      const answer = await listEnvironmentDeploys(
        { placement_id: row.placement_id == null ? null : Number(row.placement_id) },
        { limit }
      )
      // Not awaited: a slow Redis never holds the answer.
      if (redis) void bounded(() => redis.set(key, JSON.stringify(answer), 'EX', HUB_DEPLOYS_TTL_S))
      return answer
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      if (code === 'GITLAB_UNREACHABLE')
        // The client's message can carry internal addresses; the code says enough.
        return fail(reply, 502, 'GITLAB_UNREACHABLE', 'GitLab did not answer')
      if (
        code === 'DRIVER_MISCONFIGURED' ||
        code === 'HUB_SECRET_UNREADABLE' ||
        code === 'HUB_SECRET_NOT_SEALED'
      )
        return fail(reply, 409, code, (err as Error).message)
      throw err
    }
  })
}

// ─── Promotions ──────────────────────────────────────────────────────────────

const DEPLOYS = 'nivaro_hub_deploys'

/**
 * A plan as answered: without each step's driverIdentity (the GitLab host and project path the
 * run is bound to — an internal address app owners need not see; admins see it on the driver).
 */
function answeredPlan<T>(plan: T): T {
  const steps = (plan as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps)) return plan
  return {
    ...plan,
    steps: steps.map((st) => {
      if (!st || typeof st !== 'object') return st
      const { driverIdentity: _bound, ...rest } = st as Record<string, unknown>
      return rest
    })
  }
}

/** Maps what gather / the runner throw onto an HTTP answer; anything else rethrows. */
function promotionRefusal(reply: FastifyReply, err: unknown) {
  if (err instanceof PromotionError) {
    const out: Record<string, unknown> = { error: err.message, code: err.code }
    if (err.blockers) out.blockers = err.blockers
    if (err.plan !== undefined) out.plan = answeredPlan(err.plan)
    return reply.code(err.status).send(out)
  }
  const code = (err as { code?: unknown } | null)?.code
  if (err instanceof GitlabWriteError)
    return fail(
      reply,
      code === 'GITLAB_UNREACHABLE' ? 502 : 409,
      String(code),
      code === 'GITLAB_UNREACHABLE' ? 'GitLab did not answer' : err.message
    )
  if (
    err instanceof HubSecretError ||
    code === 'DRIVER_MISCONFIGURED' ||
    code === 'HUB_SECRET_UNREADABLE' ||
    code === 'HUB_SECRET_NOT_SEALED'
  )
    return fail(reply, 409, String(code), (err as Error).message)
  throw err
}

function promoteInput(
  req: FastifyRequest
): { kind: 'promote' | 'rollback'; version: string } | null {
  const b = body(req)
  if (b.kind !== 'promote' && b.kind !== 'rollback') return null
  return { kind: b.kind, version: typeof b.version === 'string' ? b.version.trim() : '' }
}

/** The deploy row `:id` names when the caller may reach its environment; else undefined (404). */
async function readablePromotion(req: FastifyRequest) {
  const id = idParam((req.params as { id: string }).id)
  if (id === null) return undefined
  const row = await readHubDeploy(id)
  if (!row) return undefined
  if (!req.isAdmin && !(await isAppOwner(row.app_id, userId(req)))) return undefined
  return row
}

const newestFirst = (xs: string[]) => [...xs].sort((a, b) => compareVersions(b, a))

function promotionRoutes(app: FastifyInstance) {
  // Hub admins and the environment's app owners (anyone else: 404). POSTs here are writes the
  // root maintenance freeze already refuses; the plan is a read that never takes the lock.
  app.get('/environments/:envId/promotable', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    const envId = Number(row.id)
    try {
      const [fwd, back] = await Promise.all([
        gatherPlanInput(envId, { kind: 'promote', version: '' }),
        gatherPlanInput(envId, { kind: 'rollback', version: '' })
      ])
      const cur = fwd.targetVersion
      // phase 4: the first environment of an all-stack app takes published releases (Decision 11).
      const offered = [
        ...new Set([...fwd.previousDeployedVersions, ...(fwd.registryVersions ?? [])])
      ]
      const promote = cur ? offered.filter((v) => compareVersions(v, cur) > 0) : offered
      // Rollback: only versions whose every build the Hub recorded here (never pre-Hub ones).
      const rollback = cur
        ? (back.rollbackVersions ?? back.targetDeployedVersions).filter(
            (v) => compareVersions(v, cur) < 0
          )
        : []
      // A Hub promotion of the version running here that stopped between components: offered
      // again so it can be finished (the planner judges whether it can start).
      const finish =
        cur && (await unrecordedComponents(envId, cur, fwd.components ?? [])) ? cur : null
      if (finish && !promote.includes(finish)) promote.push(finish)
      return {
        data: {
          promote: newestFirst(promote),
          rollback: newestFirst(rollback),
          finish,
          // The environment promotions come from (null: this is the first one).
          previous: fwd.previous?.key ?? null,
          // phase 4: the published releases could not be read (first all-stack environment).
          ...(fwd.registryError ? { releases_error: true } : {})
        }
      }
    } catch (err) {
      return promotionRefusal(reply, err)
    }
  })

  app.post('/environments/:envId/promote/plan', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    const input = promoteInput(req)
    if (!input) return fail(reply, 400, 'BAD_KIND', 'kind must be promote or rollback')
    // Final review moves I-2 (P6-37): owners too — a promotion re-deploys what a move relies on.
    const open = await moveOpenRefusal({ envIds: [Number(row.id)] })
    if (open) return fail(reply, open.status, open.code, open.message)
    try {
      return {
        data: answeredPlan(buildPromotionPlan(await gatherPlanInput(Number(row.id), input)))
      }
    } catch (err) {
      return promotionRefusal(reply, err)
    }
  })

  app.post('/environments/:envId/promote', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    const input = promoteInput(req)
    if (!input) return fail(reply, 400, 'BAD_KIND', 'kind must be promote or rollback')
    try {
      // An administrator's emergency start outside the deploy windows (never past a freeze or
      // the checklist): services/hub/changes/emergency.ts.
      const emergency = await import('../services/hub/changes/emergency.js')
      let outside: { reason: string } | null
      try {
        outside = emergency.outsideWindowOf(req, body(req))
      } catch (e) {
        if (e instanceof emergency.OutsideWindowError)
          return fail(reply, e.status, e.code, e.message)
        throw e
      }
      const closed = outside
        ? await emergency.windowWasClosed({
            appIds: [Number(row.app_id)],
            action: 'promote',
            envId: Number(row.id)
          })
        : false
      const started = await startPromotion(Number(row.id), {
        ...input,
        confirm: body(req).confirm,
        planHash: body(req).plan_hash,
        user: { id: userId(req) },
        // Pre-deploy checklist ticked for this production promotion (hub-changes.ts).
        checklistRunId: body(req).checklist_run_id,
        ...(outside ? { outsideWindow: outside } : {})
      })
      if (outside && closed)
        await emergency.recordOutsideWindow({
          req,
          userId: userId(req),
          action: 'promote',
          appIds: [Number(row.app_id)],
          where: String(row.key),
          reason: outside.reason,
          collection: DEPLOYS,
          item: String(started.deployId)
        })
      await logActivity({
        action: 'hub-promote-start',
        user: userId(req),
        collection: DEPLOYS,
        item: String(started.deployId),
        req
      })
      // Release notes of the run (GitLab compare, build facts): stored once, never awaited.
      void import('../services/hub/releases/notes.js')
        .then((m) => m.recordReleaseNotes(started.deployId))
        .catch(() => undefined)
      return reply
        .code(202)
        .send({ data: { deploy_id: started.deployId, job_run_id: started.jobRunId } })
    } catch (err) {
      return promotionRefusal(reply, err)
    }
  })

  // Both status reads heal the environment's stale running rows first (bounded, lock- and
  // heartbeat-gated): a run whose server stopped shows Interrupted within minutes.
  app.get('/environments/:envId/deploys/hub', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    await healBeforeRead(Number(row.id))
    return { data: await listHubDeploys(Number(row.id), deployLimit(req)) }
  })

  app.get('/promotions/:id', { preHandler: requireAuth }, async (req, reply) => {
    const found = await readablePromotion(req)
    if (!found) return notFound(reply)
    let row = found
    if (found.status === 'running') {
      await healBeforeRead(found.environment_id)
      row = (await readHubDeploy(found.id)) ?? found
    }
    let plan: unknown = null
    try {
      plan = row.plan ? answeredPlan(JSON.parse(row.plan)) : null
    } catch {
      plan = null
    }
    const log = row.job_run_id == null ? [] : await readJobLog(row.job_run_id)
    return { data: { ...row, plan, log } }
  })

  app.post('/promotions/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readablePromotion(req)
    if (!row) return notFound(reply)
    const res = await cancelPromotion(row.id, { id: userId(req) })
    if (!res.ok)
      return res.code === 'NOT_FOUND'
        ? notFound(reply)
        : fail(reply, 409, res.code, 'That promotion is not running')
    await logActivity({
      action: 'hub-promote-cancel',
      user: userId(req),
      collection: DEPLOYS,
      item: String(row.id),
      req
    })
    // A run nobody was running any more is marked interrupted at once.
    return reply
      .code(202)
      .send({ data: { id: row.id, ...(res.interrupted ? { status: 'interrupted' } : {}) } })
  })
}

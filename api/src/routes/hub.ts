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
import { listEnvironmentDeploys } from '../services/hub/deploys.js'
import {
  createDriver,
  createPlacement,
  deleteDriver,
  getDriver,
  getPlacement,
  listDrivers,
  publicDriver,
  updateDriver,
  updatePlacement,
  validateDriverInput,
  validatePlacementInput
} from '../services/hub/drivers.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import { HubSecretError, nextSecret } from '../services/hub/secrets.js'
import { readAppStatus, readEnvironmentStatus, type StatusCache } from '../services/hub/status.js'

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
  appRoutes(app)
  ownerRoutes(app)
  environmentRoutes(app)
  driverRoutes(app)
  placementRoutes(app)
  statusRoutes(app)
  deployRoutes(app)
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

type HubRedis = StatusCache & { del(key: string): Promise<unknown> }

/** The app's Redis client when one is decorated (tests and Redis-less boots have none). */
function redisOf(app: FastifyInstance): HubRedis | null {
  return (app as unknown as { redis?: HubRedis }).redis ?? null
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
    if (await db(ENVS).where({ app_id: id }).first('id'))
      return fail(
        reply,
        409,
        'HAS_ENVIRONMENTS',
        'Remove the app’s environments before deleting it'
      )
    await db.transaction(async (trx) => {
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
  return { patch }
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
    if (await db(ENVS).where({ app_id: appId, key: patch.key }).first('id'))
      return fail(reply, 409, 'KEY_TAKEN', `This app already has an environment "${patch.key}"`)
    return guarded(reply, async () => {
      const token = b.hub_token === undefined ? null : nextSecret(b.hub_token, null)
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
        hub_token: token,
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
    if (
      patch.key !== undefined &&
      (await db(ENVS)
        .where({ app_id: current.app_id, key: patch.key })
        .whereNot({ id })
        .first('id'))
    )
      return fail(reply, 409, 'KEY_TAKEN', `This app already has an environment "${patch.key}"`)
    return guarded(reply, async () => {
      if (b.hub_token !== undefined)
        patch.hub_token = nextSecret(b.hub_token, (current.hub_token as string | null) ?? null)
      if (Object.keys(patch).length) {
        await db(ENVS)
          .where({ id })
          .update({ ...patch, updated_at: now() })
        await logActivity({
          action: 'update',
          user: userId(req),
          collection: ENVS,
          item: String(id),
          req,
          changed_fields: Object.keys(patch)
        })
      }
      const row = await readEnvironmentRow(id)
      return { data: row ? environmentFromRow(row) : null }
    })
  })

  app.delete('/environments/:envId', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { envId: string }).envId)
    if (id === null || !(await readEnvironmentRow(id))) return notFound(reply)
    await db(ENVS).where({ id }).del()
    await logActivity({
      action: 'delete',
      user: userId(req),
      collection: ENVS,
      item: String(id),
      req
    })
    return { data: { id } }
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
    hub_token: (row.hub_token as string | null) ?? null
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
    if (!(await getDriver(checked.row.driver_id))) return noDriver(reply)
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
    const checked = validatePlacementInput({
      kind: b.kind ?? existing.kind,
      driver_id: b.driver_id ?? existing.driver_id,
      target: b.target ?? existing.target
    })
    if (!checked.ok) return fail(reply, 400, checked.code, checked.message)
    if (checked.row.driver_id !== existing.driver_id && !(await getDriver(checked.row.driver_id)))
      return noDriver(reply)
    const updated = await updatePlacement(id, checked.row)
    if (!updated) return notFound(reply)
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: PLACEMENTS,
      item: String(id),
      req,
      changed_fields: ['kind', 'driver_id', 'target'].filter((k) => b[k] !== undefined)
    })
    return { data: updated }
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
  return Math.max(1, Math.min(n, 50))
}

function deployRoutes(app: FastifyInstance) {
  app.get('/environments/:envId/deploys', { preHandler: requireAuth }, async (req, reply) => {
    const row = await readableEnvironment(req)
    if (!row) return notFound(reply)
    try {
      return await listEnvironmentDeploys(
        { placement_id: row.placement_id == null ? null : Number(row.placement_id) },
        { limit: deployLimit(req) }
      )
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

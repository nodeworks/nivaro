import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam, isAppOwner, readApp } from '../services/hub/apps.js'
import {
  appEnvironments,
  ownersDeployProduction,
  productionMap,
  reportedEnvironment
} from '../services/hub/owner-access.js'
import { personAccess } from '../services/hub/people/access.js'
import {
  identityHash,
  isPersonKey,
  listPeople,
  readPerson
} from '../services/hub/people/directory.js'
import {
  liftOffboardBlock,
  listOffboards,
  OffboardError,
  readOffboard,
  retryOffboard,
  startOffboard
} from '../services/hub/people/offboard.js'
import { phoneRuns, phoneSummary } from '../services/hub/phone.js'

/**
 * Nivaro Hub enhancements, mounted under /api/hub (routes/hub.ts, hub mode only):
 *
 * People (Hub admins only):
 *   GET  /people?q=&limit=&offset=          the directory (nivaro_hub_signins, grouped per person)
 *   GET  /people/:key                       one person + their offboard runs (no app is asked)
 *   GET  /people/:key/access                every environment asked live: accounts + role there
 *   POST /people/:key/offboard {confirm, identity_hash}   "Offboard everywhere" (202); confirm =
 *                                           their first proven email (or the key), identity_hash =
 *                                           the one GET /people/:key showed (409 IDENTITY_CHANGED)
 *   GET  /offboards  /offboards/:id         runs, with per-environment results
 *   POST /offboards/:id/retry               ask again what did not finish (202)
 *   POST /offboards/:id/lift {confirm}      lift the block + reactivate the Hub account (apps stay)
 * Keys are opaque (u:<hub user id> | k:<sign-in row id>): an email never travels in a URL.
 *
 * App owner self-service:
 *   GET  /apps/:id/access                   what the caller may do on each environment (owner/admin)
 *   PUT  /apps/:id/owner-policy {owners_deploy_production}   admin only, logged
 *   PUT  /environments/:envId/production {production: true|false|null}   admin only, logged
 *
 * Phone app (read-only, any sign-in incl. a phone's nvd_ token; services/hub/phone.ts):
 *   GET  /mobile/summary   GET /mobile/runs?limit=
 */

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

function redisOf(app: FastifyInstance): unknown {
  return (app as unknown as { redis?: unknown }).redis ?? null
}

function intQuery(req: FastifyRequest, name: string): number | undefined {
  const raw = (req.query as Record<string, unknown> | undefined)?.[name]
  const n = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(n) ? n : undefined
}

function offboardRefusal(reply: FastifyReply, err: unknown) {
  if (err instanceof OffboardError) return fail(reply, err.status, err.code, err.message)
  throw err
}

export function hubPeopleRoutes(app: FastifyInstance) {
  // ─── People directory + offboarding (admins) ──────────────────────────────────────────────
  app.get('/people', { preHandler: requireAdmin }, async (req) => {
    const q = (req.query as { q?: unknown } | undefined)?.q
    return listPeople({
      q: typeof q === 'string' ? q.slice(0, 200) : undefined,
      limit: intQuery(req, 'limit'),
      offset: intQuery(req, 'offset')
    })
  })

  app.get('/people/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { key: string }).key
    if (!isPersonKey(key)) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const found = await readPerson(key)
    if (!found) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    return {
      data: {
        ...found.person,
        // Exactly what every app would be asked to suspend (proven only: directory.ts
        // identityOf); the offboard binds to this hash.
        identity: found.identity,
        identity_hash: identityHash(found.identity),
        offboards: await listOffboards({ personKey: key, limit: 20 })
      }
    }
  })

  app.get('/people/:key/access', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { key: string }).key
    if (!isPersonKey(key)) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const found = await readPerson(key)
    if (!found) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    await logActivity({
      action: 'hub-people-lookup',
      user: userId(req),
      collection: 'nivaro_hub_signins',
      comment: found.person.email ?? key,
      req
    })
    return { data: await personAccess(found.identity) }
  })

  app.post('/people/:key/offboard', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { key: string }).key
    if (!isPersonKey(key)) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const found = await readPerson(key)
    if (!found) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const expected = found.identity.emails[0] ?? key
    const confirm = body(req).confirm
    if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== expected.toLowerCase())
      return fail(reply, 400, 'CONFIRM_REQUIRED', `Type ${expected} to offboard this person`)
    // The admin confirmed the exact emails and Entra ids shown: a change since is refused.
    const hash = identityHash(found.identity)
    if (body(req).identity_hash !== hash)
      return reply.code(409).send({
        error: 'What would be suspended changed since the page showed it — check it again.',
        code: 'IDENTITY_CHANGED',
        identity: found.identity,
        identity_hash: hash
      })
    try {
      const run = await startOffboard(
        {
          personKey: key,
          label: [found.person.name, found.person.email].filter(Boolean).join(' · ') || key,
          hubUserId: found.person.hub_user_id,
          identity: found.identity,
          caller: userId(req)
        },
        { redis: redisOf(app) }
      )
      return reply.code(202).send({ data: run })
    } catch (err) {
      return offboardRefusal(reply, err)
    }
  })

  app.get('/offboards', { preHandler: requireAdmin }, async (req) => ({
    data: await listOffboards({ limit: intQuery(req, 'limit') })
  }))

  app.get('/offboards/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const row = id === null ? null : await readOffboard(id)
    if (!row) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    return { data: row }
  })

  app.post('/offboards/:id/retry', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    try {
      return reply
        .code(202)
        .send({ data: await retryOffboard(id, userId(req), { redis: redisOf(app) }) })
    } catch (err) {
      return offboardRefusal(reply, err)
    }
  })

  app.post('/offboards/:id/lift', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    try {
      return { data: await liftOffboardBlock(id, userId(req), body(req).confirm) }
    } catch (err) {
      return offboardRefusal(reply, err)
    }
  })

  // ─── App owner self-service ──────────────────────────────────────────────────────────────
  app.get('/apps/:id/access', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await readApp(id))) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const admin = req.isAdmin === true
    const owner = await isAppOwner(id, userId(req))
    if (!admin && !owner) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const switchOn = await ownersDeployProduction(id)
    const envs = await appEnvironments(id)
    for (const e of envs) e.reported = await reportedEnvironment(e.id, redisOf(app) as never)
    const prod = productionMap(envs)
    return {
      data: {
        admin,
        owner,
        owners_deploy_production: switchOn,
        environments: envs.map((e) => {
          const production = prod.get(e.id) ?? true
          const deploy = admin || (owner && (!production || switchOn))
          return {
            id: e.id,
            key: e.key,
            production,
            deploy,
            // The admin's flag (true / false / null = auto) and why production, for the page.
            production_flag: e.production ?? null,
            archived: String(e.status ?? '') === 'archived',
            reported: e.reported ?? null
          }
        })
      }
    }
  })

  // The admin's per-environment production flag (owner gate): true = production, false =
  // explicitly not (the only way to open the last environment of a chain), null = auto.
  app.put('/environments/:envId/production', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = idParam((req.params as { envId: string }).envId)
    const row =
      envId === null
        ? undefined
        : ((await db('nivaro_hub_environments').where({ id: envId }).first('id', 'app_id')) as
            | { id: number; app_id: number }
            | undefined)
    if (!row) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const v = body(req).production
    if (v !== true && v !== false && v !== null)
      return fail(reply, 400, 'BAD_PRODUCTION', 'production must be true, false or null')
    await db('nivaro_hub_environments').where({ id: row.id }).update({ production: v })
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: 'nivaro_hub_environments',
      item: String(row.id),
      comment:
        v === true
          ? 'Marked production (owner gate)'
          : v === false
            ? 'Marked not production (owner gate)'
            : 'Production worked out by the Hub (owner gate)',
      changed_fields: ['production'],
      req
    })
    return { data: { id: row.id, production: v } }
  })

  app.put('/apps/:id/owner-policy', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await readApp(id))) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const v = body(req).owners_deploy_production
    if (typeof v !== 'boolean')
      return fail(reply, 400, 'BAD_POLICY', 'owners_deploy_production must be true or false')
    await db('nivaro_hub_apps')
      .where({ id })
      .update({ owners_deploy_production: v, updated_at: new Date() })
    await logActivity({
      action: 'update',
      user: userId(req),
      collection: 'nivaro_hub_apps',
      item: String(id),
      comment: v ? 'Owners may deploy production' : 'Production deploys: Hub administrators only',
      changed_fields: ['owners_deploy_production'],
      req
    })
    return { data: { owners_deploy_production: v } }
  })

  // ─── Phone app (read-only) ────────────────────────────────────────────────────────────────
  app.get('/mobile/summary', { preHandler: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return {
      data: await phoneSummary(
        { id: userId(req), isAdmin: req.isAdmin === true },
        redisOf(app) as Parameters<typeof phoneSummary>[1]
      )
    }
  })

  app.get('/mobile/runs', { preHandler: requireAuth }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return {
      data: await phoneRuns(
        { id: userId(req), isAdmin: req.isAdmin === true },
        intQuery(req, 'limit') ?? 20
      )
    }
  })
}

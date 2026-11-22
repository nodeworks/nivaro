import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam, isAppOwner } from '../services/hub/apps.js'
import { gatherCreationFacts } from '../services/hub/create/gather.js'
import { buildCreationPlan } from '../services/hub/create/plan.js'
import {
  awaitTargetSyncs,
  CreationError,
  cancelCreation,
  checkWaitingCreations,
  confirmOperatorInstalled,
  readCreation,
  recoverInterruptedCreations,
  resumeCreation,
  startCreation,
  syncTargetApps
} from '../services/hub/create/run.js'
import { readCreationRow } from '../services/hub/create/store.js'
import {
  createTarget,
  deleteTarget,
  getTargetRow,
  listTargets,
  publicTarget,
  TargetMisconfiguredError,
  testTarget,
  updateTarget,
  validateTargetInput
} from '../services/hub/create/targets.js'
import type { CreateAppInput } from '../services/hub/create/types.js'
import { type ChecklistItem, dbaChecklist } from '../services/hub/db/checklist.js'
import type { HubDbCode } from '../services/hub/db/codes.js'
import { connectionFromInput, type HubDbEngine } from '../services/hub/db/connection.js'
import {
  adoptDatabase,
  checkDatabase,
  deleteDatabase,
  getDatabase,
  type HubDatabase,
  listDatabases,
  setConnection
} from '../services/hub/db/databases.js'
import {
  createServer,
  deleteServer,
  getServerRow,
  HubDbError,
  listServers,
  publicServer,
  testServer,
  updateServer,
  validateServerInput
} from '../services/hub/db/servers.js'
import { placeOf, samePlace } from '../services/hub/db/stored-connection.js'
import { GitlabWriteError } from '../services/hub/gitlab-write.js'
import { HUB_MASK, HubSecretError } from '../services/hub/secrets.js'
import { currentTenantKey } from '../services/tenant-rooms.js'

/**
 * Nivaro Hub phase 3 routes, mounted by hubRoutes (so only in hub mode, under /api/hub):
 * database servers, databases, targets (where new apps go) and app creation.
 *
 * Every write is a Hub admin's, except where an app owner may act on their own environment's
 * creation (check, Installed) or database (connection, check). A person who may not reach an
 * environment or database gets 404, never 403. Nothing here answers a stored row as it is: servers,
 * targets and databases go through their public shapes, so every secret is the mask.
 */
export function hubPhase3Routes(app: FastifyInstance) {
  // Once per process start: creation legs a previous process left `running` become `interrupted`.
  app.addHook('onReady', async () => {
    try {
      await recoverInterruptedCreations()
    } catch (err) {
      app.log.warn({ err: (err as Error | null)?.name ?? 'Error' }, 'hub creation recovery failed')
    }
  })
  // Waiting creations (a DBA's database, a hand-made name, a busy environment) are looked at
  // again every 5 minutes; also checks waiting names no creation walks.
  app.cron?.schedule(
    'hub-creation-waits',
    '*/5 * * * *',
    async () => {
      await checkWaitingCreations()
    },
    {
      idempotent: 'safe',
      description:
        'Every 5 minutes — Hub app creation: heals creation legs a stopped process left running, looks again at every creation waiting for a database or a hostname (and starts it once that is there), starts legs that found their environment busy, and checks environments waiting for their name.'
    }
  )
  // Target syncs still running in the background (PATCH /targets answered `pending`): a deploy
  // waits for them, at most TARGET_SYNC_CLOSE_WAIT_MS.
  app.addHook('onClose', async () => {
    await awaitTargetSyncs(TARGET_SYNC_CLOSE_WAIT_MS)
  })
  dbServerRoutes(app)
  databaseRoutes(app)
  targetRoutes(app)
  creationRoutes(app)
}

/** How long a closing process waits for background target syncs. */
export const TARGET_SYNC_CLOSE_WAIT_MS = 10_000

const SERVERS = 'nivaro_hub_db_servers'
const DATABASES = 'nivaro_hub_databases'
const TARGETS = 'nivaro_hub_targets'
const APPS = 'nivaro_hub_apps'
const ENVS = 'nivaro_hub_environments'

type Body = Record<string, unknown>

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

/** A database / server refusal: typed against HUB_DB_CODES, so the admin has copy for it. */
const dbFail = (reply: FastifyReply, status: number, code: HubDbCode, error: string) =>
  fail(reply, status, code, error)

const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Not found')

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

function userId(req: FastifyRequest): string {
  return String(req.user?.id ?? '')
}

function idOf(req: FastifyRequest, name = 'id'): number | null {
  return idParam((req.params as Record<string, string>)[name])
}

/**
 * The answer for what the Hub services throw. Every message here is the service's own (already
 * scrubbed), never a driver's or GitLab's text. Anything else is a fixed 500 HUB_ERROR: its
 * message is never answered, and only its name is logged (a driver error may carry a secret).
 */
function refusal(reply: FastifyReply, err: unknown) {
  if (err instanceof CreationError) {
    const out: Record<string, unknown> = { error: err.message, code: err.code }
    if (err.blockers) out.blockers = err.blockers
    return reply.code(err.status).send(out)
  }
  if (err instanceof HubDbError) return fail(reply, err.status, err.code, err.message)
  if (err instanceof HubSecretError) return fail(reply, 400, err.code, err.message)
  if (err instanceof GitlabWriteError)
    return fail(
      reply,
      502,
      err.code,
      err.code === 'GITLAB_UNREACHABLE' ? 'GitLab did not answer' : err.message
    )
  if (err instanceof TargetMisconfiguredError) return fail(reply, 409, err.code, err.message)
  reply.log.error({ err: (err as Error | null)?.name ?? typeof err }, 'hub route failed')
  return fail(reply, 500, 'HUB_ERROR', 'The Hub could not do that; see the server log.')
}

async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (err) {
    return refusal(reply, err)
  }
}

/**
 * Field names of a write (never values) for the activity row. A secret field re-sent as the mask
 * kept the stored value, so it is not a change.
 */
const fieldsOf = (b: Body, known: readonly string[], secrets: readonly string[] = []) =>
  known.filter((k) => b[k] !== undefined && !(secrets.includes(k) && b[k] === HUB_MASK))

// ─── Database servers ────────────────────────────────────────────────────────

const SERVER_FIELDS = [
  'name',
  'engine',
  'host',
  'port',
  'provision_mode',
  'admin_secret',
  'ssl_mode',
  'trust_server_cert',
  'collation',
  'user_host',
  'notes'
] as const

function dbServerRoutes(app: FastifyInstance) {
  app.get('/db-servers', { preHandler: requireAdmin }, async () => {
    return { data: await listServers() }
  })

  app.post('/db-servers', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const checked = validateServerInput(body(req))
      if (!checked.ok) return dbFail(reply, 400, checked.code, checked.message)
      const created = await createServer(checked.row)
      await logActivity({
        action: 'create',
        user: userId(req),
        collection: SERVERS,
        item: String(created.id),
        req
      })
      return { data: created }
    })
  )

  app.patch('/db-servers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    const existing = id === null ? null : await getServerRow(id)
    if (id === null || !existing) return notFound(reply)
    const b = body(req)
    return guarded(reply, async () => {
      // The stored row fills what the body leaves out (and the mask keeps the stored login).
      const checked = validateServerInput(b, existing)
      if (!checked.ok) return dbFail(reply, 400, checked.code, checked.message)
      const updated = await updateServer(id, checked.row)
      if (!updated) return notFound(reply)
      // A login sent back masked (the mask string, or both halves masked) kept the stored one.
      const keptLogin =
        existing.admin_secret != null && checked.row.admin_secret === existing.admin_secret
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: SERVERS,
        item: String(id),
        req,
        changed_fields: fieldsOf(b, SERVER_FIELDS, ['admin_secret']).filter(
          (f) => !(f === 'admin_secret' && keptLogin)
        )
      })
      return { data: updated }
    })
  })

  app.delete('/db-servers/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return notFound(reply)
    const done = await deleteServer(id)
    if (!done.ok)
      return done.code === 'IN_USE'
        ? dbFail(reply, 409, 'IN_USE', 'A database recorded on this server still names it')
        : notFound(reply)
    await logActivity({
      action: 'delete',
      user: userId(req),
      collection: SERVERS,
      item: String(id),
      req
    })
    return { data: { id } }
  })

  app.post('/db-servers/:id/test', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return notFound(reply)
    return guarded(reply, async () => ({ data: await testServer(id) }))
  })
}

// ─── Databases ───────────────────────────────────────────────────────────────

/** The DBA checklist while a database requested on a manual server is not ready yet. */
async function checklistFor(d: HubDatabase): Promise<ChecklistItem[] | null> {
  if (d.created_by_hub || d.adopted || d.status === 'ready' || d.server_id === null) return null
  if (!d.login_name) return null
  const server = await getServerRow(d.server_id)
  return server ? dbaChecklist(publicServer(server), d.database_name, d.login_name) : null
}

/**
 * The database `:id` names when the caller may reach it: admins any, an app owner only one
 * attached to an environment of their app. Everything else is null (404).
 */
async function readableDatabase(req: FastifyRequest): Promise<HubDatabase | null> {
  const id = idOf(req)
  if (id === null) return null
  const found = await getDatabase(id)
  if (!found) return null
  if (req.isAdmin) return found
  if (found.environment && (await isAppOwner(found.environment.app_id, userId(req)))) return found
  return null
}

/**
 * A database that just became ready while its environment's creation waits for it: the
 * creation is looked at now (it starts its leg). Never fails the request that made it ready.
 */
async function resumeWaitingFor(
  d: HubDatabase,
  req: FastifyRequest
): Promise<{ status: string } | null> {
  if (d.status !== 'ready' || !d.environment) return null
  try {
    const row = await readCreationRow(d.environment.id)
    if (row?.status !== 'waiting' || row.waiting_for !== 'database') return null
    const out = await resumeCreation(d.environment.id, { id: userId(req) }, 'check')
    await logActivity({
      action: 'hub-create-check',
      user: userId(req),
      collection: ENVS,
      item: String(d.environment.id),
      comment: `Database ${d.database_name} ready: ${out.status}`,
      req
    })
    return out
  } catch (err) {
    req.log.warn({ err: (err as Error | null)?.name ?? 'Error' }, 'hub creation resume failed')
    return null
  }
}

/** The connection a PUT carries: the body itself or `{connection}`, engine defaulting to the row's. */
function connectionInput(b: Body, engine: string): Record<string, unknown> {
  const raw = b.connection
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : b
  return c.engine === undefined && c.url === undefined ? { ...c, engine } : c
}

// ─── Owner limits (ruling P3-24) ─────────────────────────────────────────────

/**
 * An owner (not a Hub admin) may point a database check only at the row's own server: the host
 * and port they send (PUT connection) or the row holds (Check now) must be the server's, compared
 * as the server's own rules do (case, a trailing dot, the engine's default port). Otherwise the
 * Hub would try logins against any host and port for them. Answers the refusal, or null.
 */
async function ownerPlaceRefusal(
  found: HubDatabase,
  place: { engine: HubDbEngine; host: string; port: number | null }
): Promise<string | null> {
  const server = found.server_id === null ? null : await getServerRow(found.server_id)
  if (server && samePlace(placeOf(place), placeOf(server))) return null
  return server
    ? `Only this database's server (${server.host}${server.port ? `:${server.port}` : ''}) can be used here.`
    : 'This database has no server an owner may connect to; ask a Hub admin.'
}

export const OWNER_TRY_LIMIT = 10
export const OWNER_TRY_WINDOW_S = 600
const memoryTries = new Map<string, { n: number; until: number }>()

export type TryRedis = {
  set(k: string, v: string, ex: 'EX', s: number, nx: 'NX'): Promise<unknown>
  incr(k: string): Promise<number>
}

/**
 * Counts one try under `key` and answers the count in the current window. Redis: the window is
 * set WITH the key (SET key 0 EX <window> NX), then INCR — no separate EXPIRE that could fail and
 * leave a key that never expires (an owner locked out for good). Redis absent or failing: counted
 * in this process instead, once (a failed INCR counted nothing there).
 */
export async function countOwnerTry(redis: TryRedis | null, key: string): Promise<number> {
  if (redis) {
    try {
      await redis.set(key, '0', 'EX', OWNER_TRY_WINDOW_S, 'NX')
      return Number(await redis.incr(key))
    } catch {
      // Redis trouble: count here instead
    }
  }
  const now = Date.now()
  if (memoryTries.size > 5000)
    for (const [k, v] of memoryTries) if (v.until <= now) memoryTries.delete(k)
  const cur = memoryTries.get(key)
  const entry = cur && cur.until > now ? cur : { n: 0, until: now + OWNER_TRY_WINDOW_S * 1000 }
  entry.n++
  memoryTries.set(key, entry)
  return entry.n
}

/**
 * An owner's connection try on a database: at most OWNER_TRY_LIMIT per OWNER_TRY_WINDOW_S per
 * person per database (keyed with the tenant). True = over the limit.
 */
async function overTryLimit(app: FastifyInstance, req: FastifyRequest, dbId: number) {
  const key = `nvr:hub:db-tries:${currentTenantKey() || '-'}:${userId(req)}:${dbId}`
  const redis = (app as unknown as { redis?: TryRedis }).redis ?? null
  return (await countOwnerTry(redis, key)) > OWNER_TRY_LIMIT
}

/**
 * The P3-24 gate for a non-admin's database try. True = it answered (400 HOST_NOT_SERVER or 429
 * TOO_MANY_TRIES) and the route must stop. A boolean, never the reply: a FastifyReply is a
 * thenable, so an async function answering it resolves to undefined.
 */
async function ownerTryRefused(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  found: HubDatabase,
  place: { engine: HubDbEngine; host: string; port: number | null }
): Promise<boolean> {
  if (req.isAdmin) return false
  const wrong = await ownerPlaceRefusal(found, place)
  if (wrong) {
    dbFail(reply, 400, 'HOST_NOT_SERVER', wrong)
    return true
  }
  if (await overTryLimit(app, req, found.id)) {
    reply
      .code(429)
      .header('Retry-After', String(OWNER_TRY_WINDOW_S))
      .send({
        error: 'Too many tries on this database; wait a few minutes.',
        code: 'TOO_MANY_TRIES' satisfies HubDbCode
      })
    return true
  }
  return false
}

function databaseRoutes(app: FastifyInstance) {
  app.get('/databases', { preHandler: requireAdmin }, async () => {
    return { data: await listDatabases() }
  })

  app.get('/databases/:id', { preHandler: requireAuth }, async (req, reply) => {
    const found = await readableDatabase(req)
    if (!found) return notFound(reply)
    return { data: { ...found, checklist: await checklistFor(found) } }
  })

  app.post('/databases/adopt', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const b = body(req)
      const raw = b.connection
      const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : b
      const adopted = await adoptDatabase(input, userId(req) || null)
      await logActivity({
        action: 'hub-db-adopt',
        user: userId(req),
        collection: DATABASES,
        item: String(adopted.id),
        comment: `Adopted ${adopted.database_name} (${adopted.engine})`,
        req
      })
      // A database that already holds a Nivaro install is accepted, with a plain warning
      // (ruling P3-32): an app given it starts on that data.
      const n = adopted.last_check?.state === 'nivaro' ? adopted.last_check : null
      return {
        data: { ...adopted, checklist: null },
        ...(n
          ? {
              warning: `${adopted.database_name} already holds a Nivaro install${n.migrations != null ? ` (${n.migrations} migrations${n.last_migration ? `, last ${n.last_migration}` : ''})` : ''}: the app starts on that data and its users, and the first administrator is made only if it has none. Make sure no other app still uses it.`
            }
          : {})
      }
    })
  )

  app.put('/databases/:id/connection', { preHandler: requireAuth }, async (req, reply) => {
    const found = await readableDatabase(req)
    if (!found) return notFound(reply)
    let input = connectionInput(body(req), found.engine)
    if (!req.isAdmin) {
      const parsed = connectionFromInput(input)
      if (!parsed.ok) return dbFail(reply, 400, 'BAD_CONNECTION', parsed.message)
      if (await ownerTryRefused(app, req, reply, found, parsed.conn)) return reply
      // P3-24: an owner's TLS settings are the server's; whatever they sent (or a URL carried)
      // is ignored, so they cannot weaken the connection the Hub makes.
      const server = found.server_id === null ? null : await getServerRow(found.server_id)
      input = {
        ...parsed.conn,
        ssl_mode: server?.ssl_mode ?? null,
        trust_server_cert: server?.trust_server_cert ?? false
      }
    }
    return guarded(reply, async () => {
      const { db: saved, check } = await setConnection(found.id, input)
      await logActivity({
        action: 'hub-db-connection',
        user: userId(req),
        collection: DATABASES,
        item: String(found.id),
        comment: `Connection saved; check: ${check.state}`,
        req
      })
      const creation = await resumeWaitingFor(saved, req)
      return { data: { ...saved, checklist: await checklistFor(saved) }, check, creation }
    })
  })

  app.post('/databases/:id/check', { preHandler: requireAuth }, async (req, reply) => {
    const found = await readableDatabase(req)
    if (!found) return notFound(reply)
    // An owner's Check now connects where the row points: only to its own server.
    if (
      await ownerTryRefused(app, req, reply, found, {
        engine: found.engine,
        host: found.host,
        port: found.port
      })
    )
      return reply
    return guarded(reply, async () => {
      const check = await checkDatabase(found.id)
      await logActivity({
        action: 'hub-db-check',
        user: userId(req),
        collection: DATABASES,
        item: String(found.id),
        comment: `Check: ${check.state}`,
        req
      })
      const after = await getDatabase(found.id)
      const creation = after ? await resumeWaitingFor(after, req) : null
      return { data: check, creation }
    })
  })

  app.delete('/databases/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return notFound(reply)
    const b = body(req)
    if (b.drop !== undefined && typeof b.drop !== 'boolean')
      return dbFail(reply, 400, 'BAD_DROP', 'drop must be true or false')
    return guarded(reply, async () => {
      const before = await getDatabase(id)
      if (!before) return notFound(reply)
      const out = await deleteDatabase(id, { confirm: b.confirm, drop: b.drop === true })
      await logActivity({
        action: out.dropped ? 'hub-db-drop' : 'delete',
        user: userId(req),
        collection: DATABASES,
        item: String(id),
        comment: out.dropped
          ? `Dropped ${before.database_name} and its login on the server`
          : `Detached ${before.database_name} (the database stays on the server)`,
        req
      })
      return { data: { id, dropped: out.dropped } }
    })
  })
}

// ─── Targets ─────────────────────────────────────────────────────────────────

function targetRoutes(app: FastifyInstance) {
  app.get('/targets', { preHandler: requireAdmin }, async () => {
    return { data: (await listTargets()).map(publicTarget) }
  })

  app.post('/targets', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const checked = validateTargetInput(body(req))
      if (!checked.ok) return fail(reply, 400, checked.code, checked.message)
      const created = await createTarget(checked.row)
      await logActivity({
        action: 'create',
        user: userId(req),
        collection: TARGETS,
        item: String(created.id),
        req
      })
      return { data: publicTarget(created) }
    })
  )

  app.patch('/targets/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    const existing = id === null ? null : await getTargetRow(id)
    if (id === null || !existing) return notFound(reply)
    const b = body(req)
    return guarded(reply, async () => {
      const checked = validateTargetInput(b, existing)
      if (!checked.ok) return fail(reply, 400, checked.code, checked.message)
      const updated = await updateTarget(id, checked.row)
      if (!updated) return notFound(reply)
      await logActivity({
        action: 'update',
        user: userId(req),
        collection: TARGETS,
        item: String(id),
        req,
        // Field names only — never the token.
        changed_fields: fieldsOf(b, ['kind', 'name', 'config', 'secret'], ['secret'])
      })
      // Every app made on this target gets the target's CI path and project variables again
      // (fail closed per app, at most 20 s here; the rest `pending`, finished in the background).
      // The target is saved either way: a sync that cannot even start answers sync_error.
      try {
        // A rotated token also reaches each created app's driver copy (P3-32).
        const previousSecret =
          existing.secret && existing.secret !== updated.secret ? existing.secret : null
        return { data: publicTarget(updated), sync: await syncTargetApps(id, { previousSecret }) }
      } catch (err) {
        req.log.warn({ err: (err as Error | null)?.name ?? 'Error' }, 'hub target sync failed')
        return { data: publicTarget(updated), sync: null, sync_error: 'SYNC_READ_FAILED' }
      }
    })
  })

  app.delete('/targets/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return notFound(reply)
    const done = await deleteTarget(id)
    if (!done.ok)
      return done.code === 'IN_USE'
        ? fail(reply, 409, 'IN_USE', 'An app was created on this target')
        : notFound(reply)
    await logActivity({
      action: 'delete',
      user: userId(req),
      collection: TARGETS,
      item: String(id),
      req
    })
    return { data: { id } }
  })

  app.post('/targets/:id/test', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null || !(await getTargetRow(id))) return notFound(reply)
    return guarded(reply, async () => ({ data: await testTarget(id) }))
  })
}

// ─── Creation ────────────────────────────────────────────────────────────────

/** The environment `:envId` names when the caller may reach it (admins, its app's owners). */
async function readableEnvId(req: FastifyRequest): Promise<number | null> {
  const id = idOf(req, 'envId')
  if (id === null) return null
  const row = (await db(ENVS).where({ id }).first('id', 'app_id')) as
    | { id: number; app_id: number }
    | undefined
  if (!row) return null
  if (!req.isAdmin && !(await isAppOwner(Number(row.app_id), userId(req)))) return null
  return Number(row.id)
}

function creationRoutes(app: FastifyInstance) {
  // A read: gathers and plans, never locks or writes (exempt from the maintenance freeze).
  app.post('/apps/create/plan', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const input = body(req) as unknown as CreateAppInput
      return { data: buildCreationPlan(input, await gatherCreationFacts(input)) }
    })
  )

  app.post('/apps/create', { preHandler: requireAdmin }, async (req, reply) =>
    guarded(reply, async () => {
      const out = await startCreation(body(req) as unknown as CreateAppInput, { id: userId(req) })
      await logActivity({
        action: 'hub-create-start',
        user: userId(req),
        collection: APPS,
        item: String(out.app_id),
        comment: `Creating ${out.environments.map((e) => e.key).join(', ')}`,
        req
      })
      return reply.code(202).send({ data: out })
    })
  )

  app.get('/environments/:envId/creation', { preHandler: requireAuth }, async (req, reply) => {
    const envId = await readableEnvId(req)
    if (envId === null) return notFound(reply)
    const view = await readCreation(envId)
    if (!view) return notFound(reply)
    return { data: view }
  })

  app.post(
    '/environments/:envId/creation/retry',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const envId = await readableEnvId(req)
      if (envId === null) return notFound(reply)
      return guarded(reply, async () => {
        const out = await resumeCreation(envId, { id: userId(req) }, 'retry')
        await logActivity({
          action: 'hub-create-retry',
          user: userId(req),
          collection: ENVS,
          item: String(envId),
          req
        })
        return reply.code(202).send({ data: out })
      })
    }
  )

  app.post(
    '/environments/:envId/creation/check',
    { preHandler: requireAuth },
    async (req, reply) => {
      const envId = await readableEnvId(req)
      if (envId === null) return notFound(reply)
      return guarded(reply, async () => {
        const out = await resumeCreation(envId, { id: userId(req) }, 'check')
        await logActivity({
          action: 'hub-create-check',
          user: userId(req),
          collection: ENVS,
          item: String(envId),
          comment: `Check now: ${out.status}`,
          req
        })
        return { data: out }
      })
    }
  )

  // Ruling P3-22: the operator says the app's deploy key is installed on the swarm manager.
  app.post(
    '/environments/:envId/creation/installed',
    { preHandler: requireAuth },
    async (req, reply) => {
      const envId = await readableEnvId(req)
      if (envId === null) return notFound(reply)
      return guarded(reply, async () => {
        const out = await confirmOperatorInstalled(envId, { id: userId(req) })
        await logActivity({
          action: 'hub-create-installed',
          user: userId(req),
          collection: ENVS,
          item: String(envId),
          comment: 'Deploy key installed on the swarm manager',
          req
        })
        return reply.code(202).send({ data: out })
      })
    }
  )

  app.post(
    '/environments/:envId/creation/cancel',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const envId = await readableEnvId(req)
      if (envId === null) return notFound(reply)
      return guarded(reply, async () => {
        const res = await cancelCreation(envId, { id: userId(req) })
        if (!res.ok)
          return res.code === 'NOT_FOUND'
            ? notFound(reply)
            : fail(reply, 409, res.code, 'That creation is not running or waiting')
        await logActivity({
          action: 'hub-create-cancel',
          user: userId(req),
          collection: ENVS,
          item: String(envId),
          req
        })
        return reply.code(202).send({ data: { environment_id: envId } })
      })
    }
  )
}

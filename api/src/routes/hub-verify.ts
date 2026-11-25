import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from '../services/activity.js'
import { hubRequireAdmin, hubRequireAuth } from '../services/hub/api/gate.js'
import { idParam } from '../services/hub/apps.js'
import { OutsideWindowError, outsideWindowOf } from '../services/hub/changes/emergency.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import { flagOf, productionMap } from '../services/hub/owner-access.js'
import { readRule } from '../services/hub/releases/auto-rollback.js'
import { validateSuite } from '../services/hub/verify/checks.js'
import {
  ExtensionError,
  extensionMatrix,
  listExtensionPromotions,
  planExtensionPromote,
  promoteExtension,
  refreshSightings
} from '../services/hub/verify/extensions.js'
import { callVerify, verifyTarget } from '../services/hub/verify/link.js'
import {
  deleteSuite,
  executeRun,
  lastRuns,
  listRuns,
  listSuites,
  queueManualRun,
  readRun,
  readSuite,
  saveSuite
} from '../services/hub/verify/smoke.js'
import { extensionsTick, smokeTick } from '../services/hub/verify/tick.js'
import { appReadBudgetMs } from '../services/hub-link/verify-limits.js'

/**
 * Hub verification (mounted under /api/hub, hub mode only): post-deploy smoke checks per
 * environment and the extension version manager.
 *
 *   GET    /verify/smoke                             suites + last run per environment
 *   GET    /environments/:envId/smoke                the suite and its recent runs
 *   PUT    /environments/:envId/smoke                admin: save the suite
 *   DELETE /environments/:envId/smoke                admin: remove it
 *   POST   /environments/:envId/smoke/run            admin: run it now (202 {run_id})
 *   GET    /smoke-runs/:id                           one run with every check's result
 *   GET    /verify/extensions                        what each environment runs + who is behind
 *   POST   /verify/extensions/refresh                admin: read them now ({app_id?})
 *   POST   /environments/:envId/extensions/:extId/plan     admin: what a promote would do
 *   POST   /environments/:envId/extensions/:extId/promote  admin: promote one extension
 *
 * Reads: administrators see every app, an app's owners their own (an app or environment they do
 * not own answers 404). Every write is admin-only and logged.
 */

type Body = Record<string, unknown>

const body = (req: FastifyRequest): Body => {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

function fail(reply: FastifyReply, status: number, code: string, error: string, extra = {}) {
  return reply.code(status).send({ error, code, ...extra })
}

const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Not found')
const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

/** The apps the caller may read: null = every app (admin). */
async function readableAppIds(req: FastifyRequest): Promise<number[] | null> {
  if (req.isAdmin) return null
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: userId(req) })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

/** The environment `:envId` names when the caller may read it, else null (404). */
async function readableEnv(req: FastifyRequest): Promise<Record<string, unknown> | null> {
  const id = idParam((req.params as { envId?: string }).envId)
  if (id === null) return null
  const row = (await db('nivaro_hub_environments').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  const ids = await readableAppIds(req)
  if (ids && !ids.includes(Number(row.app_id))) return null
  return row
}

function refusal(reply: FastifyReply, err: unknown) {
  const e = err as {
    code?: unknown
    status?: unknown
    statusCode?: unknown
    message?: unknown
    blockers?: unknown
  } | null
  const status = Number(e?.status ?? e?.statusCode)
  if (e && typeof e.code === 'string' && Number.isInteger(status) && status >= 400 && status < 600)
    return fail(reply, status, e.code, String(e.message ?? e.code), {
      ...(Array.isArray(e.blockers) ? { blockers: e.blockers } : {})
    })
  throw err
}

export async function hubVerifyRoutes(app: FastifyInstance): Promise<void> {
  if (!hubModeEnabled()) return

  if (app.cron) {
    app.cron.schedule(
      'hub-verify-smoke',
      '* * * * *',
      async () => {
        const r = await smokeTick()
        if (r.errors.length) throw new Error(`hub-verify-smoke: ${r.errors.join('; ')}`)
      },
      {
        quiet: true,
        idempotent: 'unsafe',
        description:
          'Every minute (Hub only) — queues a post-deploy smoke run for each promotion, rollback, Apply now, move and shared upgrade that finished, runs the runs that are due (nivaro_hub_smoke_runs) and tells the app’s people when one fails. A missed tick is picked up by the next.'
      }
    )
    app.cron.schedule(
      'hub-verify-extensions',
      '*/30 * * * *',
      async () => {
        const r = await extensionsTick()
        if (r.errors.length) throw new Error(`hub-verify-extensions: ${r.errors.join('; ')}`)
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every 30 minutes (Hub only) — reads which extensions each environment runs over its link and what the Hub pins there (nivaro_hub_extension_sightings).'
      }
    )
  }

  // ─── Smoke checks ──────────────────────────────────────────────────────────

  app.get('/verify/smoke', { preHandler: hubRequireAuth }, async (req) => {
    const ids = await readableAppIds(req)
    const aq = db('nivaro_hub_apps').orderBy('key', 'asc').select('id', 'key', 'name')
    if (ids) aq.whereIn('id', ids.length ? ids : [-1])
    const apps = (await aq) as Array<{ id: number; key: string; name: string }>
    const envRows = apps.length
      ? ((await db('nivaro_hub_environments as e')
          .leftJoin('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
          .whereIn(
            'e.app_id',
            apps.map((a) => Number(a.id))
          )
          .orderBy('e.position', 'asc')
          .orderBy('e.id', 'asc')
          .select(
            'e.id',
            'e.app_id',
            'e.key',
            'e.position',
            'e.status',
            'e.production',
            'e.hub_token',
            'p.kind as placement_kind'
          )) as Array<Record<string, unknown>>)
      : []
    const prod = new Map<number, boolean>()
    for (const a of apps)
      for (const [k, v] of productionMap(
        envRows
          .filter((e) => Number(e.app_id) === Number(a.id))
          .map((e) => ({
            id: Number(e.id),
            key: String(e.key),
            position: Number(e.position ?? 0),
            status: e.status == null ? null : String(e.status),
            production: flagOf(e.production)
          }))
      ))
        prod.set(k, v)
    const live = envRows.filter((e) => e.status !== 'archived')
    const envIds = live.map((e) => Number(e.id))
    const [suites, last] = await Promise.all([listSuites(envIds), lastRuns(envIds)])
    return {
      data: {
        apps: apps.map((a) => ({ id: Number(a.id), key: String(a.key), name: String(a.name) })),
        environments: live.map((e) => ({
          id: Number(e.id),
          app_id: Number(e.app_id),
          key: String(e.key),
          position: Number(e.position ?? 0),
          production: prod.get(Number(e.id)) ?? true,
          on_shared: e.placement_kind === 'shared',
          linked: e.hub_token != null || e.placement_kind === 'shared'
        })),
        suites,
        last_runs: [...last.values()]
      }
    }
  })

  app.get('/environments/:envId/smoke', { preHandler: hubRequireAuth }, async (req, reply) => {
    const env = await readableEnv(req)
    if (!env) return notFound(reply)
    const envId = Number(env.id)
    const suite = await readSuite(envId)
    const rule = await readRule(envId).catch(() => null)
    const reads = (suite?.checks ?? []).filter((c) => c.kind !== 'http').length
    return {
      data: {
        suite,
        runs: await listRuns({ envIds: [envId], limit: 20 }),
        // The automatic rollback rule's window (null = no enabled rule) and the longest a run can
        // take, so the editor can warn when a run would finish after the window closed (L1).
        rollback_window_minutes: rule?.enabled ? rule.window_minutes : null,
        longest_run_seconds: suite
          ? suite.settle_seconds + Math.ceil(appReadBudgetMs(Math.max(1, reads)) / 1000) + 15
          : null
      }
    }
  })

  app.put('/environments/:envId/smoke', { preHandler: hubRequireAdmin }, async (req, reply) => {
    const env = await readableEnv(req)
    if (!env) return notFound(reply)
    const input = validateSuite(body(req))
    if ('error' in input) return fail(reply, 400, 'BAD_SUITE', input.error)
    // Saved queries: the app says each one may be a smoke query (one read, readable by the
    // smoke role) before the Hub keeps it; it judges them again on every run.
    const slugs = [
      ...new Set(input.checks.filter((c) => c.kind === 'query').map((c) => String(c.slug)))
    ]
    if (slugs.length) {
      const target = await verifyTarget(Number(env.id))
      const res = target ? await callVerify(target, 'queries', { slugs }) : null
      if (!res || res.state !== 'ok')
        return fail(
          reply,
          409,
          'SMOKE_QUERY_UNCHECKED',
          'The Hub could not ask the app whether these saved queries may be smoke checks (no link, or an app before 0.3.215). Save the suite without them, or fix the link first.'
        )
      const results = ((res.body as { results?: unknown } | null)?.results ?? []) as Array<{
        slug?: string
        code?: string | null
        reason?: string | null
      }>
      const bad = results.find((r) => r.code)
      if (bad || results.length !== slugs.length)
        return fail(
          reply,
          409,
          bad?.code ?? 'SMOKE_QUERY_UNCHECKED',
          bad
            ? `Saved query ${String(bad.slug).slice(0, 120)}: ${String(bad.reason ?? bad.code).slice(0, 300)}`
            : 'The app did not answer for every saved query'
        )
    }
    const saved = await saveSuite(Number(env.id), input, userId(req))
    await logActivity({
      action: 'hub-smoke-suite-save',
      user: userId(req),
      collection: 'nivaro_hub_smoke_suites',
      item: String(env.id),
      comment: `${env.key}: ${saved.checks.length} checks, on failure ${saved.on_fail}${
        saved.enabled ? '' : ' (off)'
      }`,
      req
    })
    return { data: saved }
  })

  app.delete('/environments/:envId/smoke', { preHandler: hubRequireAdmin }, async (req, reply) => {
    const env = await readableEnv(req)
    if (!env) return notFound(reply)
    if (!(await deleteSuite(Number(env.id)))) return notFound(reply)
    await logActivity({
      action: 'hub-smoke-suite-delete',
      user: userId(req),
      collection: 'nivaro_hub_smoke_suites',
      item: String(env.id),
      comment: String(env.key),
      req
    })
    return { data: { deleted: true } }
  })

  app.post(
    '/environments/:envId/smoke/run',
    { preHandler: hubRequireAdmin },
    async (req, reply) => {
      const env = await readableEnv(req)
      if (!env) return notFound(reply)
      try {
        const runId = await queueManualRun(Number(env.id), userId(req))
        await logActivity({
          action: 'hub-smoke-run',
          user: userId(req),
          collection: 'nivaro_hub_smoke_runs',
          item: String(runId),
          comment: `${env.key}: run by hand`,
          req
        })
        // Runs now in the background; the minute tick would pick it up as well (one claim wins).
        setImmediate(() => {
          void executeRun(runId).catch((err) =>
            req.log.warn({ err, runId }, 'hub smoke run failed to start')
          )
        })
        return reply.code(202).send({ data: { run_id: runId } })
      } catch (err) {
        return refusal(reply, err)
      }
    }
  )

  app.get('/smoke-runs/:id', { preHandler: hubRequireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const run = id === null ? null : await readRun(id)
    if (!run) return notFound(reply)
    const ids = await readableAppIds(req)
    if (ids && !ids.includes(run.app_id)) return notFound(reply)
    return { data: run }
  })

  // ─── Extensions ────────────────────────────────────────────────────────────

  app.get('/verify/extensions', { preHandler: hubRequireAuth }, async (req) => {
    const ids = await readableAppIds(req)
    const [matrix, promotions] = await Promise.all([
      extensionMatrix(ids),
      listExtensionPromotions({ appIds: ids ?? undefined, limit: 30 })
    ])
    return { data: { apps: matrix, promotions } }
  })

  // One app is read inside the request; every app in the background (202) — a fleet of links
  // and GitLab reads does not fit one request (L5).
  app.post('/verify/extensions/refresh', { preHandler: hubRequireAdmin }, async (req, reply) => {
    const appId = idParam(body(req).app_id)
    await logActivity({
      action: 'hub-extensions-refresh',
      user: userId(req),
      collection: 'nivaro_hub_extension_sightings',
      comment: appId === null ? 'every app' : `app #${appId}`,
      req
    })
    if (appId === null) {
      setImmediate(() => {
        void refreshSightings({}).catch((err) =>
          req.log.warn({ err }, 'hub extensions refresh failed')
        )
      })
      return reply.code(202).send({ data: { read: null, background: true } })
    }
    return { data: { read: await refreshSightings({ appIds: [appId] }), background: false } }
  })

  app.post(
    '/environments/:envId/extensions/:extId/plan',
    { preHandler: hubRequireAdmin },
    async (req, reply) => {
      const env = await readableEnv(req)
      if (!env) return notFound(reply)
      const b = body(req)
      let outside: { reason: string } | null
      try {
        outside = outsideWindowOf(req, b)
      } catch (e) {
        if (e instanceof OutsideWindowError) return fail(reply, e.status, e.code, e.message)
        throw e
      }
      try {
        const plan = await planExtensionPromote(
          Number(env.id),
          String((req.params as { extId: string }).extId),
          {
            from_env_id: idParam(b.from_env_id),
            pin: typeof b.pin === 'string' ? b.pin : null,
            outsideWindow: outside
          }
        )
        return { data: plan }
      } catch (err) {
        if (err instanceof ExtensionError) return fail(reply, err.status, err.code, err.message)
        return refusal(reply, err)
      }
    }
  )

  app.post(
    '/environments/:envId/extensions/:extId/promote',
    { preHandler: hubRequireAdmin },
    async (req, reply) => {
      const env = await readableEnv(req)
      if (!env) return notFound(reply)
      const b = body(req)
      // An administrator's emergency start outside the deploy window (own session only,
      // services/hub/changes/emergency.ts): freezes and the checklist still apply.
      let outside: { reason: string } | null
      try {
        outside = outsideWindowOf(req, b)
      } catch (e) {
        if (e instanceof OutsideWindowError) return fail(reply, e.status, e.code, e.message)
        throw e
      }
      try {
        const out = await promoteExtension(
          Number(env.id),
          String((req.params as { extId: string }).extId),
          {
            from_env_id: idParam(b.from_env_id),
            pin: typeof b.pin === 'string' ? b.pin : null,
            confirm: b.confirm,
            checklist_run_id: b.checklist_run_id,
            outsideWindow: outside
          },
          { id: userId(req) },
          { req }
        )
        return reply.code(202).send({ data: out })
      } catch (err) {
        if (err instanceof ExtensionError)
          return fail(reply, err.status, err.code, err.message, {
            ...(Array.isArray((err as { blockers?: unknown }).blockers)
              ? { blockers: (err as { blockers?: unknown }).blockers }
              : {})
          })
        return refusal(reply, err)
      }
    }
  )
}

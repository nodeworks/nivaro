import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam } from '../services/hub/apps.js'
import {
  AskError,
  askHub,
  connectAskTools,
  parseConversation
} from '../services/hub/insight/ask.js'
import { pruneInsight, runCollect } from '../services/hub/insight/collect.js'
import {
  buildDigest,
  digestEnabledFor,
  runWeeklyDigest,
  setDigestEnabled
} from '../services/hub/insight/digest.js'
import { currentHealth, storeDailyScores } from '../services/hub/insight/health.js'
import {
  COLLECT_LOCK_KEY,
  COLLECT_LOCK_TTL_MS,
  collectRunning,
  HEALTH_CACHE_TTL_S,
  healthCacheKey,
  type InsightRedis,
  readCollectState,
  withInsightLock,
  writeCollectState
} from '../services/hub/insight/lock.js'
import {
  HEALTH_PARTS,
  loadInsightSettings,
  normalizeInsightSettings,
  saveInsightSettings
} from '../services/hub/insight/settings.js'
import { dependencyMap, impactOf, mayReadApp, usageView } from '../services/hub/insight/views.js'
import { hubModeEnabled } from '../services/hub/mode.js'

/**
 * Nivaro Hub insight (enhancements 36–40) — mounted at /api/hub beside routes/hub.ts, only with
 * HUB=on (never in cloud mode). Every route is behind the Hub credential gate (routes/index.ts
 * installHubCredentialGate swaps requireAuth / requireAdmin for the Hub's own).
 *
 *   GET  /insight/health?app=          health score per environment (admins: all; owners: their
 *                                      apps), parts and the 30-day trend; kept 60 s per viewer
 *   GET  /insight/usage?app=&days=     usage counts per environment (people per day / week,
 *                                      adoption, busiest screens) — counts only, privacy floor
 *   GET  /insight/dependencies?app=    the dependency map: nodes, edges, uses
 *   GET  /insight/impact?node=         who depends on one node (production first)
 *   GET  /insight/settings             weights, privacy floor, digest switch (admin)
 *   PUT  /insight/settings             the same, validated (admin, logged)
 *   POST /insight/collect              reads every environment's usage + dependencies now (admin,
 *                                      logged): 202 {status: running}; 409 COLLECT_RUNNING
 *   GET  /insight/collect              the last Collect now's state (admin)
 *   GET  /insight/digest/me            the caller's weekly digest switch
 *   PUT  /insight/digest/me            {enabled} — the caller's own switch (logged)
 *   GET  /insight/digest/preview       the caller's digest as it would go out now
 *   POST /insight/ask                  Ask the Hub: {messages | question} → answer + citations;
 *                                      read-only tools that re-enter as the caller
 *
 * Jobs (Hub only, one leader through the cron lease, ticking only where cronTicksEnabled()):
 * hub-insight-collect (05:10 UTC daily), hub-insight-health (hourly :25), hub-insight-digest
 * (Mondays 12:00 UTC, 48 h catch-up).
 */

type Q = Record<string, string | undefined>

function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')
const viewer = (req: FastifyRequest) => ({ userId: userId(req), isAdmin: req.isAdmin === true })
const query = (req: FastifyRequest) => (req.query ?? {}) as Q

function redisOf(app: FastifyInstance): InsightRedis | null {
  return (app as unknown as { redis?: InsightRedis }).redis ?? null
}

/** `?app=` as an app the caller may read: undefined = none given, null = refused (404). */
async function appFilter(req: FastifyRequest): Promise<number | undefined | null> {
  const raw = query(req).app
  if (raw === undefined || raw === '') return undefined
  const id = idParam(raw)
  if (id === null) return null
  return (await mayReadApp(viewer(req), id)) ? id : null
}

export async function hubInsightRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  app.get('/insight/health', { preHandler: requireAuth }, async (req, reply) => {
    const appId = await appFilter(req)
    if (appId === null) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const redis = redisOf(app)
    const who = viewer(req)
    const key = healthCacheKey(who)
    let all: Awaited<ReturnType<typeof currentHealth>> | null = null
    if (redis) {
      try {
        const raw = await redis.get(key)
        all = raw ? JSON.parse(raw) : null
      } catch {
        all = null
      }
    }
    if (!all) {
      all = await currentHealth(who)
      if (redis)
        await Promise.resolve(redis.set(key, JSON.stringify(all), 'EX', HEALTH_CACHE_TTL_S)).catch(
          () => {}
        )
    }
    const settings = await loadInsightSettings()
    return {
      data: {
        weights: settings.weights,
        parts: HEALTH_PARTS,
        environments: appId === undefined ? all : all.filter((h) => h.app_id === appId)
      }
    }
  })

  app.get('/insight/usage', { preHandler: requireAuth }, async (req, reply) => {
    const appId = await appFilter(req)
    if (appId === null) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    const daysRaw = Number(query(req).days)
    const days = Number.isFinite(daysRaw) ? Math.round(daysRaw) : undefined
    return { data: await usageView(viewer(req), { appId, days }) }
  })

  app.get('/insight/dependencies', { preHandler: requireAuth }, async (req, reply) => {
    const appId = await appFilter(req)
    if (appId === null) return fail(reply, 404, 'NOT_FOUND', 'Not found')
    return { data: await dependencyMap(viewer(req), { appId }) }
  })

  app.get('/insight/impact', { preHandler: requireAuth }, async (req, reply) => {
    const node = String(query(req).node ?? '').trim()
    if (!node || node.length > 300) return fail(reply, 400, 'BAD_NODE', 'node is required')
    return { data: await impactOf(viewer(req), node) }
  })

  app.get('/insight/settings', { preHandler: requireAdmin }, async () => ({
    data: await loadInsightSettings()
  }))

  app.put('/insight/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const before = await loadInsightSettings()
    const out = normalizeInsightSettings(req.body, before)
    if (!out.ok) return fail(reply, 400, 'BAD_SETTINGS', out.error)
    await saveInsightSettings(out.settings)
    await Promise.resolve(redisOf(app)?.del?.(healthCacheKey({ userId: '', isAdmin: true }))).catch(
      () => {}
    )
    await logActivity({
      action: 'hub-insight-settings',
      user: userId(req),
      comment: JSON.stringify({
        weights: out.settings.weights,
        floor: out.settings.usage.floor,
        days: out.settings.usage.days,
        digest: out.settings.digest.enabled
      }),
      req
    })
    return { data: out.settings }
  })

  app.post('/insight/collect', { preHandler: requireAdmin }, async (req, reply) => {
    const redis = redisOf(app)
    if (await collectRunning(redis))
      return fail(reply, 409, 'COLLECT_RUNNING', 'A collect is already running. Try again soon.')
    const started_at = new Date().toISOString()
    await writeCollectState(redis, { status: 'running', started_at })
    await logActivity({ action: 'hub-insight-collect', user: userId(req), req })
    void withInsightLock(redis, COLLECT_LOCK_KEY, COLLECT_LOCK_TTL_MS, () => runCollect())
      .then(async (out) => {
        await writeCollectState(redis, {
          status: out.ran ? 'done' : 'failed',
          started_at,
          finished_at: new Date().toISOString(),
          summary: out.ran ? { ...out.value } : { busy: true }
        })
        await Promise.resolve(redis?.del?.(healthCacheKey({ userId: '', isAdmin: true }))).catch(
          () => {}
        )
      })
      .catch(async (err) => {
        app.log.warn(
          { code: (err as { code?: unknown } | null)?.code ?? null },
          'insight collect failed'
        )
        await writeCollectState(redis, {
          status: 'failed',
          started_at,
          finished_at: new Date().toISOString()
        })
      })
    return reply.code(202).send({ data: { status: 'running', started_at } })
  })

  app.get('/insight/collect', { preHandler: requireAdmin }, async () => ({
    data: (await readCollectState(redisOf(app))) ?? { status: 'none' }
  }))

  app.get('/insight/digest/me', { preHandler: requireAuth }, async (req) => {
    const settings = await loadInsightSettings()
    const digest = await buildDigest(userId(req)).catch(() => null)
    return {
      data: {
        enabled: await digestEnabledFor(userId(req)),
        delivered: settings.digest.enabled,
        owns_apps: !!digest
      }
    }
  })

  app.put('/insight/digest/me', { preHandler: requireAuth }, async (req, reply) => {
    const enabled = (req.body as { enabled?: unknown } | null)?.enabled
    if (typeof enabled !== 'boolean')
      return fail(reply, 400, 'BAD_BODY', 'enabled must be true or false')
    await setDigestEnabled(userId(req), enabled)
    await logActivity({
      action: 'hub-digest-pref',
      user: userId(req),
      comment: JSON.stringify({ enabled }),
      req
    })
    return { data: { enabled } }
  })

  app.get('/insight/digest/preview', { preHandler: requireAuth }, async (req) => {
    let adminBase = ''
    try {
      adminBase = (await import('../admin-base.js')).adminBaseUrl() ?? ''
    } catch {
      adminBase = ''
    }
    // Only the caller's own digest (their own apps); null when they own none.
    return { data: await buildDigest(userId(req), new Date(), { adminBase: () => adminBase }) }
  })

  app.post('/insight/ask', { preHandler: requireAuth }, async (req, reply) => {
    // An assistant calling Ask the Hub would start a second AI loop inside its own: refused.
    if (req.mcpInner === true)
      return fail(reply, 403, 'ASK_NOT_FOR_AGENTS', 'Ask the Hub is for people, not assistants.')
    const turns = parseConversation(req.body)
    if (!turns)
      return fail(
        reply,
        400,
        'BAD_QUESTION',
        'Send {question} or {messages: [{role, content}]} ending with your question (at most 20 turns of 4,000 characters).'
      )
    let adminBase = ''
    try {
      adminBase = (await import('../admin-base.js')).adminBaseUrl() ?? ''
    } catch {
      adminBase = ''
    }
    try {
      const out = await askHub(turns, {
        adminBase,
        connect: () => connectAskTools(app, req, [], adminBase)
      })
      return {
        data: {
          answer: out.answer,
          citations: out.citations,
          tools: out.tools,
          partial: out.partial
        }
      }
    } catch (err) {
      if (err instanceof AskError) return fail(reply, err.statusCode, err.code, err.message)
      const e = err as { statusCode?: number; code?: string; message?: string }
      if (e.statusCode === 429 || e.statusCode === 503)
        return fail(
          reply,
          e.statusCode,
          String(e.code ?? 'AI_UNAVAILABLE'),
          String(e.message ?? '')
        )
      req.log.warn({ code: e.code ?? null }, 'ask the hub failed')
      return fail(reply, 502, 'ASK_FAILED', 'The Hub could not answer that right now. Try again.')
    }
  })

  if (app.cron) {
    app.cron.schedule(
      'hub-insight-collect',
      '10 5 * * *',
      async () => {
        const out = await withInsightLock(redisOf(app), COLLECT_LOCK_KEY, COLLECT_LOCK_TTL_MS, () =>
          runCollect()
        )
        await pruneInsight(new Date())
        if (out.ran)
          app.log.info(
            `hub-insight-collect: ${out.value.environments} environments, usage ${out.value.usage_ok}, dependencies ${out.value.deps_ok}, ${out.value.skipped} skipped`
          )
      },
      {
        idempotent: 'safe',
        timezone: 'UTC',
        description:
          'Daily 05:10 UTC (Hub only) — reads every active environment’s usage counts (people per day, busiest screens; nothing under the privacy floor of at least 5 people ever leaves the app) and the hosts and extensions it depends on, over the hub link or the shared deployment’s link, into the Hub’s insight tables; at most 4 at once, 10 s per read, 20 minutes in all. Drops usage days older than 400 days and rows of environments that are gone. One run at a time (shared with Collect now).'
      }
    )
    app.cron.schedule(
      'hub-insight-health',
      '25 * * * *',
      async () => {
        const n = await storeDailyScores()
        await Promise.resolve(
          redisOf(app)?.del?.(healthCacheKey({ userId: '', isAdmin: true }))
        ).catch(() => {})
        app.log.info(`hub-insight-health: ${n} environments scored`)
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Hourly at :25 (Hub only) — works out every environment’s health score (0–100) from figures the Hub already keeps (uptime, error rate, drift alerts, open issues, readiness, backup age, secret age; weights in Apps → Health) and stores it under today’s UTC day for the trend (the day’s last run wins). Days older than 400 are dropped.'
      }
    )
    app.cron.schedule(
      'hub-insight-digest',
      '0 12 * * 1',
      async () => {
        const out = await runWeeklyDigest()
        app.log.info(
          `hub-insight-digest ${out.week}: ${out.owners} owners, ${out.sent} sent, ${out.skipped} skipped, ${out.failed} failed`
        )
      },
      {
        idempotent: 'safe',
        timezone: 'UTC',
        catchUpHours: 48,
        description:
          'Mondays 12:00 UTC (Hub only; a missed run is caught up within 48 hours) — sends every app owner one email about their apps: last week’s deploys, incidents, open drift alerts and health against a week ago, and the next 14 days’ scheduled promotes and freeze windows. Never twice for a week; off for anyone who turned it off in Apps → Health, and for everyone when the digest is switched off in the insight settings.'
      }
    )
  }
}

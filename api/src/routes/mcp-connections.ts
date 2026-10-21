import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  AgentUndoError,
  listConnections,
  readAgentActivity,
  undoAgentWrite
} from '../services/mcp-activity.js'
import { CONN_RE, readMcpSettings, writeMcpSettings } from '../services/mcp-calls.js'
import { idleDecision, runIdleReview } from '../services/mcp-idle-review.js'
import { getGrant, listGrants, revokeGrant } from '../services/oauth-store.js'
import { bumpUserAccessVersion } from '../services/permission-cache.js'

/**
 * MCP connections (#2466 / #2469 / #2497 / #2498), under /api/mcp-connections.
 *
 *   GET    /mine                         the person's connections + 14-day tool-call stats
 *   GET    /mine/activity                their agents' tool calls (?conn=&before=&limit=)
 *   POST   /mine/activity/:activityId/undo   undo one write an agent made, as the person
 *   DELETE /mine/:conn                   disconnect one of their OAuth connections
 *   GET    /                             admin: everyone's connections + stats + idle state
 *   GET    /idle                         admin: connections the idle review has flagged or will
 *   DELETE /:conn                        admin: disconnect anyone's connection (OAuth or key)
 *   PATCH  /:conn/limit                  admin: {rate_limit_per_minute: n | null}
 *   GET    /settings  PATCH /settings    admin: idle review days + default rate limit
 *   POST   /idle-review/run              admin: {dry_run?} run the review now
 *
 * A connected app's own token can never reach these (OAUTH_NO_WRITE, services/mcp-config.ts):
 * an agent cannot undo, revoke or re-limit itself.
 */

const sendUndoError = (reply: FastifyReply, err: unknown) => {
  if (err instanceof AgentUndoError) return reply.code(err.statusCode).send({ error: err.message })
  const e = err as { statusCode?: number; message?: string; code?: string }
  if (e?.statusCode && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: e.message ?? 'Refused', code: e.code })
  throw err
}

const publicSettings = async () => {
  const s = await readMcpSettings()
  return {
    idle_flag_days: s.idle_flag_days,
    idle_revoke_days: s.idle_revoke_days,
    rate_limit_per_minute: s.rate_limit_per_minute
  }
}

export async function mcpConnectionRoutes(app: FastifyInstance) {
  // ── The person's own ──────────────────────────────────────────────────────
  app.get('/mine', { preHandler: requireAuth }, async (req) => {
    const settings = await readMcpSettings()
    const { logged, connections } = await listConnections(app.redis, settings, {
      userId: String(req.user!.id)
    })
    return { data: { logged, window_days: 14, settings: await publicSettings(), connections } }
  })

  app.get<{ Querystring: { conn?: string; before?: string; limit?: string } }>(
    '/mine/activity',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { conn, before, limit } = req.query
      if (conn && !CONN_RE.test(conn)) return reply.code(400).send({ error: 'conn is not valid' })
      if (before && Number.isNaN(Date.parse(before)))
        return reply.code(400).send({ error: 'before must be a timestamp' })
      const userId = String(req.user!.id)
      // The apps' registered names (the log keeps a caller-key slug of each).
      const grants = await listGrants(app.redis, userId)
      const names = new Map(grants.map((g) => [`o${g.id.toLowerCase()}`, g.client_name]))
      const page = await readAgentActivity(userId, {
        conn: conn ?? null,
        before: before ?? null,
        limit: limit ? Number(limit) : 50,
        names
      })
      return { data: page }
    }
  )

  app.post<{ Params: { activityId: string } }>(
    '/mine/activity/:activityId/undo',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number(req.params.activityId)
      if (!Number.isInteger(id) || id <= 0)
        return reply.code(400).send({ error: 'activityId is not valid' })
      try {
        return { data: await undoAgentWrite(req.user!, id, req) }
      } catch (err) {
        return sendUndoError(reply, err)
      }
    }
  )

  app.delete<{ Params: { conn: string } }>(
    '/mine/:conn',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { conn } = req.params
      if (!CONN_RE.test(conn)) return reply.code(400).send({ error: 'conn is not valid' })
      if (!conn.startsWith('o'))
        return reply.code(400).send({
          error: 'API keys and personal tokens are managed by an administrator'
        })
      const ok = await revokeGrant(app.redis, String(req.user!.id), conn.slice(1))
      if (!ok) return reply.code(404).send({ error: 'Connection not found' })
      await logActivity({ action: 'oauth-revoke', user: req.user!.id, comment: conn.slice(1), req })
      return { data: { revoked: true } }
    }
  )

  // ── Administrators ────────────────────────────────────────────────────────
  app.get('/', { preHandler: requireAdmin }, async () => {
    const settings = await readMcpSettings()
    const { logged, connections } = await listConnections(app.redis, settings)
    return { data: { logged, window_days: 14, settings: await publicSettings(), connections } }
  })

  app.get('/idle', { preHandler: requireAdmin }, async () => {
    const settings = await readMcpSettings()
    const { connections } = await listConnections(app.redis, settings)
    const now = Date.now()
    const idle = connections
      .filter((c) => c.kind === 'oauth' && c.idle && c.idle.idle_days >= settings.idle_flag_days)
      .map((c) => ({
        ...c,
        stats: undefined,
        next_step: idleDecision(
          {
            last_used_at: c.last_used_at,
            created_at: c.created_at ?? new Date(now).toISOString(),
            idle_flagged_at: c.idle?.flagged_at,
            idle_notice_at: c.idle?.notice_at
          },
          settings,
          now
        )
      }))
      .sort((a, b) => (b.idle?.idle_days ?? 0) - (a.idle?.idle_days ?? 0))
    return { data: { settings: await publicSettings(), connections: idle } }
  })

  app.get('/settings', { preHandler: requireAdmin }, async () => ({
    data: await readMcpSettings()
  }))

  app.patch('/settings', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const next = await writeMcpSettings(req.body)
      if (next === false)
        return reply.code(409).send({ error: 'MCP settings need migration 480 on this database' })
      await logActivity({ action: 'mcp-settings', user: req.user!.id, req })
      return { data: next }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.patch<{ Params: { conn: string }; Body: { rate_limit_per_minute?: number | null } }>(
    '/:conn/limit',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { conn } = req.params
      if (!CONN_RE.test(conn)) return reply.code(400).send({ error: 'conn is not valid' })
      const v = req.body?.rate_limit_per_minute
      try {
        const next = await writeMcpSettings({ connection_limits: { [conn]: v ?? null } })
        if (next === false)
          return reply.code(409).send({ error: 'MCP settings need migration 480 on this database' })
        await logActivity({
          action: 'mcp-connection-limit',
          user: req.user!.id,
          comment: `${conn}: ${v ?? 'default'}`,
          req
        })
        return { data: { conn, rate_limit_per_minute: next.connection_limits[conn] ?? null } }
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message })
      }
    }
  )

  app.delete<{ Params: { conn: string } }>(
    '/:conn',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { conn } = req.params
      if (!CONN_RE.test(conn)) return reply.code(400).send({ error: 'conn is not valid' })
      if (conn.startsWith('o')) {
        const g = await getGrant(app.redis, conn.slice(1))
        if (!g || !(await revokeGrant(app.redis, g.user_id, g.id)))
          return reply.code(404).send({ error: 'Connection not found' })
        await logActivity({
          action: 'oauth-revoke',
          user: req.user!.id,
          comment: `${g.id} (${g.client_name}) of ${g.user_id}`,
          req
        })
        return { data: { revoked: true } }
      }
      if (conn.startsWith('k')) {
        const id = Number(conn.slice(1))
        const key = (await db('nivaro_api_keys').where({ id }).first('id', 'user')) as
          | { id: number; user: string }
          | undefined
        if (!key) return reply.code(404).send({ error: 'API key not found' })
        await db('nivaro_api_keys').where({ id }).update({ is_active: false })
        bumpUserAccessVersion(key.user)
        await logActivity({ action: 'api_key_revoked', user: req.user!.id, req })
        return { data: { revoked: true } }
      }
      return reply
        .code(400)
        .send({ error: 'A personal token is changed from that person’s Security settings' })
    }
  )

  app.post<{ Body: { dry_run?: boolean } }>(
    '/idle-review/run',
    { preHandler: requireAdmin },
    async (req) => ({ data: await runIdleReview(app, { dryRun: req.body?.dry_run !== false }) })
  )
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  AgentUndoError,
  listConnections,
  readAgentActivity,
  undoAgentWrite
} from '../services/mcp-activity.js'
import {
  AGENT_NAME_MAX,
  agentDisplayName,
  CONN_RE,
  cleanAgentName,
  readMcpSettings,
  writeMcpSettings
} from '../services/mcp-calls.js'
import { idleDecision, runIdleReview } from '../services/mcp-idle-review.js'
import { deleteScope, scopedKeysNotListed, withScopes } from '../services/mcp-scope.js'
import { getGrant, listGrants, revokeGrant } from '../services/oauth-store.js'
import { bumpUserAccessVersion } from '../services/permission-cache.js'

/**
 * MCP connections (#2466 / #2469 / #2497 / #2498), under /api/mcp-connections.
 *
 *   GET    /mine                         the person's connections + 14-day tool-call stats
 *   GET    /mine/activity                their agents' tool calls (?conn=&before=&limit=)
 *   POST   /mine/activity/:activityId/undo   undo one write an agent made, as the person
 *   DELETE /mine/:conn                   disconnect one of their OAuth connections
 *   PATCH  /mine/:conn/name              {name | null} the name their agent goes by (rt8 #21)
 *   GET    /                             admin: everyone's connections + stats + idle state
 *   GET    /idle                         admin: connections the idle review has flagged or will
 *   DELETE /:conn                        admin: disconnect anyone's connection (OAuth or key)
 *   PATCH  /:conn/limit                  admin: {rate_limit_per_minute: n | null}
 *   PATCH  /:conn/name                   admin: {name | null} anyone's agent name (rt8 #21)
 *   GET    /settings  PATCH /settings    admin: idle review days + default rate limit
 *   POST   /idle-review/run              admin: {dry_run?} run the review now
 *
 * Every listed connection carries `scope` (#3205 limits, #3214 kit; null = none) and
 * `scope_editable`; the scope and kit routes are in routes/mcp-scopes.ts.
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

/** Who a connection belongs to (the person its calls act as), or null when it is not there. */
async function connectionOwner(app: FastifyInstance, conn: string): Promise<string | null> {
  if (conn.startsWith('o')) {
    const g = await getGrant(app.redis, conn.slice(1), 'mcp')
    return g ? String(g.user_id) : null
  }
  if (conn.startsWith('k')) {
    const key = (await db('nivaro_api_keys')
      .where({ id: Number(conn.slice(1)) })
      .first('user')) as { user: string } | undefined
    return key ? String(key.user) : null
  }
  return conn.slice(1)
}

/**
 * rt8 #21 — set or clear the name an agent goes by. `name` null / '' = back to the app's own.
 * Plain text, ≤ 40 characters; shown as text everywhere (presence, badges, notifications).
 */
async function setConnectionName(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  conn: string,
  admin: boolean
) {
  if (!CONN_RE.test(conn)) return reply.code(400).send({ error: 'conn is not valid' })
  const raw = (req.body as { name?: unknown } | null)?.name
  if (raw !== null && raw !== undefined && typeof raw !== 'string')
    return reply.code(400).send({ error: 'name must be text' })
  if (typeof raw === 'string' && raw.length > 200)
    return reply.code(400).send({ error: `A name is at most ${AGENT_NAME_MAX} characters` })
  const name = typeof raw === 'string' && raw.trim() ? cleanAgentName(raw) : null
  if (typeof raw === 'string' && raw.trim() && !name)
    return reply.code(400).send({ error: 'A name needs at least one letter or digit' })
  const owner = await connectionOwner(app, conn).catch(() => null)
  const me = String(req.user!.id).toLowerCase()
  // Not found and not theirs answer alike: a person cannot probe other people's connections.
  if (!owner || (!admin && owner.toLowerCase() !== me))
    return reply.code(404).send({ error: 'Connection not found' })
  // Never a person's name or a system word (shown beside writes, presence, notifications).
  if (name) {
    const { agentNameRefusal } = await import('../services/agent-name-guard.js')
    const why = await agentNameRefusal(name)
    if (why) return reply.code(400).send({ error: why, code: 'AGENT_NAME_REFUSED' })
  }
  let next: Awaited<ReturnType<typeof writeMcpSettings>>
  try {
    next = await writeMcpSettings({ connection_names: { [conn]: name } })
  } catch (err) {
    return reply.code(409).send({ error: (err as Error).message })
  }
  if (next === false)
    return reply.code(409).send({ error: 'MCP settings need migration 480 on this database' })
  await logActivity({
    action: 'mcp-connection-name',
    user: req.user!.id,
    comment: `${conn}: ${name ?? '(app name)'}`.slice(0, 200),
    req
  })
  return {
    data: {
      conn,
      // null = it goes by its app's own name again (the listing names it).
      custom_name: next.connection_names[conn] ?? null
    }
  }
}

export async function mcpConnectionRoutes(app: FastifyInstance) {
  // ── The person's own ──────────────────────────────────────────────────────
  app.get('/mine', { preHandler: requireAuth }, async (req) => {
    const settings = await readMcpSettings()
    const { logged, connections } = await listConnections(app.redis, settings, {
      userId: String(req.user!.id)
    })
    return {
      data: {
        logged,
        window_days: 14,
        settings: await publicSettings(),
        connections: await withScopes(connections, { admin: false })
      }
    }
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
      const [grants, settings] = await Promise.all([
        listGrants(app.redis, userId, 'mcp'),
        readMcpSettings()
      ])
      // rt8 #21 — each by the name it goes by.
      const names = new Map(
        grants.map((g) => {
          const conn = `o${g.id.toLowerCase()}`
          return [conn, agentDisplayName(conn, g.client_name, settings)]
        })
      )
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
      const ok = await revokeGrant(app.redis, String(req.user!.id), conn.slice(1), 'mcp')
      if (!ok) return reply.code(404).send({ error: 'Connection not found' })
      await deleteScope(conn).catch(() => false)
      await logActivity({ action: 'oauth-revoke', user: req.user!.id, comment: conn.slice(1), req })
      return { data: { revoked: true } }
    }
  )

  app.patch<{ Params: { conn: string }; Body: { name?: string | null } }>(
    '/mine/:conn/name',
    { preHandler: requireAuth },
    (req, reply) => setConnectionName(app, req, reply, req.params.conn, false)
  )

  // ── Administrators ────────────────────────────────────────────────────────
  app.get('/', { preHandler: requireAdmin }, async () => {
    const settings = await readMcpSettings()
    const { logged, connections } = await listConnections(app.redis, settings)
    // #3205 — an API key limited ahead of use shows even before its first MCP call.
    const extra = await scopedKeysNotListed(new Set(connections.map((c) => c.conn)))
    const all = [
      ...connections,
      ...extra.map(({ scope: _s, ...k }) => ({
        ...k,
        kind: 'api_key' as const,
        rate_limit_per_minute: settings.connection_limits[k.conn] ?? settings.rate_limit_per_minute,
        rate_limit_custom: settings.connection_limits[k.conn] !== undefined,
        custom_name: settings.connection_names?.[k.conn] ?? null,
        display_name: agentDisplayName(k.conn, k.name, settings),
        idle: null,
        stats: null
      }))
    ]
    return {
      data: {
        logged,
        window_days: 14,
        settings: await publicSettings(),
        connections: await withScopes(all, { admin: true })
      }
    }
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
    // The same name rule as PATCH …/:conn/name for names set here in bulk.
    const names = (req.body as { connection_names?: unknown } | null)?.connection_names
    if (names && typeof names === 'object' && !Array.isArray(names)) {
      const { agentNameRefusal } = await import('../services/agent-name-guard.js')
      for (const v of Object.values(names as Record<string, unknown>)) {
        const name = typeof v === 'string' ? cleanAgentName(v) : ''
        if (!name) continue
        const why = await agentNameRefusal(name)
        if (why) return reply.code(400).send({ error: why, code: 'AGENT_NAME_REFUSED' })
      }
    }
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

  app.patch<{ Params: { conn: string }; Body: { name?: string | null } }>(
    '/:conn/name',
    { preHandler: requireAdmin },
    (req, reply) => setConnectionName(app, req, reply, req.params.conn, true)
  )

  app.delete<{ Params: { conn: string } }>(
    '/:conn',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { conn } = req.params
      if (!CONN_RE.test(conn)) return reply.code(400).send({ error: 'conn is not valid' })
      if (conn.startsWith('o')) {
        const g = await getGrant(app.redis, conn.slice(1), 'mcp')
        if (!g || !(await revokeGrant(app.redis, g.user_id, g.id, 'mcp')))
          return reply.code(404).send({ error: 'Connection not found' })
        await deleteScope(conn).catch(() => false)
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

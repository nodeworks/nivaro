import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  deleteKit,
  isBuiltinKit,
  KIT_KEY_RE,
  kitMap,
  kitsReady,
  listKits,
  MAX_KITS,
  normalizeKit,
  SCOPE_ACTIONS,
  saveKit,
  storedKitCount
} from '../services/mcp-kits.js'
import {
  deleteScope,
  effectiveScope,
  kitUseCount,
  normalizeScopePatch,
  readScopeRow,
  SCOPABLE_CONN_RE,
  scopesReady,
  writeScope
} from '../services/mcp-scope.js'
import { toolCatalogFor } from '../services/mcp-tool-catalog.js'
import { getGrant } from '../services/oauth-store.js'

/**
 * Per-connection scope (#3205) and role tool kits (#3214), beside the connection routes under
 * /api/mcp-connections (routes/mcp-connections.ts):
 *
 *   GET    /catalog                tools a connection could be given + kits + actions (signed in)
 *   GET    /kits                   every kit (built-in + stored); admins also get use counts
 *   POST   /kits  PUT /kits/:key   admin: add / change a stored kit
 *   DELETE /kits/:key              admin: remove a stored kit (409 while a connection uses it)
 *   PUT    /mine/:conn/scope       the person's own OAuth connection: {kit, tools, collections,
 *                                  actions}; refused once an administrator has locked it
 *   DELETE /mine/:conn/scope       …back to "everything you can do"
 *   PUT    /:conn/scope            admin: any OAuth connection or API key, + {locked, note}
 *   DELETE /:conn/scope            admin
 *
 * Every write here only narrows (services/mcp-scope.ts intersects it with the credential). A
 * connected app can never reach these writes (OAUTH_NO_WRITE), nor a View-as or run-as token
 * (DELEGATED_NO_WRITE); a person changes their own only when signed in as themselves.
 */

const notReady = (reply: FastifyReply) =>
  reply.code(409).send({
    error: 'Connection limits need database migration 509 — they work once it has run',
    code: 'MCP_SCOPE_NOT_READY'
  })

/** The person signed in as themselves (a session or their own token), never a key or an app. */
const asThemselves = (req: FastifyRequest) =>
  req.authMethod === 'session' || req.authMethod === 'token'

/** Who owns a connection, or null when it does not exist (here, on this tenant). */
async function ownerOf(app: FastifyInstance, conn: string): Promise<string | null> {
  if (conn.startsWith('o')) {
    const g = await getGrant(app.redis, conn.slice(1))
    return g ? String(g.user_id) : null
  }
  const key = (await db('nivaro_api_keys')
    .where({ id: Number(conn.slice(1)) })
    .first('id', 'user')) as { id: number; user: string } | undefined
  return key ? String(key.user) : null
}

/** A posted scope, cleaned, with its kit checked against the kits there are. */
async function readPatch(body: unknown, admin: boolean) {
  const n = normalizeScopePatch(body)
  if ('error' in n) return n
  if (n.patch.kit) {
    if (!KIT_KEY_RE.test(n.patch.kit)) return { error: 'That kit does not exist' }
    const kits = await listKits()
    if (!kits.some((k) => k.key === n.patch.kit)) return { error: 'That kit does not exist' }
  }
  if (n.patch.actions && !n.patch.actions.length)
    return { error: 'Allow at least one action, or leave actions open' }
  if (!admin) {
    n.patch.locked = false
    n.patch.note = null
  }
  return n
}

export async function mcpScopeRoutes(app: FastifyInstance) {
  app.get('/catalog', { preHandler: requireAuth }, async (req) => {
    const [tools, kits, ready] = await Promise.all([toolCatalogFor(req), listKits(), scopesReady()])
    return { data: { ready, tools, kits, actions: SCOPE_ACTIONS } }
  })

  app.get('/kits', { preHandler: requireAuth }, async (req) => {
    const kits = await listKits()
    if (!req.isAdmin) return { data: { ready: await kitsReady(), kits } }
    const counts = await Promise.all(kits.map((k) => kitUseCount(k.key).catch(() => 0)))
    return {
      data: {
        ready: await kitsReady(),
        kits: kits.map((k, i) => ({ ...k, connections: counts[i] }))
      }
    }
  })

  app.post('/kits', { preHandler: requireAdmin }, async (req, reply) => {
    if (!(await kitsReady())) return notReady(reply)
    const n = normalizeKit(req.body)
    if ('error' in n) return reply.code(400).send({ error: n.error })
    if ((await listKits()).some((k) => k.key === n.kit.key))
      return reply.code(409).send({ error: `There is already a kit called ${n.kit.key}` })
    if ((await storedKitCount()) >= MAX_KITS)
      return reply.code(400).send({ error: `At most ${MAX_KITS} kits` })
    await saveKit(n.kit, String(req.user!.id), true)
    await logActivity({
      action: 'mcp-tool-kit',
      user: req.user!.id,
      comment: `created ${n.kit.key} (${n.kit.tools?.length ?? 0} tools)`,
      req
    })
    return { data: n.kit }
  })

  app.put<{ Params: { key: string } }>(
    '/kits/:key',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await kitsReady())) return notReady(reply)
      const { key } = req.params
      if (isBuiltinKit(key))
        return reply.code(400).send({ error: 'Built-in kits cannot be changed — make your own' })
      const n = normalizeKit({ ...(req.body as object), key })
      if ('error' in n) return reply.code(400).send({ error: n.error })
      if (!(await listKits()).some((k) => k.key === key))
        return reply.code(404).send({ error: 'Kit not found' })
      await saveKit(n.kit, String(req.user!.id), false)
      await logActivity({
        action: 'mcp-tool-kit',
        user: req.user!.id,
        comment: `changed ${key} (${n.kit.tools?.length ?? 0} tools)`,
        req
      })
      return { data: n.kit }
    }
  )

  app.delete<{ Params: { key: string } }>(
    '/kits/:key',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await kitsReady())) return notReady(reply)
      const { key } = req.params
      if (isBuiltinKit(key))
        return reply.code(400).send({ error: 'Built-in kits cannot be removed' })
      const inUse = await kitUseCount(key)
      if (inUse > 0)
        return reply.code(409).send({
          error: `${inUse} connection${inUse === 1 ? ' uses' : 's use'} this kit — move ${inUse === 1 ? 'it' : 'them'} to another kit first`,
          code: 'KIT_IN_USE',
          connections: inUse
        })
      if (!(await deleteKit(key))) return reply.code(404).send({ error: 'Kit not found' })
      await logActivity({
        action: 'mcp-tool-kit',
        user: req.user!.id,
        comment: `removed ${key}`,
        req
      })
      return { data: { removed: true } }
    }
  )

  // ── The person's own OAuth connections ────────────────────────────────────
  app.put<{ Params: { conn: string } }>(
    '/mine/:conn/scope',
    { preHandler: requireAuth },
    async (req, reply) => {
      const conn = req.params.conn.toLowerCase()
      if (!SCOPABLE_CONN_RE.test(conn) || !conn.startsWith('o'))
        return reply
          .code(400)
          .send({ error: 'Only your signed-in connections can be limited here' })
      if (!asThemselves(req))
        return reply.code(403).send({ error: 'Sign in as yourself to change a connection' })
      if (!(await scopesReady())) return notReady(reply)
      const owner = await ownerOf(app, conn)
      if (!owner || owner.toLowerCase() !== String(req.user!.id).toLowerCase())
        return reply.code(404).send({ error: 'Connection not found' })
      const current = await readScopeRow(conn)
      if (current?.locked)
        return reply.code(403).send({
          error: 'An administrator set this connection’s limits, so only they can change them',
          code: 'MCP_SCOPE_LOCKED'
        })
      const n = await readPatch(req.body, false)
      if ('error' in n) return reply.code(400).send({ error: n.error })
      const row = await writeScope(conn, n.patch, { userId: String(req.user!.id), owner })
      await logActivity({
        action: 'mcp-connection-scope',
        user: req.user!.id,
        comment: `${conn}: ${n.patch.kit ? `kit ${n.patch.kit}` : 'custom'}`,
        req
      })
      return { data: { scope: row, effective: effectiveScope(row, await kitMap()) } }
    }
  )

  app.delete<{ Params: { conn: string } }>(
    '/mine/:conn/scope',
    { preHandler: requireAuth },
    async (req, reply) => {
      const conn = req.params.conn.toLowerCase()
      if (!SCOPABLE_CONN_RE.test(conn) || !conn.startsWith('o'))
        return reply.code(400).send({ error: 'conn is not valid' })
      if (!asThemselves(req))
        return reply.code(403).send({ error: 'Sign in as yourself to change a connection' })
      const owner = await ownerOf(app, conn)
      if (!owner || owner.toLowerCase() !== String(req.user!.id).toLowerCase())
        return reply.code(404).send({ error: 'Connection not found' })
      const current = await readScopeRow(conn)
      if (current?.locked)
        return reply.code(403).send({
          error: 'An administrator set this connection’s limits, so only they can change them',
          code: 'MCP_SCOPE_LOCKED'
        })
      await deleteScope(conn)
      await logActivity({
        action: 'mcp-connection-scope',
        user: req.user!.id,
        comment: `${conn}: cleared`,
        req
      })
      return { data: { cleared: true } }
    }
  )

  // ── Administrators ────────────────────────────────────────────────────────
  app.put<{ Params: { conn: string } }>(
    '/:conn/scope',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const conn = req.params.conn.toLowerCase()
      if (!SCOPABLE_CONN_RE.test(conn))
        return reply
          .code(400)
          .send({ error: 'Only signed-in connections and API keys can be limited' })
      if (!(await scopesReady())) return notReady(reply)
      const owner = await ownerOf(app, conn)
      if (!owner) return reply.code(404).send({ error: 'Connection not found' })
      const n = await readPatch(req.body, true)
      if ('error' in n) return reply.code(400).send({ error: n.error })
      const row = await writeScope(conn, n.patch, { userId: String(req.user!.id), owner })
      await logActivity({
        action: 'mcp-connection-scope',
        user: req.user!.id,
        comment: `${conn} of ${owner}: ${n.patch.kit ? `kit ${n.patch.kit}` : 'custom'}${n.patch.locked ? ' (locked)' : ''}`,
        req
      })
      return { data: { scope: row, effective: effectiveScope(row, await kitMap()) } }
    }
  )

  app.delete<{ Params: { conn: string } }>(
    '/:conn/scope',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const conn = req.params.conn.toLowerCase()
      if (!SCOPABLE_CONN_RE.test(conn)) return reply.code(400).send({ error: 'conn is not valid' })
      if (!(await deleteScope(conn))) return reply.code(404).send({ error: 'No limits to clear' })
      await logActivity({
        action: 'mcp-connection-scope',
        user: req.user!.id,
        comment: `${conn}: cleared`,
        req
      })
      return { data: { cleared: true } }
    }
  )
}

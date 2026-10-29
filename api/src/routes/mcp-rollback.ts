import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { CONN_RE } from '../services/mcp-calls.js'
import {
  applyRollback,
  parseWindow,
  planRollback,
  RollbackError
} from '../services/mcp-rollback.js'

/**
 * Roll back one MCP connection's changes (#3219), beside routes/mcp-connections.ts under
 * /api/mcp-connections:
 *
 *   POST /mine/:conn/rollback/preview   {from, to?}             the person's own connection
 *   POST /mine/:conn/rollback           {from, to?, plan_hash}  …apply, signed in to the app
 *   POST /:conn/rollback/preview        {from, to?}             administrators: anyone's
 *   POST /:conn/rollback                {from, to?, plan_hash}  …apply, signed in to the admin
 *
 * The preview lists record ids, field NAMES and what each step does — never values. Apply
 * answers 409 with the fresh plan when anything changed since the preview. Applying needs a
 * person's session: a connected app (OAuth: OAUTH_NO_WRITE already covers this prefix) or an
 * API key cannot roll back — or protect — its own writes.
 */

type Body = { from?: unknown; to?: unknown; plan_hash?: unknown }

function sessionRefusal(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  if (req.authMethod === 'session' && !req.mcpInner) return null
  return reply.code(403).send({
    error: 'A rollback is applied by a person signed in to Nivaro, not through a key or an app',
    code: 'SESSION_REQUIRED'
  })
}

const sendError = (reply: FastifyReply, err: unknown) => {
  if (err instanceof RollbackError)
    return reply
      .code(err.statusCode)
      .send({ error: err.message, ...(err.plan ? { data: err.plan } : {}) })
  throw err
}

export async function mcpRollbackRoutes(app: FastifyInstance) {
  const preview = (own: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { conn } = req.params as { conn: string }
    if (!CONN_RE.test(conn)) return reply.code(400).send({ error: 'conn is not valid' })
    try {
      const b = (req.body ?? {}) as Body
      const { from, to } = parseWindow(b.from, b.to)
      const { plan } = await planRollback({
        conn,
        from,
        to,
        ownerId: own ? String(req.user!.id) : null
      })
      return { data: plan }
    } catch (err) {
      return sendError(reply, err)
    }
  }

  const apply = (own: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const refused = sessionRefusal(req, reply)
    if (refused) return refused
    const { conn } = req.params as { conn: string }
    if (!CONN_RE.test(conn)) return reply.code(400).send({ error: 'conn is not valid' })
    const b = (req.body ?? {}) as Body
    if (typeof b.plan_hash !== 'string' || !/^[0-9a-f]{32}$/.test(b.plan_hash))
      return reply.code(400).send({ error: 'plan_hash from the preview is required' })
    try {
      const { from, to } = parseWindow(b.from, b.to)
      const result = await applyRollback({
        caller: req.user!,
        callerIsAdmin: !!req.isAdmin,
        req,
        conn,
        from,
        to,
        ownerId: own ? String(req.user!.id) : null,
        planHash: b.plan_hash
      })
      return { data: result }
    } catch (err) {
      return sendError(reply, err)
    }
  }

  app.post('/mine/:conn/rollback/preview', { preHandler: requireAuth }, preview(true))
  app.post('/mine/:conn/rollback', { preHandler: requireAuth }, apply(true))
  app.post('/:conn/rollback/preview', { preHandler: requireAdmin }, preview(false))
  app.post('/:conn/rollback', { preHandler: requireAdmin }, apply(false))
}

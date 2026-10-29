import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { mcpHttpEnabled } from '../services/mcp-config.js'
import {
  addSubscription,
  closeAllMcpStreams,
  endSession,
  findSession,
  isInitializeBody,
  MAX_SUBSCRIPTIONS,
  MCP_SESSION_HEADER,
  McpLiveStream,
  type McpSession,
  mcpSessionsEnabled,
  openSession,
  QUESTION_COLLECTION,
  removeSubscription,
  touchSession,
  validSessionId,
  wantsLiveMode
} from '../services/mcp-sessions.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { injectFetch, sessionNotFound } from './mcp.js'

/**
 * Live MCP sessions on the hosted endpoint (#2467) — see services/mcp-sessions.ts.
 *
 *   POST   /api/mcp?live=1   initialize → answer carries Mcp-Session-Id
 *   POST   /api/mcp          with Mcp-Session-Id → resources/subscribe works
 *   GET    /api/mcp          with Mcp-Session-Id → the session's event stream (SSE)
 *   DELETE /api/mcp          with Mcp-Session-Id → end the session
 *
 * A session belongs to the user who opened it: a session id presented by anyone else is
 * "not found". An id this server forgot (its lifetime ran out) is taken up again for the same
 * caller with no subscriptions, rather than failing a client that kept it.
 */

const sessionIdOf = (req: FastifyRequest): string | null => {
  const v = req.headers[MCP_SESSION_HEADER]
  return typeof v === 'string' && v ? v : null
}

/**
 * The session this POST belongs to: `{ session, created }`, null (stateless), or 'unknown'
 * (a session id this caller may not use). Runs after authenticate.
 */
export async function resolveLiveSession(
  app: FastifyInstance,
  req: FastifyRequest
): Promise<{ session: McpSession; created: boolean } | null | 'unknown'> {
  if (!mcpSessionsEnabled() || !req.user) return null
  const user = String(req.user.id)
  const tenant = currentTenantKey()
  const sid = sessionIdOf(req)
  if (sid) {
    if (!validSessionId(sid)) return 'unknown'
    const found = await findSession(app.redis, sid, tenant)
    if (found && found.user !== user) return 'unknown'
    if (found) {
      await touchSession(app.redis, found)
      return { session: found, created: false }
    }
    // Only a live connection was ever handed an id; a stateless one never sends one.
    if (!wantsLiveMode(req.url)) return null
    return { session: await openSession(app.redis, { id: sid, user, tenant }), created: false }
  }
  if (wantsLiveMode(req.url) && isInitializeBody(req.body))
    return { session: await openSession(app.redis, { user, tenant }), created: true }
  return null
}

/** May the caller read this record? Asked through the items API as the caller. */
async function readable(f: typeof fetch, collection: string, id: string): Promise<boolean | null> {
  // #3220 — an agent question is read through its own route (asker, recipient, admin).
  const path =
    collection === QUESTION_COLLECTION
      ? `/api/agent-questions/${encodeURIComponent(id)}`
      : `/api/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}?fields=id`
  const res = await f(`http://mcp.local${path}`)
  if (res.ok) return true
  if (res.status === 401 || res.status === 403 || res.status === 404) return false
  return null
}

/** What createNivaroMcpServer calls on resources/subscribe inside a live session. */
export function subscriptionHost(app: FastifyInstance, req: FastifyRequest, session: McpSession) {
  const f = injectFetch(app, req)
  return {
    async subscribe(record: { uri: string; collection: string; id: string }) {
      const ok = await readable(f, record.collection, record.id).catch(() => null)
      if (ok === false)
        return {
          error: `${record.collection}/${record.id} does not exist or you cannot read it`,
          code: 'NOT_FOUND' as const
        }
      if (ok === null)
        return {
          error: 'Could not check access to that record; try again',
          code: 'UNAVAILABLE' as const
        }
      if ((await addSubscription(app.redis, session, record.uri)) === 'limit')
        return {
          error: `A connection can follow at most ${MAX_SUBSCRIPTIONS} records; unsubscribe from one first`,
          code: 'LIMIT' as const
        }
      return null
    },
    async unsubscribe(uri: string) {
      await removeSubscription(app.redis, session, uri)
    }
  }
}

const notAllowed = (reply: FastifyReply) =>
  reply
    .code(405)
    .header('Allow', 'POST')
    .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })

export async function mcpLiveRoutes(
  app: FastifyInstance,
  opts: { authenticateMcp: (req: FastifyRequest, reply: FastifyReply) => Promise<string | null> }
) {
  /** The caller's own session, or an answer already sent. */
  async function ownSession(req: FastifyRequest, reply: FastifyReply): Promise<McpSession | null> {
    if (!mcpHttpEnabled()) {
      reply.code(404).send({ error: 'The MCP endpoint is turned off (MCP_HTTP)' })
      return null
    }
    const sid = sessionIdOf(req)
    // Stateless server: no standalone event stream and no sessions to end.
    if (!sid || !mcpSessionsEnabled()) {
      notAllowed(reply)
      return null
    }
    if (!(await opts.authenticateMcp(req, reply))) return null
    const session = await findSession(app.redis, sid, currentTenantKey())
    if (!session || !req.user || session.user !== String(req.user.id)) {
      sessionNotFound(reply)
      return null
    }
    return session
  }

  app.get('/mcp', { compress: false }, async (req, reply) => {
    const session = await ownSession(req, reply)
    if (!session) return reply
    if (!String(req.headers.accept ?? '').includes('text/event-stream'))
      return reply.code(406).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'The event stream needs Accept: text/event-stream' },
        id: null
      })

    const f = injectFetch(app, req)
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'mcp-session-id': session.id
    })
    let gone = false
    const stream = new McpLiveStream({
      redis: app.redis,
      session,
      write: (text) => {
        if (gone) return false
        try {
          raw.write(text)
          return true
        } catch {
          return false
        }
      },
      end: () => {
        gone = true
        raw.end()
      },
      credentialOk: async () => {
        const res = await f('http://mcp.local/api/auth/me')
        return res.status !== 401 && res.status !== 403
      },
      canRead: (collection, id) => readable(f, collection, id)
    })
    const stop = () => stream.close('client_closed')
    req.raw.on('close', stop)
    req.raw.on('error', stop)
    raw.write(': ready\n\n')
    await stream.start().catch(() => stream.close('unavailable'))
  })

  app.delete('/mcp', async (req, reply) => {
    const session = await ownSession(req, reply)
    if (!session) return reply
    await endSession(app.redis, session)
    return reply.code(204).send()
  })

  // Before the HTTP server closes: an open event stream would hold the drain (gotchas).
  app.addHook('preClose', async () => {
    closeAllMcpStreams()
  })
}

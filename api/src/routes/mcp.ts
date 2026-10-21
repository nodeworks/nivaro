import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import {
  MCP_INNER_HEADER,
  mcpHttpEnabled,
  mcpInnerHeaderValue,
  mcpOAuthEnabled,
  mcpPublicOrigin,
  protectedResourceMetadataUrl
} from '../services/mcp-config.js'
import { mcpLiveRoutes, resolveLiveSession, subscriptionHost } from './mcp-live.js'

/**
 * POST /api/mcp — the hosted MCP server (Streamable HTTP, stateless).
 *
 * Remote clients (ChatGPT and claude.ai connectors, Claude Code, Codex) send
 * JSON-RPC here with a Bearer credential: an OAuth access token from
 * routes/oauth.ts, an API key or a static token. Each request builds a fresh
 * server from @nivaro/mcp — the same tools the npm stdio server has — whose
 * calls go back into this API IN-PROCESS (app.inject) carrying the caller's
 * own credential, so every tool call is an ordinary API request with the
 * caller's permissions, logging and rate limits. Nothing is held between
 * requests, so any replica can answer any request.
 *
 * Unauthenticated requests get 401 with `WWW-Authenticate: Bearer
 * resource_metadata=…`, which is how a client finds the OAuth server.
 *
 * `/api/mcp?live=1` opts a connection into a session (#2467, routes/mcp-live.ts): the
 * initialize answer carries an Mcp-Session-Id, record resources become subscribable and GET
 * opens the session's event stream. Requests without a session id stay stateless.
 */

const bearerOf = (req: FastifyRequest) => {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

function unauthorized(reply: FastifyReply, message: string, invalid: boolean) {
  const challenge = mcpOAuthEnabled()
    ? `Bearer resource_metadata="${protectedResourceMetadataUrl()}"${invalid ? ', error="invalid_token"' : ''}`
    : 'Bearer'
  return reply
    .code(401)
    .header('WWW-Authenticate', challenge)
    .send({ jsonrpc: '2.0', error: { code: -32001, message }, id: null })
}

/**
 * A fetch for the SDK that answers through `app.inject` as the original caller. `cookie`
 * (the admin MCP console) forwards the signed-in session instead of a bearer, and drops the
 * SDK's placeholder bearer when the caller sent none.
 */
export function injectFetch(
  app: FastifyInstance,
  req: FastifyRequest,
  opts: { cookie?: boolean; inner?: boolean; app?: string } = {}
): typeof fetch {
  const forward: Record<string, string> = {}
  const names = ['authorization', 'x-workspace', 'user-agent', 'x-forwarded-for']
  if (opts.cookie) names.push('cookie')
  for (const h of names) {
    const v = req.headers[h]
    if (typeof v === 'string') forward[h] = v
  }
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    // The caller's own credential, never the SDK's placeholder.
    if (opts.cookie && !forward.authorization) delete headers.authorization
    Object.assign(headers, forward, { 'accept-encoding': 'identity' })
    if (opts.inner !== false) headers[MCP_INNER_HEADER] = mcpInnerHeaderValue()
    if (opts.app) headers['x-nivaro-app'] = opts.app
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: `${url.pathname}${url.search}`,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
      remoteAddress: req.ip
    })
    const out = new Headers()
    for (const [k, v] of Object.entries(res.headers)) {
      if (v == null || k === 'content-length' || k === 'transfer-encoding') continue
      out.set(k, Array.isArray(v) ? v.join(', ') : String(v))
    }
    const empty = res.statusCode === 204 || res.statusCode === 304
    return new Response(empty ? null : res.rawPayload, { status: res.statusCode, headers: out })
  }) as typeof fetch
}

/**
 * Which tools a caller gets — one rule for /api/mcp and the admin MCP console, so the console
 * lists exactly what a connected app signed in as that admin would see.
 */
export function mcpToolOptions(req: FastifyRequest): { adminTools: boolean } {
  // Administrator tools only for an administrator who is not on a collection-scoped key.
  return { adminTools: !!req.isAdmin && !req.user?.api_key_scopes }
}

let mcpModules: Promise<{
  createNivaroMcpServer: typeof import('@nivaro/mcp').createNivaroMcpServer
  StreamableHTTPServerTransport: typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport
}> | null = null
export const loadMcp = () => {
  mcpModules ??= Promise.all([
    import('@nivaro/mcp'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  ]).then(([m, t]) => ({
    createNivaroMcpServer: m.createNivaroMcpServer,
    StreamableHTTPServerTransport: t.StreamableHTTPServerTransport
  }))
  return mcpModules
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', { compress: false }, async (req, reply) => {
    if (!mcpHttpEnabled())
      return reply.code(404).send({ error: 'The MCP endpoint is turned off (MCP_HTTP)' })
    const token = await authenticateMcp(req, reply)
    if (!token) return reply

    // Live mode (#2467): a session to remember subscriptions in, or null = stateless.
    const live = await resolveLiveSession(app, req)
    if (live === 'unknown') return sessionNotFound(reply)

    // Loaded on first use: boot never depends on the MCP packages, and a process
    // nobody connects an assistant to never loads them.
    const { createNivaroMcpServer, StreamableHTTPServerTransport } = await loadMcp()
    const { server } = createNivaroMcpServer({
      url: mcpPublicOrigin(),
      token,
      fetch: injectFetch(app, req),
      ...mcpToolOptions(req),
      subscriptions: live ? subscriptionHost(app, req, live.session) : undefined
    } as Parameters<typeof createNivaroMcpServer>[0])
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    reply.hijack()
    if (live?.created) {
      reply.raw.setHeader('mcp-session-id', live.session.id)
      reply.raw.setHeader('access-control-expose-headers', 'Mcp-Session-Id')
    }
    reply.raw.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req.raw, reply.raw, req.body)
    } catch (err) {
      req.log.error({ err }, 'mcp request failed')
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' })
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null
          })
        )
      }
    }
  })

  // GET (the event stream) and DELETE (end the session) exist only inside a live session;
  // without one the server is stateless and answers 405.
  await mcpLiveRoutes(app, { authenticateMcp })
}

/** Bearer + authenticate, as POST does. Null when it already answered 401. */
async function authenticateMcp(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const token = bearerOf(req)
  if (!token) {
    unauthorized(reply, 'Sign in to connect to Nivaro', false)
    return null
  }
  try {
    await authenticate(req, reply)
  } catch (err) {
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode === 401) {
      unauthorized(reply, e.message ?? 'Unauthorized', true)
      return null
    }
    throw err
  }
  return token
}

export function sessionNotFound(reply: FastifyReply) {
  return reply
    .code(404)
    .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })
}

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createNivaroMcpServer } from '@nivaro/mcp'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import {
  mcpHttpEnabled,
  mcpOAuthEnabled,
  mcpPublicOrigin,
  protectedResourceMetadataUrl
} from '../services/mcp-config.js'

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

/** A fetch for the SDK that answers through `app.inject` as the original caller. */
export function injectFetch(app: FastifyInstance, req: FastifyRequest): typeof fetch {
  const forward: Record<string, string> = {}
  for (const h of ['authorization', 'x-workspace', 'user-agent', 'x-forwarded-for']) {
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
    Object.assign(headers, forward, { 'accept-encoding': 'identity' })
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

export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', { compress: false }, async (req, reply) => {
    if (!mcpHttpEnabled())
      return reply.code(404).send({ error: 'The MCP endpoint is turned off (MCP_HTTP)' })
    const token = bearerOf(req)
    if (!token) return unauthorized(reply, 'Sign in to connect to Nivaro', false)
    try {
      await authenticate(req, reply)
    } catch (err) {
      const e = err as { statusCode?: number; message?: string }
      if (e.statusCode === 401) return unauthorized(reply, e.message ?? 'Unauthorized', true)
      throw err
    }

    const { server } = createNivaroMcpServer({
      url: mcpPublicOrigin(),
      token,
      fetch: injectFetch(app, req),
      // Administrator tools only for an administrator who is not on a collection-scoped key.
      adminTools: !!req.isAdmin && !req.user?.api_key_scopes
    } as Parameters<typeof createNivaroMcpServer>[0])
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    reply.hijack()
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

  // Stateless server: no standalone event stream and no sessions to end.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
  app.get('/mcp', notAllowed)
  app.delete('/mcp', notAllowed)
}

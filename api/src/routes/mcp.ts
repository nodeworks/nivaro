import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate, enforceRateLimit } from '../middleware/authenticate.js'
import {
  classifyToolAnswer,
  clientSlug,
  connectionLimit,
  mcpClientNameOf,
  mcpConnOf,
  readMcpSettings,
  rpcCallOf,
  toolAnswerMessage,
  watchResponse
} from '../services/mcp-calls.js'
import {
  MCP_INNER_HEADER,
  mcpHttpEnabled,
  mcpInnerHeaderValue,
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

/**
 * A refused tool call over the rate limit (#2469): HTTP 429 with Retry-After and a JSON-RPC error
 * whose message says why, so the agent can tell its person and wait rather than retry at once.
 */
function rateLimited(
  reply: FastifyReply,
  err: { message?: string; code?: string; retryAfter?: number },
  id: string | number | null
) {
  return reply.code(429).send({
    jsonrpc: '2.0',
    error: {
      code: -32029,
      message: err.message ?? 'Too many requests',
      data: { code: err.code ?? 'RATE_LIMITED', retry_after_s: err.retryAfter ?? null }
    },
    id
  })
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
    Object.assign(headers, forward, {
      'accept-encoding': 'identity',
      [MCP_INNER_HEADER]: mcpInnerHeaderValue()
    })
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

let mcpModules: Promise<{
  createNivaroMcpServer: typeof import('@nivaro/mcp').createNivaroMcpServer
  StreamableHTTPServerTransport: typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport
}> | null = null
const loadMcp = () => {
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
    const token = bearerOf(req)
    if (!token) return unauthorized(reply, 'Sign in to connect to Nivaro', false)
    const rpc = rpcCallOf(req.body)
    try {
      await authenticate(req, reply)
    } catch (err) {
      const e = err as { statusCode?: number; message?: string }
      if (e.statusCode === 401) return unauthorized(reply, e.message ?? 'Unauthorized', true)
      if (e.statusCode === 429) return rateLimited(reply, e, rpc.id)
      throw err
    }

    // #2466 — a tool call is logged on this row: its connection, tool, outcome and bytes.
    // #2469 — and counted against the connection's tool-call limit.
    const conn = mcpConnOf(req)
    if (rpc.tool && conn) {
      const name = mcpClientNameOf(req)
      req.mcpCall = { conn, client: clientSlug(name), tool: rpc.tool }
      const limit = connectionLimit(await readMcpSettings(), conn)
      if (limit > 0) {
        try {
          await enforceRateLimit(req, reply, {
            bucket: `mcp:${conn}`,
            limit,
            code: 'MCP_CONNECTION_RATE_LIMITED',
            message: (wait) =>
              `${name} may make ${limit} tool calls a minute on this connection, so one assistant cannot crowd out everyone else using Nivaro. Wait ${wait} seconds and carry on; an administrator can raise the limit for this connection.`
          })
        } catch (err) {
          const e = err as { statusCode?: number; message?: string }
          if (e.statusCode !== 429) throw err
          req.mcpCall.outcome = 'refused'
          return rateLimited(reply, e, rpc.id)
        }
      }
    }

    // Loaded on first use: boot never depends on the MCP packages, and a process
    // nobody connects an assistant to never loads them.
    const { createNivaroMcpServer, StreamableHTTPServerTransport } = await loadMcp()
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
    const call = req.mcpCall
    if (call) {
      watchResponse(reply.raw, (head, tail, bytes) => {
        call.outcome = classifyToolAnswer(head, tail)
        call.bytes = bytes
        // The refusal's own words on the row (the logger's error column), for the person's list.
        const said = call.outcome === 'ok' ? null : toolAnswerMessage(head)
        if (said) (req as unknown as { __nvrErr?: string }).__nvrErr = said
      })
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

  // Stateless server: no standalone event stream and no sessions to end.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
  app.get('/mcp', notAllowed)
  app.delete('/mcp', notAllowed)
}

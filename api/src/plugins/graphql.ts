import { execute, type GraphQLSchema, parse, validate } from 'graphql'
import { makeServer as makeWsServer } from 'graphql-ws'
import { WebSocket, WebSocketServer } from 'ws'
import { authenticate } from '../middleware/authenticate.js'
import { buildGraphQLSchema } from '../services/schema-builder.js'

const GRAPHIQL_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nivaro GraphQL</title>
  <link rel="stylesheet" href="https://esm.sh/graphiql@3/graphiql.min.css" />
  <style>body { margin: 0; height: 100vh; overflow: hidden; }</style>
</head>
<body>
  <div id="graphiql" style="height:100vh;"></div>
  <script type="importmap">{"imports":{"react":"https://esm.sh/react@18","react-dom/client":"https://esm.sh/react-dom@18/client","graphiql":"https://esm.sh/graphiql@3"}}</script>
  <script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { GraphiQL } from 'graphiql';

    const fetcher = async (params) => {
      const token = localStorage.getItem('nivaro-token');
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const res = await fetch('/api/graphql', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(params),
      });
      return res.json();
    };

    createRoot(document.getElementById('graphiql')).render(
      React.createElement(GraphiQL, {
        fetcher,
        defaultEditorToolsVisibility: true,
        defaultQuery: \`# Nivaro GraphQL API
# Authenticate via session cookie or Bearer token.
# Token: localStorage.setItem('nivaro-token', 'your-token-here')
#
# Example:
# { articles(limit: 10) { data { id name status } total } }
\`,
      })
    );
  </script>
</body>
</html>`

let _schema: GraphQLSchema | null = null

async function getSchema(): Promise<GraphQLSchema> {
  if (!_schema) _schema = await buildGraphQLSchema()
  return _schema
}

// ─── Persisted queries ───────────────────────────────────────────────────────
// Clients send { id } (numeric DB id) or APQ-style
// { extensions: { persistedQuery: { sha256Hash } } } instead of full query text.
// Stored queries are cached in-process for 60s.

const PQ_CACHE_TTL_MS = 60_000
const pqCache = new Map<string, { query: string | null; expires: number }>()

async function lookupPersistedQuery(key: { id?: unknown; hash?: string }): Promise<string | null> {
  const cacheKey = key.hash ? `h:${key.hash}` : `i:${String(key.id)}`
  const cached = pqCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) return cached.query

  let query: string | null = null
  try {
    const { db } = await import('../db/index.js')
    const row = key.hash
      ? ((await db('nivaro_persisted_queries').where({ hash: key.hash }).first()) as
          | { query: string }
          | undefined)
      : ((await db('nivaro_persisted_queries')
          .where({ id: Number(key.id) })
          .first()) as { query: string } | undefined)
    query = row?.query ?? null
  } catch {
    query = null
  }

  pqCache.set(cacheKey, { query, expires: Date.now() + PQ_CACHE_TTL_MS })
  return query
}

export async function rebuildGraphQLSchema(): Promise<void> {
  _schema = await buildGraphQLSchema()
}

export async function graphqlPlugin(app: import('fastify').FastifyInstance) {
  // graphql-ws server — handles subscription WebSocket connections
  const wsServer = makeWsServer({
    schema: () => getSchema(),
    context: async (ctx) => {
      const extra = ctx.extra as { request?: { headers?: Record<string, string> } }
      const authHeader =
        (ctx.connectionParams as Record<string, string> | undefined)?.authorization ??
        extra.request?.headers?.authorization ??
        ''
      if (!authHeader) return { user: undefined, isAdmin: false }
      const token = authHeader.replace(/^bearer /i, '').trim()
      if (!token) return { user: undefined, isAdmin: false }
      try {
        const { db } = await import('../db/index.js')
        const user = await db('nivaro_users as u')
          .join('nivaro_roles as r', 'u.role', 'r.id')
          .where('u.static_token', token)
          .where('u.status', 'active')
          .select('u.*', 'r.admin_access', 'r.app_access')
          .first()
        if (!user) return { user: undefined, isAdmin: false }
        return { user, isAdmin: Boolean(user.admin_access) }
      } catch {
        return { user: undefined, isAdmin: false }
      }
    }
  })

  // Raw WebSocket server — only intercepts /api/graphql-ws, returns for all other paths
  // so Socket.io's upgrade handler (registered earlier) is not destroyed by @fastify/websocket
  const wss = new WebSocketServer({ noServer: true })

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname !== '/api/graphql-ws') return

    wss.handleUpgrade(req, socket, head, (client) => {
      const closed = wsServer.opened(
        {
          protocol: client.protocol,
          send: async (data) => {
            if (client.readyState === WebSocket.OPEN) client.send(data)
          },
          close: (code, reason) => client.close(code, reason),
          onMessage: (cb) => client.on('message', (data: Buffer | string) => cb(data.toString()))
        },
        { socket: client, request: req }
      )
      client.once('close', (code: number, reason: Buffer) => closed(code, reason?.toString() ?? ''))
    })
  })

  app.addHook('onClose', async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  // Build schema after server is ready
  app.addHook('onReady', async () => {
    try {
      _schema = await buildGraphQLSchema()
      app.log.info('GraphQL schema built')
    } catch (err) {
      app.log.warn({ err }, 'GraphQL schema build failed at startup — will retry on first request')
    }
  })

  // ── GraphiQL explorer ────────────────────────────────────────────────────
  app.get('/graphql', async (_req, reply) => {
    return reply.type('text/html').send(GRAPHIQL_HTML)
  })

  // ── GraphQL endpoint ─────────────────────────────────────────────────────
  app.post('/graphql', async (req, reply) => {
    try {
      await authenticate(req, reply)
    } catch {
      // unauthenticated — resolvers will throw UNAUTHENTICATED
    }

    const body = req.body as {
      query?: string
      variables?: Record<string, unknown>
      operationName?: string
      id?: number | string
      extensions?: { persistedQuery?: { sha256Hash?: string } }
    }

    // Persisted query substitution — { id } or APQ { extensions.persistedQuery.sha256Hash }
    if (!body?.query) {
      const hash = body?.extensions?.persistedQuery?.sha256Hash
      if (body?.id != null || hash) {
        const stored = await lookupPersistedQuery(hash ? { hash } : { id: body.id })
        if (!stored) {
          return reply.code(404).send({
            errors: [
              {
                message: 'PersistedQueryNotFound',
                extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' }
              }
            ]
          })
        }
        body.query = stored
      }
    }

    if (!body?.query) {
      return reply.code(400).send({ errors: [{ message: 'query is required' }] })
    }

    const schema = await getSchema()

    let document: ReturnType<typeof parse>
    try {
      document = parse(body.query)
    } catch (err) {
      return reply.send({ errors: [{ message: String(err) }] })
    }

    const validationErrors = validate(schema, document)
    if (validationErrors.length > 0) {
      return reply.send({ errors: validationErrors })
    }

    const result = await execute({
      schema,
      document,
      variableValues: body.variables,
      operationName: body.operationName,
      contextValue: { user: req.user, isAdmin: req.isAdmin ?? false }
    })

    return reply.send(result)
  })

  // ── Schema rebuild (admin) ────────────────────────────────────────────────
  app.post(
    '/graphql/rebuild',
    {
      preHandler: async (req, reply) => {
        await authenticate(req, reply)
        if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
      }
    },
    async (_req, reply) => {
      await rebuildGraphQLSchema()
      return reply.send({ ok: true })
    }
  )

  app.log.info('GraphQL API registered at /api/graphql')
}

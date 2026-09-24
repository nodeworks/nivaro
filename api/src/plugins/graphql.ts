import { execute, type GraphQLSchema, parse, validate } from 'graphql'
import { makeServer as makeWsServer } from 'graphql-ws'
import { WebSocket, WebSocketServer } from 'ws'
import { config } from '../config.js'
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
// One build at a time: a request arriving mid-build awaits the same promise
// instead of starting a second scan of every collection.
let _building: Promise<GraphQLSchema> | null = null

async function getSchema(): Promise<GraphQLSchema> {
  if (_schema) return _schema
  if (!_building) {
    _building = buildGraphQLSchema()
      .then(async (schema) => {
        _schema = schema
        const { recordGraphQLSchema } = await import('../services/api-changelog.js')
        void recordGraphQLSchema(schema)
        return schema
      })
      .finally(() => {
        _building = null
      })
  }
  return _building
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
    // Persisted query hygiene (#176): usage counter + last-used stamp,
    // fire-and-forget. The 60s cache means one bump per TTL window, which is
    // exactly the granularity a stale-flag needs.
    if (query) {
      const bump = key.hash
        ? db('nivaro_persisted_queries').where({ hash: key.hash })
        : db('nivaro_persisted_queries').where({ id: Number(key.id) })
      void bump.increment('use_count', 1).catch(() => {})
      const stamp = key.hash
        ? db('nivaro_persisted_queries').where({ hash: key.hash })
        : db('nivaro_persisted_queries').where({ id: Number(key.id) })
      void stamp.update({ last_used_at: new Date() }).catch(() => {})
    }
  } catch {
    query = null
  }

  pqCache.set(cacheKey, { query, expires: Date.now() + PQ_CACHE_TTL_MS })
  return query
}

export async function rebuildGraphQLSchema(): Promise<void> {
  _schema = await buildGraphQLSchema()
  {
    const { recordGraphQLSchema } = await import('../services/api-changelog.js')
    void recordGraphQLSchema(_schema)
  }
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

  // Build the schema at startup. In production this blocks `ready` so the
  // first GraphQL request is never the slow one. In development it is the
  // largest single cost of a restart (~13s cold: one read per collection,
  // field and relation table), so the build runs in the background and the
  // port opens at once — the first GraphQL request simply awaits it.
  app.addHook('onReady', async () => {
    const build = getSchema()
      .then(() => app.log.info('GraphQL schema built'))
      .catch((err) =>
        app.log.warn(
          { err },
          'GraphQL schema build failed at startup — will retry on first request'
        )
      )
    if (config.NODE_ENV !== 'development') await build
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

    // GraphQL cost limits (#162): a selection-count cap plus an OPTIONAL depth
    // cap. Depth is unlimited unless a named API key carries its own
    // `graphql_max_depth` or the instance sets GRAPHQL_MAX_DEPTH (0 = off) —
    // legitimate integration reads routinely nest 13–15 levels, since every
    // M2M hop costs two, so a low fixed default only ever blocked real callers.
    // Selections still bound the fan-out of a runaway query.
    {
      const keyDepth = (req.user as { api_key_graphql_max_depth?: number | null } | undefined)
        ?.api_key_graphql_max_depth
      const envDepth = Number(process.env.GRAPHQL_MAX_DEPTH ?? 0)
      const maxDepth = keyDepth ?? (Number.isFinite(envDepth) && envDepth > 0 ? envDepth : null)
      const maxSelections = Number(process.env.GRAPHQL_MAX_SELECTIONS ?? 2500)
      const cost = measureQueryCost(document)
      if (maxDepth != null && cost.depth > maxDepth) {
        const scope = keyDepth != null ? ' for this API key' : ''
        return reply.code(400).send({
          errors: [
            {
              message: `Query depth ${cost.depth} exceeds the limit of ${maxDepth}${scope}`
            }
          ]
        })
      }
      if (cost.selections > maxSelections) {
        return reply.code(400).send({
          errors: [
            {
              message: `Query requests ${cost.selections} fields — the limit is ${maxSelections}`
            }
          ]
        })
      }
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

// Depth + selection count for the cost limiter (#162). Fragments count at
// their spread site; a fragment cycle is impossible past validation.
function measureQueryCost(document: ReturnType<typeof parse>): {
  depth: number
  selections: number
} {
  let selections = 0
  let maxDepth = 0
  const fragments = new Map<string, unknown>()
  for (const def of document.definitions) {
    if (def.kind === 'FragmentDefinition') fragments.set(def.name.value, def)
  }
  const walk = (selectionSet: unknown, depth: number): void => {
    const set = selectionSet as { selections?: unknown[] } | undefined
    if (!set?.selections) return
    if (depth > maxDepth) maxDepth = depth
    for (const sel of set.selections) {
      const node = sel as {
        kind: string
        selectionSet?: unknown
        name?: { value: string }
      }
      if (node.kind === 'Field') {
        selections++
        if (node.selectionSet) walk(node.selectionSet, depth + 1)
      } else if (node.kind === 'InlineFragment') {
        walk(node.selectionSet, depth)
      } else if (node.kind === 'FragmentSpread' && node.name) {
        const frag = fragments.get(node.name.value) as { selectionSet?: unknown } | undefined
        if (frag?.selectionSet) walk(frag.selectionSet, depth)
      }
      if (selections > 100_000) return // hard stop — cost check itself must stay cheap
    }
  }
  for (const def of document.definitions) {
    if (def.kind === 'OperationDefinition') walk(def.selectionSet, 1)
  }
  return { depth: maxDepth, selections }
}

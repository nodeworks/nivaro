import {
  type DocumentNode,
  type ExecutionArgs,
  execute,
  GraphQLError,
  type GraphQLSchema,
  getOperationAST,
  Kind,
  parse,
  subscribe,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo
} from 'graphql'
import { CloseCode, makeServer as makeWsServer } from 'graphql-ws'
import { WebSocket, WebSocketServer } from 'ws'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { markBootPhase } from '../services/boot-phases.js'
import { beginIdempotency, isGraphQLMutation } from '../services/idempotency.js'
import { type LiveIdentity, liveOperation, liveQuery } from '../services/live-query.js'
import { buildGraphQLSchema } from '../services/schema-builder.js'
import { checkBind, type SocketBind, sha } from '../services/socket-access.js'
import { inSocketTenant, socketTenant } from '../services/socket-tenant.js'
import {
  loadStreamIdentity,
  recheckStreamIdentity,
  redeemStreamTicket
} from '../services/stream-ticket.js'
import { openStream } from '../services/traffic-taps/realtime.js'
import type { User } from '../types.js'
import { graphqlSseRoutes } from './graphql-sse.js'

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
let _everBuilt = false

async function getSchema(): Promise<GraphQLSchema> {
  if (_schema) return _schema
  if (!_building) {
    const began = Date.now()
    _building = buildGraphQLSchema()
      .then(async (schema) => {
        if (!_everBuilt) {
          _everBuilt = true
          markBootPhase('GraphQL schema', Date.now() - began, { background: true })
        }
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

/** The served schema (built once, shared) — for readers such as the partner
 *  dependency map (#608) that walk documents against it. */
export function getGraphQLSchema(): Promise<GraphQLSchema> {
  return getSchema()
}

export async function rebuildGraphQLSchema(): Promise<void> {
  _schema = await buildGraphQLSchema()
  {
    const { recordGraphQLSchema } = await import('../services/api-changelog.js')
    void recordGraphQLSchema(_schema)
  }
}

export async function graphqlPlugin(
  app: import('fastify').FastifyInstance,
  opts: { streamsOnly?: boolean } = {}
) {
  /**
   * Who a graphql-ws connection signed in as, resolved once per connection: a one-shot stream
   * ticket in connectionParams (`{ ticket }` from GET /api/events/ticket — sessions, View-as and
   * API keys, #1749) or a static token in `authorization`. The connection remembers what signed
   * it in (#1719): every operation reads the identity fresh, and the connection closes (4401)
   * when that sign-in ends — logout, revoked session or key, rotated token, inactive account.
   */
  const connectionSignIn = (extra: WsExtra, params: Record<string, unknown> | undefined) => {
    if (!extra.nvrSignIn) extra.nvrSignIn = resolveConnection(extra, params)
    return extra.nvrSignIn
  }

  const resolveConnection = async (
    extra: WsExtra,
    params: Record<string, unknown> | undefined
  ): Promise<WsSignIn | null> => {
    // Cloud: the upgrade never passed the tenant hook — resolve the tenant from its host (as a
    // socket does), sign in against THAT tenant's database, and hand the tenant key to the
    // subscription resolvers, whose topics are per tenant. No resolvable tenant = no user.
    let tenantKey = ''
    let withTenant: (<T>(fn: () => Promise<T>) => Promise<T>) | undefined
    if (process.env.CLOUD_META_DB_URL) {
      const socketLike = { handshake: { headers: extra.request?.headers ?? {} }, data: {} }
      const t = await socketTenant(socketLike)
      if (!t) return null
      tenantKey = t.tenantId || t.slug
      // Resolvers run outside the tenant context too: they re-enter it through this.
      withTenant = <T>(fn: () => Promise<T>) =>
        new Promise<T>((resolve, reject) => {
          void inSocketTenant(socketLike, async () => {
            try {
              resolve(await fn())
            } catch (err) {
              reject(err)
            }
          })()
        })
    }
    const inTenant = <T>(fn: () => Promise<T>) => (withTenant ? withTenant(fn) : fn())
    const ticket = typeof params?.ticket === 'string' ? params.ticket : null
    const authHeader = String(params?.authorization ?? extra.request?.headers?.authorization ?? '')
    const token = authHeader.replace(/^bearer /i, '').trim()
    let found: { userId: string; bind: SocketBind } | null = null
    if (ticket) found = await inTenant(() => redeemStreamTicket(app.redis, ticket))
    else if (token) {
      const row = (await inTenant(() =>
        db('nivaro_users').where({ static_token: token, status: 'active' }).first('id')
      )) as { id: string } | undefined
      if (row) found = { userId: String(row.id), bind: { kind: 'token', tokenHash: sha(token) } }
    }
    if (!found) return null
    const signIn: WsSignIn = { ...found, tenantKey, withTenant }
    // The connection ends with its sign-in, even when nothing is being delivered.
    const watch = setInterval(() => {
      void inTenant(() => checkBind(app.redis, signIn.userId, signIn.bind))
        .then((ended) => {
          if (ended) extra.socket?.close(CloseCode.Unauthorized, 'Your sign-in ended')
        })
        .catch(() => {})
    }, wsSignInCheckMs())
    watch.unref()
    extra.nvrWatch = watch
    return signIn
  }

  // graphql-ws server — handles subscription WebSocket connections
  const wsServer = makeWsServer({
    schema: () => getSchema(),
    context: async (ctx) => {
      const extra = ctx.extra as WsExtra
      try {
        const signIn = await connectionSignIn(extra, ctx.connectionParams)
        if (!signIn) return { user: undefined, isAdmin: false }
        const inTenant = <T>(fn: () => Promise<T>) =>
          signIn.withTenant ? signIn.withTenant(fn) : fn()
        const who = await inTenant(() => loadStreamIdentity(signIn.userId, signIn.bind))
        if (!who) return { user: undefined, isAdmin: false }
        let last: LiveIdentity = who
        // Live queries re-read the identity before every run (#2126).
        const liveIdentity = async () => {
          const r = await recheckStreamIdentity(app.redis, signIn.userId, signIn.bind, last)
          if (r.identity) last = r.identity
          return r.identity
        }
        return {
          user: who.user,
          isAdmin: who.isAdmin,
          tenantKey: signIn.tenantKey,
          withTenant: signIn.withTenant,
          liveIdentity
        }
      } catch {
        return { user: undefined, isAdmin: false }
      }
    },
    // The same cost limits as POST /graphql; a `@live` query becomes a live query (#2126).
    execute: (args) => executeOrLive(args),
    subscribe: (args) => {
      const refused = costRefusal(args.document, (args.contextValue as WsContext)?.user)
      return refused ? { errors: [refused] } : subscribe(args)
    }
  })

  // Raw WebSocket server — only intercepts /api/graphql-ws, returns for all other paths
  // so Socket.io's upgrade handler (registered earlier) is not destroyed by @fastify/websocket
  const wss = new WebSocketServer({ noServer: true })

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname !== '/api/graphql-ws') return

    wss.handleUpgrade(req, socket, head, (client) => {
      const extra: WsExtra = { socket: client, request: req as WsExtra['request'] }
      // Traffic Map (#2155): the connection and what it sends are counted as a stream.
      const stream = openStream('graphql-ws')
      const closed = wsServer.opened(
        {
          protocol: client.protocol,
          send: async (data) => {
            if (client.readyState === WebSocket.OPEN) {
              stream.write(Buffer.byteLength(data), true)
              client.send(data)
            }
          },
          close: (code, reason) => client.close(code, reason),
          onMessage: (cb) => client.on('message', (data: Buffer | string) => cb(data.toString()))
        },
        extra
      )
      client.once('close', (code: number, reason: Buffer) => {
        stream.close()
        if (extra.nvrWatch) clearInterval(extra.nvrWatch)
        void closed(code, reason?.toString() ?? '')
      })
    })
  })

  // Before the HTTP server closes (see the socket.io preClose): wss.close()
  // stops new upgrades but leaves open clients connected, and those keep the
  // server from closing.
  app.addHook('preClose', async () => {
    for (const client of wss.clients) client.terminate()
  })
  app.addHook('onClose', async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })

  // Subscriptions and live queries over Server-Sent Events (#1749), for clients whose proxies
  // block WebSockets: GET/POST /graphql/stream.
  await graphqlSseRoutes(app, {
    getSchema,
    lookupPersistedQuery,
    costRefusal,
    executeOrLive
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

  // Post-mortem 3.3 — a realtime process (NIVARO_ROLE=realtime) carries the subscription
  // transports only; queries, mutations and the admin routes stay on the web processes.
  if (opts.streamsOnly) {
    app.log.info('GraphQL subscriptions registered (graphql-ws, /api/graphql/stream)')
    return
  }

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

    // Idempotency-Key on a mutation: a repeat of the same request returns the
    // first answer instead of writing twice. Reads are never deduplicated.
    if (req.headers['idempotency-key'] && isGraphQLMutation(body?.query)) {
      const answered = await beginIdempotency(req, reply, 'graphql')
      if (answered) return answered
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

    // Operation analytics (#607): what this request asked for, on the log
    // row the api-logger writes for it.
    const gqlStamp = describeOperation(schema, document, body.operationName)
    ;(req as unknown as { __nvrGql?: GraphQLStamp }).__nvrGql = gqlStamp

    const validationErrors = validate(schema, document)
    if (validationErrors.length > 0) {
      gqlStamp.errors = validationErrors.length
      return reply.send({ errors: validationErrors })
    }

    // GraphQL cost limits (#162): a selection-count cap plus an OPTIONAL depth
    // cap. Depth is unlimited unless a named API key carries its own
    // `graphql_max_depth` or the instance sets GRAPHQL_MAX_DEPTH (0 = off) —
    // legitimate integration reads routinely nest 13–15 levels, since every
    // M2M hop costs two, so a low fixed default only ever blocked real callers.
    // Selections still bound the fan-out of a runaway query.
    {
      const cost = queryCostVerdict(document, req.user)
      gqlStamp.depth = cost.depth
      gqlStamp.selections = cost.selections
      if (cost.refusal) {
        if (cost.depthRefused) gqlStamp.errors = 1
        return reply.code(400).send({ errors: [{ message: cost.refusal }] })
      }
    }

    // A sandbox key stores nothing: its mutations may only be rehearsals.
    if (req.user?.api_key_sandbox) {
      const stored: string[] = []
      for (const def of document.definitions) {
        if (def.kind !== 'OperationDefinition' || def.operation !== 'mutation') continue
        for (const sel of def.selectionSet.selections) {
          if (sel.kind !== 'Field') stored.push('a fragment')
          else if (!sel.name.value.endsWith('_dry_run')) stored.push(sel.name.value)
        }
      }
      if (stored.length > 0) {
        return reply.send({
          data: null,
          errors: [
            {
              message: `A sandbox key stores nothing, so it cannot run ${stored.join(', ')}. Use the _dry_run mutation of the collection.`,
              extensions: { code: 'SANDBOX_KEY_DRY_RUN_ONLY', status: 403, fields: stored }
            }
          ]
        })
      }
    }

    const upserts: Array<{ collection: string; matched_id: string | number; keys: string[] }> = []
    const result = await execute({
      schema,
      document,
      variableValues: body.variables,
      operationName: body.operationName,
      contextValue: { user: req.user, isAdmin: req.isAdmin ?? false, req, upserts }
    })

    // A refusal that came from the API key's own scopes names the scope.
    const denied = req.user?.api_key_scope_denied
    if (denied && result.errors?.length) {
      for (const e of result.errors) {
        const ext = (e.extensions ?? {}) as Record<string, unknown>
        if (ext.code !== 'FORBIDDEN') continue
        e.message = `This API key has no ${denied.action} scope on ${denied.collection}`
        Object.assign(ext, { code: 'API_KEY_SCOPE_MISSING', status: 403, scope: denied })
      }
    }

    gqlStamp.errors = result.errors?.length ?? 0

    // A create that matched an existing record by its natural key was an
    // update; the response says which.
    if (upserts.length > 0) {
      return reply.send({ ...result, extensions: { ...(result.extensions ?? {}), upserts } })
    }
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

  // The schema changelog (#613) at the address a partner would guess, beside
  // the endpoint it describes. Same rows the dev-tools route serves.
  app.get(
    '/graphql/changelog',
    {
      preHandler: async (req, reply) => {
        await authenticate(req, reply)
        if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
      }
    },
    async (req, reply) => {
      const limit = Math.min(
        200,
        Math.max(1, Number((req.query as { limit?: string }).limit ?? 50))
      )
      const rows = await db('nivaro_graphql_schema_log')
        .orderBy('id', 'desc')
        .limit(limit)
        .select('id', 'at', 'diff', 'breaking')
      const { deprecationWindowDays } = await import('../services/deprecation-policy.js')
      const { graphqlStrictMutations } = await import('../services/graphql-strict.js')
      return reply.send({
        data: rows,
        policy: {
          deprecation_days: await deprecationWindowDays(),
          // #1222: update/delete on a missing id answers NOT_FOUND instead of null.
          strict_mutations: await graphqlStrictMutations()
        }
      })
    }
  )

  app.log.info('GraphQL API registered at /api/graphql')
}

/** How often a graphql-ws connection re-checks its sign-in (GRAPHQL_WS_SIGNIN_CHECK_MS). */
function wsSignInCheckMs(): number {
  const n = Number(process.env.GRAPHQL_WS_SIGNIN_CHECK_MS)
  return Number.isFinite(n) && n >= 50 ? n : 30_000
}

interface WsSignIn {
  userId: string
  bind: SocketBind
  tenantKey: string
  withTenant?: <T>(fn: () => Promise<T>) => Promise<T>
}

interface WsExtra {
  socket?: WebSocket
  request?: { headers?: Record<string, string> }
  nvrSignIn?: Promise<WsSignIn | null>
  nvrWatch?: ReturnType<typeof setInterval>
}

/** The context a subscription transport hands graphql-ws / the SSE stream. */
export interface WsContext {
  user?: User
  isAdmin?: boolean
  tenantKey?: string
  withTenant?: <T>(fn: () => Promise<T>) => Promise<T>
  /** The subscriber's identity, read fresh (live query re-runs). Null = the sign-in ended. */
  liveIdentity?: () => Promise<LiveIdentity | null>
}

/**
 * The cost limits (#162) for a document: a selection-count cap plus an OPTIONAL depth cap.
 * Depth is unlimited unless a named API key carries its own `graphql_max_depth` or the instance
 * sets GRAPHQL_MAX_DEPTH (0 = off) — legitimate integration reads routinely nest 13–15 levels,
 * since every M2M hop costs two, so a low fixed default only ever blocked real callers.
 * Selections still bound the fan-out of a runaway query.
 */
function queryCostVerdict(
  document: DocumentNode,
  user: User | undefined
): { depth: number; selections: number; refusal: string | null; depthRefused: boolean } {
  const keyDepth = (user as { api_key_graphql_max_depth?: number | null } | undefined)
    ?.api_key_graphql_max_depth
  const envDepth = Number(process.env.GRAPHQL_MAX_DEPTH ?? 0)
  const maxDepth = keyDepth ?? (Number.isFinite(envDepth) && envDepth > 0 ? envDepth : null)
  const maxSelections = Number(process.env.GRAPHQL_MAX_SELECTIONS ?? 2500)
  const cost = measureQueryCost(document)
  if (maxDepth != null && cost.depth > maxDepth) {
    const scope = keyDepth != null ? ' for this API key' : ''
    return {
      ...cost,
      refusal: `Query depth ${cost.depth} exceeds the limit of ${maxDepth}${scope}`,
      depthRefused: true
    }
  }
  if (cost.selections > maxSelections)
    return {
      ...cost,
      refusal: `Query requests ${cost.selections} fields — the limit is ${maxSelections}`,
      depthRefused: false
    }
  return { ...cost, refusal: null, depthRefused: false }
}

/** The cost limits as a GraphQL error (subscription transports), or null. */
function costRefusal(document: DocumentNode, user: User | undefined): GraphQLError | null {
  const { refusal } = queryCostVerdict(document, user)
  return refusal ? new GraphQLError(refusal, { extensions: { code: 'QUERY_TOO_COSTLY' } }) : null
}

/**
 * Run a query or mutation for a subscription transport: a `@live` query opens a live query
 * (#2126) as the subscriber; anything else executes once.
 */
export function executeOrLive(args: ExecutionArgs) {
  // Post-mortem 3.3 review — the subscription transports only read. A mutation here would
  // skip the request pipeline (and on a realtime process every hook, extension and webhook).
  if (getOperationAST(args.document, args.operationName)?.operation === 'mutation')
    return {
      errors: [
        new GraphQLError('Send mutations to POST /api/graphql; this stream only reads', {
          extensions: { code: 'MUTATION_NOT_ALLOWED' }
        })
      ]
    }
  const ctx = (args.contextValue ?? {}) as WsContext
  const refused = costRefusal(args.document, ctx.user)
  if (refused) return { errors: [refused] }
  const live = liveOperation(args.document, args.operationName, args.variableValues)
  if (!live) return execute(args)
  if (!ctx.user || !ctx.liveIdentity)
    return {
      errors: [
        new GraphQLError('Sign in to open a live query', {
          extensions: { code: 'UNAUTHENTICATED' }
        })
      ]
    }
  return liveQuery({
    schema: args.schema,
    document: args.document,
    variableValues: args.variableValues as Record<string, unknown> | undefined,
    operationName: args.operationName,
    throttleMs: live.throttleMs,
    tenantKey: ctx.tenantKey ?? '',
    withTenant: ctx.withTenant,
    identity: ctx.liveIdentity,
    userId: String(ctx.user.id)
  })
}

export interface GraphQLStamp {
  operation: string | null
  kind: string | null
  depth: number | null
  selections: number | null
  errors: number
  /** `Type.field` names the request selected that carry @deprecated. */
  deprecated: string[]
  /** Every `Type.field` the document selects (introspection left out, capped) — the Traffic
   *  Map's field heat (#1134). Absent when the type walker could not read the document. */
  fields?: string[]
}

/** At most this many distinct `Type.field` names are kept per request for field heat. */
const SELECTED_FIELDS_CAP = 300

/** The operation a document runs (its name, else the first root field), its
 *  kind, and every @deprecated field it selects — the analytics identity of a
 *  request that always hits the one path. */
function describeOperation(
  schema: GraphQLSchema,
  document: ReturnType<typeof parse>,
  requested: string | undefined
): GraphQLStamp {
  const ops = document.definitions.filter(
    (d) => d.kind === Kind.OPERATION_DEFINITION
  ) as unknown as Array<{
    name?: { value: string }
    operation: string
    selectionSet: { selections: ReadonlyArray<{ kind: string; name?: { value: string } }> }
  }>
  const op = (requested && ops.find((o) => o.name?.value === requested)) || ops[0]
  const firstRoot = op?.selectionSet.selections.find((s) => s.kind === Kind.FIELD)?.name?.value
  const stamp: GraphQLStamp = {
    operation: (op?.name?.value ?? firstRoot ?? null)?.slice(0, 200) ?? null,
    kind: op?.operation ?? null,
    depth: null,
    selections: null,
    errors: 0,
    deprecated: []
  }
  try {
    const typeInfo = new TypeInfo(schema)
    const seen = new Set<string>()
    const selected = new Set<string>()
    visit(
      document,
      visitWithTypeInfo(typeInfo, {
        Field() {
          const def = typeInfo.getFieldDef()
          const parent = typeInfo.getParentType()
          if (!def || !parent) return
          const name = `${parent.name}.${def.name}`
          if (def.deprecationReason) seen.add(name)
          if (selected.size < SELECTED_FIELDS_CAP && !def.name.startsWith('__')) {
            if (!parent.name.startsWith('__')) selected.add(name)
          }
        }
      })
    )
    stamp.deprecated = [...seen].slice(0, 20)
    stamp.fields = [...selected]
  } catch {
    // a document the type walker cannot read still logs its operation
  }
  return stamp
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

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  type DocumentNode,
  type ExecutionArgs,
  type ExecutionResult,
  execute,
  type FieldNode,
  type GraphQLError,
  type GraphQLSchema,
  getArgumentValues,
  getOperationAST,
  getVariableValues,
  Kind,
  type OperationDefinitionNode,
  parse,
  subscribe,
  validate
} from 'graphql'
import { getTenantDb, getTenantId, getTenantSlug, runWithTenantDb } from '../db/tenant-context.js'
import { itemMutatedFilter } from '../graphql/resolvers.js'
import { authenticate } from '../middleware/authenticate.js'
import { replaySince } from '../services/event-journal.js'
import type { LiveIdentity } from '../services/live-query.js'
import { bindFromRequest, type SocketBind } from '../services/socket-access.js'
import {
  loadStreamIdentity,
  recheckStreamIdentity,
  redeemStreamTicket
} from '../services/stream-ticket.js'
import { currentTenantKey, tenantScopedRoom } from '../services/tenant-rooms.js'
import { trackSse } from '../services/traffic-taps/realtime.js'
import type { User } from '../types.js'
import type { WsContext } from './graphql.js'

/**
 * GraphQL subscriptions (and `@live` queries) over Server-Sent Events (#1749), for partners and
 * frontends whose proxies will not carry a WebSocket.
 *
 * `GET /api/graphql/stream?query=…&variables=…&operationName=…` (EventSource) or
 * `POST /api/graphql/stream` with the usual JSON body — the graphql-sse "distinct connections"
 * shape: one operation per stream, results as `event: next` (data = the execution result),
 * then `event: complete`. A query without `@live` answers once and completes; a mutation is
 * refused (use POST /api/graphql).
 *
 * Auth is the HTTP API's own: session cookie, Bearer static token, masquerade, or a named API
 * key (its scopes, row restrictions and depth cap apply). EventSource cannot send headers, so it
 * opens with `?ticket=` from `GET /api/events/ticket` — one-shot, 60s, and it remembers what
 * signed the minting request in. The stream re-checks that sign-in every heartbeat and ends
 * (`event: next` with SESSION_ENDED, then `complete`) on logout, a revoked session or key, a
 * rotated token or an inactive account. Resolvers see exactly the context a WebSocket
 * subscriber gets, so the per-subscriber checks are the same.
 *
 * Resume: `itemMutated` events carry their journal position as the SSE `id:`. A client that
 * reconnects with `Last-Event-ID` gets the events it missed replayed from the event journal
 * (same collection gate, same filters), or `event: reset` when the journal no longer reaches
 * back that far — refetch then. Other subscriptions resume live only; a live query's first
 * result after a reconnect is its whole current result anyway.
 */

/** Comment heartbeat + sign-in check interval (GRAPHQL_SSE_HEARTBEAT_MS; proxies with a short
 *  idle timeout may want it lower). */
function heartbeatMs(): number {
  const n = Number(process.env.GRAPHQL_SSE_HEARTBEAT_MS)
  return Number.isFinite(n) && n >= 50 ? n : 25_000
}
const SEQ_KEY = '_nvr_seq'

interface StreamDeps {
  getSchema: () => Promise<GraphQLSchema>
  lookupPersistedQuery: (key: { id?: unknown; hash?: string }) => Promise<string | null>
  costRefusal: (document: DocumentNode, user: User | undefined) => GraphQLError | null
  executeOrLive: (
    args: ExecutionArgs
  ) =>
    | ExecutionResult
    | Promise<ExecutionResult>
    | AsyncIterableIterator<ExecutionResult>
    | Promise<ExecutionResult | AsyncIterableIterator<ExecutionResult>>
}

interface StreamParams {
  query?: string
  variables?: Record<string, unknown>
  operationName?: string
  id?: number | string
  hash?: string
  ticket?: string
}

function readParams(req: FastifyRequest): StreamParams | string {
  if (req.method === 'GET') {
    const q = req.query as Record<string, string | undefined>
    let variables: Record<string, unknown> | undefined
    if (q.variables) {
      try {
        variables = JSON.parse(q.variables) as Record<string, unknown>
      } catch {
        return 'variables must be JSON'
      }
    }
    let hash: string | undefined
    if (q.extensions) {
      try {
        hash = (JSON.parse(q.extensions) as { persistedQuery?: { sha256Hash?: string } })
          .persistedQuery?.sha256Hash
      } catch {
        return 'extensions must be JSON'
      }
    }
    return {
      query: q.query,
      variables,
      operationName: q.operationName,
      id: q.id,
      hash,
      ticket: q.ticket
    }
  }
  const b = (req.body ?? {}) as StreamParams & {
    extensions?: { persistedQuery?: { sha256Hash?: string } }
  }
  return {
    query: b.query,
    variables: b.variables,
    operationName: b.operationName,
    id: b.id,
    hash: b.extensions?.persistedQuery?.sha256Hash,
    ticket: (req.query as { ticket?: string }).ticket
  }
}

/** Who opened the stream and what signed them in: a ticket, else the request's own auth. */
async function streamSignIn(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  ticket: string | undefined
): Promise<{ userId: string; bind: SocketBind; identity: LiveIdentity } | null> {
  if (ticket && !req.headers.authorization) {
    const minted = await redeemStreamTicket(app.redis, ticket)
    const identity = minted ? await loadStreamIdentity(minted.userId, minted.bind) : null
    return minted && identity ? { ...minted, identity } : null
  }
  try {
    await authenticate(req, reply)
  } catch {
    return null
  }
  const bind = bindFromRequest(req)
  if (!req.user || !bind) return null
  return {
    userId: String(req.user.id),
    bind,
    identity: { user: req.user, isAdmin: req.isAdmin ?? false }
  }
}

/** Re-enter the request's tenant later (cloud): delivery runs from other tenants' timers. */
function captureTenant(): (<T>(fn: () => Promise<T>) => Promise<T>) | undefined {
  const tdb = getTenantDb()
  if (!tdb) return undefined
  const slug = getTenantSlug() ?? ''
  const id = getTenantId() ?? ''
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      runWithTenantDb(tdb, slug, () => void fn().then(resolve, reject), id)
    })
}

function rootFields(op: OperationDefinitionNode): FieldNode[] {
  return op.selectionSet.selections.filter((s): s is FieldNode => s.kind === Kind.FIELD)
}

/** Read `seq` on every `itemMutated` root field, under a key the client never sees. */
function withSeqMarkers(document: DocumentNode, op: OperationDefinitionNode): DocumentNode {
  return {
    ...document,
    definitions: document.definitions.map((d) =>
      d !== op
        ? d
        : {
            ...op,
            selectionSet: {
              ...op.selectionSet,
              selections: op.selectionSet.selections.map((s) =>
                s.kind === Kind.FIELD && s.name.value === 'itemMutated' && s.selectionSet
                  ? {
                      ...s,
                      selectionSet: {
                        ...s.selectionSet,
                        selections: [
                          ...s.selectionSet.selections,
                          {
                            kind: Kind.FIELD,
                            alias: { kind: Kind.NAME, value: SEQ_KEY },
                            name: { kind: Kind.NAME, value: 'seq' }
                          } as FieldNode
                        ]
                      }
                    }
                  : s
              )
            }
          }
    )
  }
}

/** The journal position a result carries (and the result without the marker). */
function takeSeq(result: ExecutionResult): string | null {
  let seq: string | null = null
  const data = result.data as Record<string, unknown> | null | undefined
  for (const v of Object.values(data ?? {})) {
    if (v && typeof v === 'object' && SEQ_KEY in v) {
      const o = v as Record<string, unknown>
      if (o[SEQ_KEY] != null) seq = String(o[SEQ_KEY])
      delete o[SEQ_KEY]
    }
  }
  return seq
}

function isAsyncIterable(v: unknown): v is AsyncIterableIterator<ExecutionResult> {
  return !!v && typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
}

function errorBody(message: string, code: string): ExecutionResult {
  return { errors: [{ message, extensions: { code } }] as unknown as GraphQLError[] }
}

export async function graphqlSseRoutes(app: FastifyInstance, deps: StreamDeps): Promise<void> {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = readParams(req)
    if (typeof params === 'string') return reply.code(400).send({ errors: [{ message: params }] })

    const signIn = await streamSignIn(app, req, reply, params.ticket)
    if (!signIn)
      return reply.code(401).send({
        errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }]
      })

    let query = params.query
    if (!query && (params.id != null || params.hash)) {
      query =
        (await deps.lookupPersistedQuery(
          params.hash ? { hash: params.hash } : { id: params.id }
        )) ?? undefined
      if (!query)
        return reply.code(404).send({
          errors: [
            { message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }
          ]
        })
    }
    if (!query) return reply.code(400).send({ errors: [{ message: 'query is required' }] })

    const schema = await deps.getSchema()
    let document: DocumentNode
    try {
      document = parse(query)
    } catch (err) {
      return reply.code(400).send({ errors: [{ message: String(err) }] })
    }
    const validationErrors = validate(schema, document)
    if (validationErrors.length > 0) return reply.code(400).send({ errors: validationErrors })
    const op = getOperationAST(document, params.operationName)
    if (!op)
      return reply.code(400).send({ errors: [{ message: 'Unable to identify the operation' }] })
    if (op.operation === 'mutation')
      return reply.code(405).send({
        errors: [{ message: 'Send mutations to POST /api/graphql; this stream only reads' }]
      })
    const refused = deps.costRefusal(document, signIn.identity.user)
    if (refused) return reply.code(400).send({ errors: [refused] })

    // The subscriber's context — the same shape a graphql-ws connection gives the resolvers.
    const tenantKey = currentTenantKey()
    const withTenant = captureTenant()
    let last = signIn.identity
    const liveIdentity = async () => {
      const r = await recheckStreamIdentity(app.redis, signIn.userId, signIn.bind, last)
      if (r.identity) last = r.identity
      return r.identity
    }
    const contextValue: WsContext = {
      user: signIn.identity.user,
      isAdmin: signIn.identity.isAdmin,
      tenantKey,
      withTenant,
      liveIdentity
    }
    const variableValues = params.variables
    const operationName = params.operationName

    // Start the operation before answering: a refused subscription (FORBIDDEN) is one `next`
    // carrying the errors, then `complete` — as graphql-sse clients expect.
    let source: AsyncIterableIterator<ExecutionResult> | null = null
    let single: ExecutionResult | null = null
    const runDocument = op.operation === 'subscription' ? withSeqMarkers(document, op) : document
    try {
      const args: ExecutionArgs = {
        schema,
        document: runDocument,
        variableValues,
        operationName,
        contextValue
      }
      const out =
        op.operation === 'subscription' ? await subscribe(args) : await deps.executeOrLive(args)
      if (isAsyncIterable(out)) source = out
      else single = out
    } catch (err) {
      single = errorBody(err instanceof Error ? err.message : String(err), 'INTERNAL')
    }

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    trackSse(raw, 'graphql-sse')
    raw.write(': connected\n\n')

    let closed = false
    const write = (chunk: string): void => {
      if (closed) return
      try {
        raw.write(chunk)
      } catch {
        cleanup()
      }
    }
    const sendNext = (result: ExecutionResult, id?: string | null): void => {
      write(`event: next\n${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(result)}\n\n`)
    }
    const complete = (): void => {
      write('event: complete\ndata:\n\n')
      cleanup()
    }

    const heartbeat = setInterval(() => {
      if (closed) return
      void recheckStreamIdentity(app.redis, signIn.userId, signIn.bind, last).then((r) => {
        if (closed) return
        if (r.identity) {
          last = r.identity
          write(': hb\n\n')
          return
        }
        sendNext(errorBody('Your sign-in ended, so this stream stopped', 'SESSION_ENDED'))
        complete()
      })
    }, heartbeatMs())
    heartbeat.unref()

    function cleanup(): void {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      void source?.return?.()
      try {
        raw.end()
      } catch {
        /* already gone */
      }
    }
    req.raw.on('close', cleanup)
    req.raw.on('error', cleanup)

    if (single || !source) {
      sendNext(single ?? errorBody('Nothing to stream', 'INTERNAL'))
      complete()
      return
    }

    // Missed itemMutated events since Last-Event-ID, from the journal (live events that arrive
    // meanwhile wait in the subscription's own queue and are deduplicated by position).
    let replayedTo = 0
    const lastEventId = String(req.headers['last-event-id'] ?? '')
    if (op.operation === 'subscription' && /^\d+$/.test(lastEventId)) {
      replayedTo = await replayMissed({
        schema,
        document: runDocument,
        op,
        variableValues,
        operationName,
        contextValue,
        tenantKey,
        cursor: Number(lastEventId),
        send: sendNext,
        reset: () => write('event: reset\ndata: {"reason":"history_gap"}\n\n')
      }).catch(() => 0)
    }

    const stream = source
    try {
      for (;;) {
        const r = await stream.next()
        if (r.done || closed) break
        const seq = takeSeq(r.value)
        if (seq && replayedTo && Number(seq) <= replayedTo) continue
        sendNext(r.value, seq)
      }
    } catch (err) {
      sendNext(errorBody(err instanceof Error ? err.message : String(err), 'INTERNAL'))
    }
    complete()
  }

  app.get('/graphql/stream', handler)
  app.post('/graphql/stream', handler)
}

/**
 * Replay journaled collection:update events after `cursor` for the stream's itemMutated root
 * fields — through the subscription's own filters and selection (the collection read gate
 * already ran when the subscription opened). Returns the last position replayed.
 */
async function replayMissed(o: {
  schema: GraphQLSchema
  document: DocumentNode
  op: OperationDefinitionNode
  variableValues: Record<string, unknown> | undefined
  operationName: string | undefined
  contextValue: WsContext
  tenantKey: string
  cursor: number
  send: (r: ExecutionResult, id?: string | null) => void
  reset: () => void
}): Promise<number> {
  const field = o.schema.getSubscriptionType()?.getFields().itemMutated
  const roots = rootFields(o.op)
  if (!field || roots.length !== 1 || roots[0].name.value !== 'itemMutated') return 0
  const coerced = getVariableValues(
    o.schema,
    o.op.variableDefinitions ?? [],
    o.variableValues ?? {}
  )
  if (coerced.errors) return 0
  const args = getArgumentValues(field, roots[0], coerced.coerced) as {
    collection?: string
    item?: string
    fields?: string[]
    actions?: string[]
  }
  if (!args.collection) return 0
  const passes = itemMutatedFilter(args)
  const room = tenantScopedRoom(`collection:${args.collection}`, o.tenantKey)
  const { full, events } = await replaySince(o.cursor, new Set([room]))
  if (full) {
    o.reset()
    return 0
  }
  let last = 0
  for (const e of events) {
    if (e.event !== 'collection:update') continue
    const p = e.payload as {
      item?: unknown
      action?: 'create' | 'update' | 'delete'
      changed_fields?: string[]
    }
    if (!p.action || p.item == null) continue
    const item = String(p.item)
    // One record's subscription hears that record only (a bulk '*' goes to the collection's).
    if (args.item != null && item !== String(args.item)) continue
    const ev = {
      collection: args.collection,
      item,
      action: p.action,
      changed_fields: Array.isArray(p.changed_fields) ? p.changed_fields : []
    }
    if (passes && !passes(ev)) continue
    const result = (await execute({
      schema: o.schema,
      document: o.document,
      variableValues: o.variableValues,
      operationName: o.operationName,
      contextValue: o.contextValue,
      rootValue: { itemMutated: { ...ev, at: null, seq: String(e.seq), data: null } }
    })) as ExecutionResult
    takeSeq(result)
    o.send(result, String(e.seq))
    last = e.seq
  }
  return last
}

import Fastify, { type FastifyInstance } from 'fastify'
import {
  GraphQLID,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse,
  specifiedDirectives
} from 'graphql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: Record<string, any>) => {
    const h = req.headers.authorization as string | undefined
    if (h === 'Bearer nvk_partner') {
      req.user = { id: 'KEYUSER', role: 'R' }
      req.isAdmin = false
      req.authMethod = 'api_key'
      req.apiKeyId = 7
      return
    }
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  })
}))
vi.mock('../../../services/stream-ticket.js', () => ({
  redeemStreamTicket: vi.fn(async () => null),
  loadStreamIdentity: vi.fn(async () => null),
  recheckStreamIdentity: vi.fn(async (_r: unknown, _u: unknown, _b: unknown, last: unknown) => ({
    identity: last,
    reason: null
  }))
}))
vi.mock('../../../services/event-journal.js', () => ({
  replaySince: vi.fn(async () => ({ full: false, events: [] }))
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/permissions.js')>()),
  can: vi.fn(async () => true)
}))

import { runWithTenantDb } from '../../../db/tenant-context.js'
import { pubsub, topics } from '../../../graphql/pubsub.js'
import { domainSubscriptionFields } from '../../../graphql/resolvers.js'
import { executeOrLive } from '../../../plugins/graphql.js'
import { graphqlSseRoutes } from '../../../plugins/graphql-sse.js'
import { replaySince } from '../../../services/event-journal.js'
import { LiveDirective } from '../../../services/live-query.js'
import {
  loadStreamIdentity,
  recheckStreamIdentity,
  redeemStreamTicket
} from '../../../services/stream-ticket.js'

const ordersType = new GraphQLObjectType({
  name: 'orders',
  fields: { id: { type: GraphQLID }, status: { type: GraphQLString } }
})
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      orders: {
        type: new GraphQLList(ordersType),
        resolve: (_r, _a, ctx: { user?: { id: string } }) => [{ id: '1', status: ctx.user?.id }]
      }
    }
  }),
  mutation: new GraphQLObjectType({
    name: 'Mutation',
    fields: { touch: { type: GraphQLString, resolve: () => 'x' } }
  }),
  subscription: new GraphQLObjectType({
    name: 'Subscription',
    fields: { itemMutated: domainSubscriptionFields.itemMutated }
  }),
  directives: [...specifiedDirectives, LiveDirective]
})

let app: FastifyInstance
beforeEach(async () => {
  app = Fastify()
  app.decorate('redis', {} as never)
  await graphqlSseRoutes(app, {
    getSchema: async () => schema,
    lookupPersistedQuery: async () => null,
    costRefusal: () => null,
    executeOrLive
  })
  await app.ready()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.mocked(recheckStreamIdentity).mockReset()
  vi.mocked(recheckStreamIdentity).mockImplementation(async (_r, _u, _b, last) => ({
    identity: last,
    reason: null
  }))
  vi.mocked(replaySince).mockReset()
  vi.mocked(replaySince).mockResolvedValue({ full: false, events: [] })
  await app.close()
})

const SUB = 'subscription { itemMutated(collection: "orders") { item action } }'
const auth = { authorization: 'Bearer nvk_partner' }

function events(body: string) {
  return body
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => {
      const lines = b.split('\n')
      const get = (k: string) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2)
      const data = lines
        .find((l) => l.startsWith('data:'))
        ?.slice(5)
        .trim()
      return { event: get('event'), id: get('id'), data: data ? JSON.parse(data) : null }
    })
}

/** End the stream at its second sign-in check (the key was revoked). */
function revokeAfterFirstCheck() {
  vi.stubEnv('GRAPHQL_SSE_HEARTBEAT_MS', '60')
  let calls = 0
  vi.mocked(recheckStreamIdentity).mockImplementation(async (_r, _u, _b, last) =>
    ++calls >= 2 ? { identity: null, reason: 'key_revoked' } : { identity: last, reason: null }
  )
}

function publishSoon(fn: () => void, ms = 20) {
  setTimeout(fn, ms)
}

describe('GraphQL over SSE (#1749)', () => {
  it('answers a query once (next, complete) with the HTTP auth (an API key)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/graphql/stream?query=${encodeURIComponent('{ orders { id status } }')}`,
      headers: auth
    })
    expect(res.headers['content-type']).toBe('text/event-stream')
    const ev = events(res.body)
    expect(ev.map((e) => e.event)).toEqual(['next', 'complete'])
    expect(ev[0].data).toEqual({ data: { orders: [{ id: '1', status: 'KEYUSER' }] } })
  })

  it('refuses the unauthenticated, mutations and bad documents with an HTTP status', async () => {
    const q = encodeURIComponent('{ orders { id } }')
    expect(
      (await app.inject({ method: 'GET', url: `/graphql/stream?query=${q}` })).statusCode
    ).toBe(401)
    const m = await app.inject({
      method: 'POST',
      url: '/graphql/stream',
      headers: auth,
      payload: { query: 'mutation { touch }' }
    })
    expect(m.statusCode).toBe(405)
    const bad = await app.inject({
      method: 'POST',
      url: '/graphql/stream',
      headers: auth,
      payload: { query: '{ nope }' }
    })
    expect(bad.statusCode).toBe(400)
  })

  it('opens with a one-shot ticket (EventSource) and nothing else', async () => {
    const q = encodeURIComponent('{ orders { status } }')
    const t = '11111111-2222-3333-4444-555555555555'
    expect(
      (await app.inject({ method: 'GET', url: `/graphql/stream?query=${q}&ticket=${t}` }))
        .statusCode
    ).toBe(401)
    vi.mocked(redeemStreamTicket).mockResolvedValueOnce({
      userId: 'TICKETUSER',
      bind: { kind: 'session', sid: 's1' }
    })
    vi.mocked(loadStreamIdentity).mockResolvedValueOnce({
      user: { id: 'TICKETUSER', role: 'R' } as never,
      isAdmin: false
    })
    const res = await app.inject({ method: 'GET', url: `/graphql/stream?query=${q}&ticket=${t}` })
    expect(events(res.body)[0].data).toEqual({ data: { orders: [{ status: 'TICKETUSER' }] } })
  })

  it('streams itemMutated with the journal position as the id; an API key revoked mid-stream ends it', async () => {
    revokeAfterFirstCheck()
    publishSoon(() =>
      pubsub.publish(topics.itemMutated('orders', '*', ''), {
        itemMutated: {
          collection: 'orders',
          item: '5',
          action: 'update',
          changed_fields: ['status'],
          seq: '41',
          data: null
        }
      })
    )
    const res = await app.inject({
      method: 'POST',
      url: '/graphql/stream',
      headers: auth,
      payload: { query: SUB }
    })
    const ev = events(res.body)
    expect(ev[0]).toEqual({
      event: 'next',
      id: '41',
      data: { data: { itemMutated: { item: '5', action: 'update' } } }
    })
    expect(ev[1].data.errors[0].extensions.code).toBe('SESSION_ENDED')
    expect(ev[2].event).toBe('complete')
    expect(res.body).not.toContain('_nvr_seq')
  })

  it('replays what Last-Event-ID missed, through the same filters, without duplicates', async () => {
    revokeAfterFirstCheck()
    vi.mocked(replaySince).mockResolvedValueOnce({
      full: false,
      events: [
        {
          seq: 10,
          room: 'collection:orders',
          event: 'collection:update',
          payload: { collection: 'orders', item: '3', action: 'update', changed_fields: ['status'] }
        },
        {
          seq: 11,
          room: 'collection:orders',
          event: 'collection:update',
          payload: { collection: 'orders', item: '4', action: 'create' }
        }
      ]
    })
    const live = (item: string, seq: string) =>
      pubsub.publish(topics.itemMutated('orders', '*', ''), {
        itemMutated: {
          collection: 'orders',
          item,
          action: 'update',
          changed_fields: [],
          seq,
          data: null
        }
      })
    publishSoon(() => {
      live('3', '10') // already replayed
      live('6', '12')
    })
    const res = await app.inject({
      method: 'POST',
      url: '/graphql/stream',
      headers: { ...auth, 'last-event-id': '9' },
      payload: {
        query:
          'subscription { itemMutated(collection: "orders", actions: ["update"]) { item action } }'
      }
    })
    expect(vi.mocked(replaySince).mock.calls[0][0]).toBe(9)
    expect([...vi.mocked(replaySince).mock.calls[0][1]]).toEqual(['collection:orders'])
    const nexts = events(res.body).filter((e) => e.event === 'next' && e.id)
    expect(nexts.map((e) => [e.id, e.data.data.itemMutated.item])).toEqual([
      ['10', '3'],
      ['12', '6']
    ])
  })

  it('says reset when the journal no longer reaches back to Last-Event-ID', async () => {
    revokeAfterFirstCheck()
    vi.mocked(replaySince).mockResolvedValueOnce({ full: true, events: [] })
    const res = await app.inject({
      method: 'POST',
      url: '/graphql/stream',
      headers: { ...auth, 'last-event-id': '1' },
      payload: { query: SUB }
    })
    expect(events(res.body).map((e) => e.event)).toContain('reset')
  })

  it('a stream opened in tenant A hears tenant A only', async () => {
    revokeAfterFirstCheck()
    publishSoon(() => {
      pubsub.publish(topics.itemMutated('orders', '*', 'B'), {
        itemMutated: { collection: 'orders', item: 'b', action: 'update', changed_fields: [] }
      })
      pubsub.publish(topics.itemMutated('orders', '*', 'A'), {
        itemMutated: { collection: 'orders', item: 'a', action: 'update', changed_fields: [] }
      })
    })
    const res = await new Promise<{ body: string }>((resolve, reject) => {
      runWithTenantDb(
        {} as never,
        'tenant-a',
        () => {
          app
            .inject({
              method: 'POST',
              url: '/graphql/stream',
              headers: auth,
              payload: { query: SUB }
            })
            .then(resolve, reject)
        },
        'A'
      )
    })
    const items = events(res.body)
      .filter((e) => e.data?.data?.itemMutated)
      .map((e) => e.data.data.itemMutated.item)
    expect(items).toEqual(['a'])
  })

  it('a @live query streams its result and re-runs as the subscriber on a write', async () => {
    revokeAfterFirstCheck()
    vi.stubEnv('GRAPHQL_SSE_HEARTBEAT_MS', '200')
    publishSoon(() =>
      pubsub.publish(topics.itemMutated('orders', '*', ''), {
        itemMutated: { collection: 'orders', item: '1', action: 'update', changed_fields: [] }
      })
    )
    const res = await app.inject({
      method: 'POST',
      url: '/graphql/stream',
      headers: auth,
      payload: { query: 'query @live(throttle: 100) { orders { id status } }' }
    })
    const ev = events(res.body)
    expect(ev[0].data).toEqual({
      data: { orders: [{ id: '1', status: 'KEYUSER' }] },
      extensions: { live: { revision: 1 } }
    })
    // Same data on the re-run: nothing re-sent; the stream ends with the revoked key.
    expect(ev.slice(1).map((e) => e.data?.errors?.[0]?.extensions?.code ?? e.event)).toEqual([
      'SESSION_ENDED',
      'complete'
    ])
  })
})

describe('graphql-ws / stream execution refuses mutations (post-mortem 3.3 review)', () => {
  it('answers a mutation with the POST /api/graphql message and never runs it', async () => {
    const touched = vi.fn(() => 'x')
    const s = new GraphQLSchema({
      query: new GraphQLObjectType({ name: 'Q', fields: { a: { type: GraphQLString } } }),
      mutation: new GraphQLObjectType({
        name: 'M',
        fields: { touch: { type: GraphQLString, resolve: touched } }
      })
    })
    const r = (await executeOrLive({
      schema: s,
      document: parse('mutation { touch }'),
      contextValue: { user: { id: 'u' } }
    })) as { errors?: Array<{ message: string }> }
    expect(r.errors?.[0]?.message).toBe(
      'Send mutations to POST /api/graphql; this stream only reads'
    )
    expect(touched).not.toHaveBeenCalled()
    // A document with a query and a mutation: the chosen operation decides.
    const q = (await executeOrLive({
      schema: s,
      document: parse('query Read { a } mutation Write { touch }'),
      operationName: 'Read',
      contextValue: { user: { id: 'u' } }
    })) as { errors?: unknown[] }
    expect(q.errors).toBeUndefined()
  })
})

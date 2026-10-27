import Fastify, { type FastifyInstance } from 'fastify'
import { type Client, createClient } from 'graphql-ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

const state = vi.hoisted(() => ({ status: 'open' }))

vi.mock('../../../services/schema-builder.js', async () => {
  const g = await import('graphql')
  const lq = await import('../../../services/live-query.js')
  const orders = new g.GraphQLObjectType({
    name: 'orders',
    fields: { id: { type: g.GraphQLID }, status: { type: g.GraphQLString } }
  })
  const schema = new g.GraphQLSchema({
    query: new g.GraphQLObjectType({
      name: 'Query',
      fields: {
        orders: {
          type: new g.GraphQLList(orders),
          resolve: (_r: unknown, _a: unknown, ctx: { user?: { id: string } }) => [
            { id: '1', status: `${state.status}:${ctx.user?.id}` }
          ]
        }
      }
    }),
    directives: [...g.specifiedDirectives, lq.LiveDirective]
  })
  lq.setLiveTypes(schema, new Map([['orders', { collections: ['orders'], any: false }]]))
  return { buildGraphQLSchema: async () => schema }
})
vi.mock('../../../services/api-changelog.js', () => ({ recordGraphQLSchema: vi.fn() }))
vi.mock('../../../services/socket-access.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/socket-access.js')>()),
  checkBind: vi.fn(async () => null)
}))
vi.mock('../../../services/stream-ticket.js', () => ({
  redeemStreamTicket: vi.fn(async () => ({ userId: 'U1', bind: { kind: 'apikey', id: 7 } })),
  loadStreamIdentity: vi.fn(async () => ({ user: { id: 'U1', role: 'R' }, isAdmin: false })),
  recheckStreamIdentity: vi.fn(async (_r: unknown, _u: unknown, _b: unknown, last: unknown) => ({
    identity: last,
    reason: null
  }))
}))

import { pubsub, topics } from '../../../graphql/pubsub.js'
import { graphqlPlugin } from '../../../plugins/graphql.js'
import { checkBind } from '../../../services/socket-access.js'
import { recheckStreamIdentity, redeemStreamTicket } from '../../../services/stream-ticket.js'

let app: FastifyInstance
let url = ''
const clients: Client[] = []

beforeEach(async () => {
  state.status = 'open'
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(graphqlPlugin, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as { port: number }
  url = `ws://127.0.0.1:${addr.port}/api/graphql-ws`
})

afterEach(async () => {
  for (const c of clients.splice(0)) await c.dispose()
  vi.unstubAllEnvs()
  vi.mocked(checkBind).mockResolvedValue(null)
  await app.close()
})

function client(params: Record<string, unknown>, onClose?: (code: number) => void) {
  const c = createClient({
    url,
    webSocketImpl: WebSocket,
    connectionParams: params,
    retryAttempts: 0,
    lazy: true,
    on: onClose ? { closed: (e) => onClose((e as { code: number }).code) } : undefined
  })
  clients.push(c)
  return c
}

function collect(c: Client, query: string) {
  const got: unknown[] = []
  let done = false
  c.subscribe(
    { query },
    {
      next: (v) => got.push(v),
      error: (e) => got.push({ error: e }),
      complete: () => {
        done = true
      }
    }
  )
  return { got, isDone: () => done }
}

async function until(fn: () => boolean, ms = 2000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('live queries over graphql-ws (#2126) with a ticket sign-in (#1749)', () => {
  it('sends the result, re-runs as the subscriber on a write, ends when the key is revoked', async () => {
    const c = client({ ticket: '11111111-2222-3333-4444-555555555555' })
    const sub = collect(c, 'query @live(throttle: 100) { orders { id status } }')
    await until(() => sub.got.length === 1)
    expect(sub.got[0]).toEqual({
      data: { orders: [{ id: '1', status: 'open:U1' }] },
      extensions: { live: { revision: 1 } }
    })
    expect(redeemStreamTicket).toHaveBeenCalledTimes(1)

    state.status = 'closed'
    pubsub.publish(topics.itemMutated('orders', '*', ''), {
      itemMutated: { collection: 'orders', item: '1', action: 'update', changed_fields: [] }
    })
    await until(() => sub.got.length === 2)
    expect(sub.got[1]).toMatchObject({ data: { orders: [{ status: 'closed:U1' }] } })

    vi.mocked(recheckStreamIdentity).mockResolvedValueOnce({
      identity: null,
      reason: 'key_revoked'
    })
    state.status = 'later'
    pubsub.publish(topics.itemMutated('orders', '*', ''), {
      itemMutated: { collection: 'orders', item: '1', action: 'update', changed_fields: [] }
    })
    await until(() => sub.isDone())
    expect(sub.got[2]).toMatchObject({ errors: [{ extensions: { code: 'SESSION_ENDED' } }] })
    expect(JSON.stringify(sub.got)).not.toContain('later')
  })

  it('closes the connection (4401) when its sign-in ends, even with nothing to deliver', async () => {
    vi.stubEnv('GRAPHQL_WS_SIGNIN_CHECK_MS', '60')
    let closedWith = 0
    const c = client({ ticket: '11111111-2222-3333-4444-555555555555' }, (code) => {
      closedWith = code
    })
    const sub = collect(c, 'query @live { orders { id } }')
    await until(() => sub.got.length === 1)
    vi.mocked(checkBind).mockResolvedValue('key_revoked')
    await until(() => closedWith !== 0)
    expect(closedWith).toBe(4401)
  })

  it('a connection without a usable sign-in is refused (4403) and runs nothing (M8)', async () => {
    vi.mocked(redeemStreamTicket).mockResolvedValueOnce(null)
    let closedWith = 0
    const c = client({ ticket: '11111111-2222-3333-4444-555555555555' }, (code) => {
      closedWith = code
    })
    const sub = collect(c, 'query @live { orders { id } }')
    await until(() => closedWith !== 0)
    expect(closedWith).toBe(4403)
    expect(sub.got.some((g) => (g as { data?: unknown }).data)).toBe(false)
  })
})

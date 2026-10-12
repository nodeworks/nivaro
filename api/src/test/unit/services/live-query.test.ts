import {
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse,
  specifiedDirectives,
  validate
} from 'graphql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pubsub, topics } from '../../../graphql/pubsub.js'
import {
  eventTouches,
  LiveDirective,
  type LiveIdentity,
  liveOperation,
  liveQuery,
  liveQueryStats,
  planLiveQuery,
  setLiveTypes,
  touchedIds
} from '../../../services/live-query.js'

// ── A two-collection schema whose resolvers read AS the context user ────────
interface Order {
  id: string
  status: string
  customer: string
}
const store: { orders: Order[]; customers: Array<{ id: string; name: string }> } = {
  orders: [],
  customers: []
}
/** Which users may read orders (the "role" a re-run is checked against). */
const readers = new Set<string>()
const seenBy: string[] = []

type Ctx = { user?: { id: string } }
const readOrders = (ctx: Ctx) => {
  seenBy.push(String(ctx.user?.id))
  if (!ctx.user || !readers.has(ctx.user.id))
    throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } })
  return store.orders
}

const customersType = new GraphQLObjectType({
  name: 'customers',
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } }
})
const ordersType = new GraphQLObjectType({
  name: 'orders',
  fields: {
    id: { type: GraphQLID },
    status: { type: GraphQLString },
    customer: {
      type: customersType,
      resolve: (o: Order) => store.customers.find((c) => c.id === o.customer) ?? null
    }
  }
})
const customersFilter = new GraphQLInputObjectType({
  name: 'customers_filter',
  fields: { name: { type: GraphQLString } }
})
const ordersFilter = new GraphQLInputObjectType({
  name: 'orders_filter',
  fields: () => ({ status: { type: GraphQLString }, customer: { type: customersFilter } })
})
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      orders: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ordersType))),
        args: { filter: { type: ordersFilter } },
        resolve: (_r, _a, ctx: Ctx) => readOrders(ctx)
      },
      customers_by_id: {
        type: customersType,
        args: { id: { type: new GraphQLNonNull(GraphQLID) } },
        resolve: (_r, a: { id: string }) => store.customers.find((c) => c.id === a.id) ?? null
      }
    }
  }),
  directives: [...specifiedDirectives, LiveDirective]
})
setLiveTypes(
  schema,
  new Map([
    ['orders', { collections: ['orders'], any: false }],
    ['customers', { collections: ['customers'], any: false }],
    ['orders_filter', { collections: ['orders'], any: true }],
    ['customers_filter', { collections: ['customers'], any: true }]
  ])
)

const ana = { id: 'ANA', role: 'R' } as never
const identityOf =
  (who: { current: LiveIdentity | null }) => async (): Promise<LiveIdentity | null> =>
    who.current

// A timed-out next() stays pending on the iterator: the following call must await the SAME
// promise, or the result it was waiting for is handed to the abandoned one.
const pending = new WeakMap<object, Promise<IteratorResult<unknown>>>()
async function nextWithin<T>(it: AsyncIterableIterator<T>, ms = 1000): Promise<T | 'timeout'> {
  let p = pending.get(it) as Promise<IteratorResult<T>> | undefined
  if (!p) {
    p = it.next()
    pending.set(it, p)
  }
  const r = await Promise.race([
    p,
    new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), ms))
  ])
  if (r === 'timeout') return r
  pending.delete(it)
  return r.done ? ('done' as never) : r.value
}

function writeEvent(collection: string, item: string, tenant = '') {
  pubsub.publish(topics.itemMutated(collection, '*', tenant), {
    itemMutated: { collection, item, action: 'update', changed_fields: ['status'] }
  })
}

beforeEach(() => {
  store.orders = [{ id: '1', status: 'open', customer: 'C1' }]
  store.customers = [
    { id: 'C1', name: 'Acme' },
    { id: 'C2', name: 'Other' }
  ]
  readers.clear()
  readers.add('ANA')
  seenBy.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('what a live query reads', () => {
  it('reads @live and its throttle; non-live and mutations are not live', () => {
    expect(liveOperation(parse('query @live { orders { id } }'), null)).toEqual({
      throttleMs: 500
    })
    expect(
      liveOperation(parse('query Q($t: Int) @live(throttle: $t) { orders { id } }'), 'Q', {
        t: 5
      })
    ).toEqual({ throttleMs: 100 })
    expect(liveOperation(parse('{ orders { id } }'), null)).toBeNull()
    expect(validate(schema, parse('query @live(throttle: 1000) { orders { id } }'))).toEqual([])
  })

  it('lists and filters are read as a whole; a by-id read only by its ids', () => {
    const plan = planLiveQuery(
      schema,
      parse(
        'query @live { orders(filter: {customer: {name: "Acme"}}) { status } customers_by_id(id: "C2") { name } }'
      )
    )
    expect([...plan.anyCollections].sort()).toEqual(['customers', 'orders'])
    expect([...(plan.argIds.get('customers') ?? [])]).toEqual(['c2'])
    const noFilter = planLiveQuery(schema, parse('query @live { orders { customer { name } } }'))
    expect([...noFilter.anyCollections]).toEqual(['orders'])
  })

  it('marks record objects, collects their ids and strips the markers', () => {
    const plan = planLiveQuery(schema, parse('query @live { orders { customer { name } } }'))
    const data = {
      orders: [
        {
          _nvr_live_t: 'orders',
          _nvr_live_id: '1',
          customer: { _nvr_live_t: 'customers', _nvr_live_id: 'C1', name: 'Acme' }
        }
      ]
    }
    const touched = touchedIds(data, plan.recordTypes)
    expect(data).toEqual({ orders: [{ customer: { name: 'Acme' } }] })
    expect([...(touched.get('customers') ?? [])]).toEqual(['c1'])
    expect(eventTouches(plan, touched, { collection: 'customers', item: 'C1' })).toBe(true)
    expect(eventTouches(plan, touched, { collection: 'customers', item: 'C2' })).toBe(false)
    expect(eventTouches(plan, touched, { collection: 'customers', item: '*' })).toBe(true)
    expect(eventTouches(plan, touched, { collection: 'orders', item: '99' })).toBe(true)
    expect(eventTouches(plan, touched, { collection: 'invoices', item: '1' })).toBe(false)
  })
})

describe('liveQuery', () => {
  const open = (
    who: { current: LiveIdentity | null },
    query = 'query @live(throttle: 100) { orders { id status customer { name } } }',
    tenantKey = 'A'
  ) =>
    liveQuery({
      schema,
      document: parse(query),
      throttleMs: 100,
      tenantKey,
      identity: identityOf(who),
      userId: 'ANA'
    })

  it('sends the result, then a new one when a write touches what it read — as the subscriber', async () => {
    const who = { current: { user: ana, isAdmin: false } }
    const it = open(who)
    const first = (await nextWithin(it)) as { data: unknown; extensions: unknown }
    expect(first.data).toEqual({
      orders: [{ id: '1', status: 'open', customer: { name: 'Acme' } }]
    })
    expect(first.extensions).toEqual({ live: { revision: 1 } })

    store.orders[0].status = 'closed'
    writeEvent('orders', '1', 'A')
    const second = (await nextWithin(it)) as { data: { orders: Order[] } }
    expect(second.data.orders[0].status).toBe('closed')
    // Every run read as ANA, never as whoever wrote.
    expect(new Set(seenBy)).toEqual(new Set(['ANA']))
    await it.return?.()
  })

  it("hears its own tenant's writes only", async () => {
    const it = open({ current: { user: ana, isAdmin: false } })
    await nextWithin(it)
    store.orders[0].status = 'closed'
    writeEvent('orders', '1', 'B')
    writeEvent('orders', '1', '')
    expect(await nextWithin(it, 300)).toBe('timeout')
    await it.return?.()
  })

  it('a change to a record it did not read does not re-run it; an unchanged result is not re-sent', async () => {
    const it = open(
      { current: { user: ana, isAdmin: false } },
      'query @live { customers_by_id(id: "C1") { name } }'
    )
    await nextWithin(it)
    writeEvent('customers', 'C2', 'A')
    expect(await nextWithin(it, 300)).toBe('timeout')
    writeEvent('customers', 'C1', 'A') // touched, but nothing changed
    expect(await nextWithin(it, 300)).toBe('timeout')
    store.customers[0].name = 'Acme 2'
    writeEvent('customers', 'C1', 'A')
    expect(await nextWithin(it)).toMatchObject({ data: { customers_by_id: { name: 'Acme 2' } } })
    await it.return?.()
  })

  it('coalesces a burst of writes into one re-run', async () => {
    const it = open({ current: { user: ana, isAdmin: false } })
    await nextWithin(it)
    const before = seenBy.length
    for (let i = 0; i < 5; i++) {
      store.orders[0].status = `s${i}`
      writeEvent('orders', '1', 'A')
    }
    const r = (await nextWithin(it)) as { data: { orders: Order[] } }
    expect(r.data.orders[0].status).toBe('s4')
    expect(seenBy.length - before).toBe(1)
    await it.return?.()
  })

  it('a subscriber who loses access stops getting results', async () => {
    const it = open({ current: { user: ana, isAdmin: false } })
    await nextWithin(it)
    readers.delete('ANA')
    store.orders[0].status = 'secret'
    writeEvent('orders', '1', 'A')
    const r = (await nextWithin(it)) as { data: unknown; errors: GraphQLError[] }
    expect(r.data).toBeNull()
    expect(r.errors[0].extensions.code).toBe('FORBIDDEN')
    expect(JSON.stringify(r)).not.toContain('secret')
    await it.return?.()
  })

  it('ends with SESSION_ENDED when the sign-in ends (a revoked API key)', async () => {
    const who: { current: LiveIdentity | null } = { current: { user: ana, isAdmin: false } }
    const it = open(who)
    await nextWithin(it)
    who.current = null
    writeEvent('orders', '1', 'A')
    const r = (await nextWithin(it)) as { errors: GraphQLError[] }
    expect(r.errors[0].extensions.code).toBe('SESSION_ENDED')
    expect(await nextWithin(it)).toBe('done')
    expect(liveQueryStats().total).toBe(0)
  })

  it('a quiet live query still ends with its sign-in (periodic re-check)', async () => {
    vi.stubEnv('LIVE_QUERY_RECHECK_MS', '50')
    const who: { current: LiveIdentity | null } = { current: { user: ana, isAdmin: false } }
    const it = open(who)
    await nextWithin(it)
    who.current = null
    const r = (await nextWithin(it)) as { errors: GraphQLError[] }
    expect(r.errors[0].extensions.code).toBe('SESSION_ENDED')
    expect(await nextWithin(it)).toBe('done')
  })

  it('caps live queries per person and frees the slot on close', async () => {
    vi.stubEnv('LIVE_QUERY_MAX_PER_USER', '1')
    const who = { current: { user: ana, isAdmin: false } }
    const a = open(who)
    await nextWithin(a)
    const b = open(who)
    const refused = (await nextWithin(b)) as { errors: GraphQLError[] }
    expect(refused.errors[0].extensions.code).toBe('LIVE_QUERY_LIMIT')
    expect(await nextWithin(b)).toBe('done')
    await a.return?.()
    expect(liveQueryStats().total).toBe(0)
    const c = open(who)
    expect(await nextWithin(c)).toMatchObject({ data: { orders: [{ id: '1' }] } })
    await c.return?.()
  })

  it('stops listening once closed', async () => {
    const it = open({ current: { user: ana, isAdmin: false } })
    await nextWithin(it)
    await it.return?.()
    const runs = seenBy.length
    writeEvent('orders', '1', 'A')
    await new Promise((r) => setTimeout(r, 250))
    expect(seenBy.length).toBe(runs)
    expect(await it.next()).toEqual({ value: undefined, done: true })
  })
})

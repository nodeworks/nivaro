import { buildSchema } from 'graphql'
import { describe, expect, it } from 'vitest'
import {
  bodyWrites,
  buildRelationIndex,
  filterPaths,
  graphqlDocumentOf,
  graphqlUsage,
  normalizeEndpoint,
  resolveDotted,
  restUsage
} from '../../../services/partner-usage.js'

const rel = buildRelationIndex([
  // orders.customer → customers (M2O), customers.orders (O2M alias)
  {
    many_collection: 'orders',
    many_field: 'customer',
    one_collection: 'customers',
    one_field: 'orders',
    junction_field: null
  },
  // orders.lines (O2M)
  {
    many_collection: 'order_lines',
    many_field: 'order',
    one_collection: 'orders',
    one_field: 'lines',
    junction_field: null
  },
  // orders.tags (M2M via orders_tags)
  {
    many_collection: 'orders_tags',
    many_field: 'orders_id',
    one_collection: 'orders',
    one_field: 'tags',
    junction_field: 'tag'
  },
  {
    many_collection: 'orders_tags',
    many_field: 'tag',
    one_collection: 'tags',
    one_field: null,
    junction_field: 'orders_id'
  }
])

const pairs = (us: Array<{ collection: string; field: string; mode: string }>) =>
  us.map((u) => `${u.mode}:${u.collection}.${u.field}`).sort()

describe('partner usage — REST', () => {
  it('normalizes ids out of endpoints, never the collection', () => {
    expect(normalizeEndpoint('/api/items/orders/42')).toBe('/api/items/orders/{id}')
    expect(normalizeEndpoint('/items/orders/5f1b2c3d-1111-2222-3333-444455556666')).toBe(
      '/api/items/orders/{id}'
    )
    expect(normalizeEndpoint('/api/queues/5F1B2C3D-1111-2222-3333-444455556666/items')).toBe(
      '/api/queues/{id}/items'
    )
    expect(normalizeEndpoint('/graphql')).toBe('/api/graphql')
  })

  it('walks dotted paths through M2O, O2M and M2M (junction leg skipped)', () => {
    expect(pairs(resolveDotted(rel, 'orders', 'customer.name', 'read', 'rest'))).toEqual([
      'read:customers.name',
      'read:orders.customer'
    ])
    expect(pairs(resolveDotted(rel, 'orders', 'tags.tag.label', 'read', 'rest'))).toEqual([
      'read:orders.tags',
      'read:tags.label'
    ])
    expect(pairs(resolveDotted(rel, 'orders', 'id);drop', 'read', 'rest'))).toEqual([])
  })

  it('reads fields, sort, filter and conditions from a list query string', () => {
    const q =
      'fields=id,customer.name&sort=-total&filter=' +
      encodeURIComponent(JSON.stringify({ _and: [{ status: { _eq: 'open' } }] })) +
      '&conditions=' +
      encodeURIComponent(JSON.stringify([{ path: ['lines', 'sku'], op: '_eq', value: 'x' }]))
    const r = restUsage(rel, 'GET', '/api/items/orders', q, null)
    expect(r.collection).toBe('orders')
    expect(pairs(r.usages)).toEqual([
      'read:customers.name',
      'read:order_lines.sku',
      'read:orders.customer',
      'read:orders.id',
      'read:orders.lines',
      'read:orders.status',
      'read:orders.total'
    ])
  })

  it('a record read with no field list reads everything', () => {
    const r = restUsage(rel, 'GET', '/api/items/orders/9', null, null)
    expect(pairs(r.usages)).toEqual(['read:orders.*'])
  })

  it('an aggregate read names only its fields, not its figure sorts', () => {
    const r = restUsage(
      rel,
      'GET',
      '/api/items/orders/aggregate',
      'groupBy=status&sum=total&sort=-sum.total',
      null
    )
    expect(pairs(r.usages)).toEqual(['read:orders.status', 'read:orders.total'])
  })

  it('write bodies give their keys, recursing into nested O2M rows', () => {
    const body = JSON.stringify({
      total: 5,
      _change_reason: 'x',
      lines: [{ sku: 'a', qty: 1 }],
      tags: [1, 2]
    })
    expect(pairs(restUsage(rel, 'POST', '/api/items/orders', null, body).usages)).toEqual([
      'write:order_lines.qty',
      'write:order_lines.sku',
      'write:orders.lines',
      'write:orders.tags',
      'write:orders.total'
    ])
    expect(
      pairs(
        restUsage(rel, 'POST', '/api/items/orders/bulk', null, JSON.stringify({ rows: [{ a: 1 }] }))
          .usages
      )
    ).toEqual(['write:orders.a'])
    expect(pairs(bodyWrites(rel, 'orders', { lines: { create: [{ sku: 'z' }] } }, 'rest'))).toEqual(
      ['write:order_lines.sku', 'write:orders.lines']
    )
  })

  it('filter paths skip operators and relation wrappers', () => {
    expect(
      filterPaths({
        _or: [{ customer: { name: { _eq: 'a' } } }, { tags: { _some: { label: { _in: ['x'] } } } }],
        $state: { _in: ['open'] }
      }).sort()
    ).toEqual(['customer.name', 'tags.label'])
  })
})

describe('partner usage — GraphQL', () => {
  const schema = buildSchema(`
    scalar JSON
    input orders_filter { status: StringFilter, customer: customers_filter }
    input customers_filter { name: StringFilter }
    input StringFilter { _eq: String }
    type customers { id: ID, name: String }
    type tags { id: ID, label: String }
    type orders_tags_m2m { id: ID, tag: tags, label: String }
    type orders { id: ID, total: Float, customer: customers, tags: [orders_tags_m2m] }
    type Query { orders(filter: orders_filter, sort: [String]): [orders] }
    type Mutation { create_orders_item(data: JSON): orders, delete_orders_item(id: ID): Boolean }
  `)
  const collections = new Set(['orders', 'customers', 'tags', 'orders_tags'])

  it('maps selections, filters, sorts and M2M row types to collections', () => {
    const u = graphqlUsage(schema, rel, collections, {
      query: `query Mine($f: orders_filter) { orders(filter: $f, sort: ["-total"]) { id customer { name } tags { tag { label } label } } }`,
      variables: { f: { customer: { name: { _eq: 'A' } } } }
    })
    expect(u?.operation).toBe('Mine')
    expect(u?.kind).toBe('query')
    expect(u?.rootFields).toEqual(['orders'])
    expect(pairs(u?.usages ?? [])).toEqual([
      'read:customers.name',
      'read:customers.name',
      'read:orders.customer',
      'read:orders.customer',
      'read:orders.id',
      'read:orders.tags',
      'read:orders.total',
      'read:tags.label',
      'read:tags.label'
    ])
    expect([...(u?.inputFields.get('orders_filter') ?? [])]).toEqual(['customer'])
    expect([...(u?.inputFields.get('customers_filter') ?? [])]).toEqual(['name'])
  })

  it('records the keys of a mutation data argument as writes, variables included', () => {
    const u = graphqlUsage(schema, rel, collections, {
      query: 'mutation New($d: JSON) { create_orders_item(data: $d) { id } }',
      variables: { d: { total: 3, customer: { id: 1 } } }
    })
    expect(u?.collections).toEqual([{ collection: 'orders', mode: 'write' }])
    expect(pairs((u?.usages ?? []).filter((x) => x.mode === 'write'))).toEqual([
      'write:orders.customer',
      'write:orders.total'
    ])
  })

  it('records a field the schema no longer has on its parent type', () => {
    const u = graphqlUsage(schema, rel, collections, {
      query: '{ orders { id gone_field } }',
      variables: {}
    })
    expect(u?.typeFields.get('orders')).toEqual(new Set(['id', 'gone_field']))
    expect(pairs(u?.usages ?? [])).toContain('read:orders.gone_field')
  })

  it('resolves a persisted-query body to its stored document', () => {
    const doc = graphqlDocumentOf(
      JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'abc' } } }),
      (k) => (k.hash === 'abc' ? '{ orders { id } }' : null)
    )
    expect(doc?.query).toBe('{ orders { id } }')
    expect(graphqlDocumentOf('not json')).toBeNull()
  })
})

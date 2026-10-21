import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/config-epoch.js', () => ({ onConfigStamp: () => () => {} }))
vi.mock('../../../services/record-events.js', () => ({
  emitToTenant: vi.fn(),
  keyedThrottle: () => () => {}
}))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => '' }))

import {
  collectionHint,
  isConfigWrite,
  nameConfigCollection
} from '../../../services/config-live.js'

describe('collectionHint', () => {
  it('reads the collection a config write names', () => {
    expect(collectionHint({ url: '/api/collection-layouts', body: { collection: 'orders' } })).toBe(
      'orders'
    )
    expect(
      collectionHint({
        url: '/api/field-config?collection=orders',
        query: { collection: 'orders' }
      })
    ).toBe('orders')
    expect(collectionHint({ url: '/api/data-model/fields/orders?x=1' })).toBe('orders')
    expect(collectionHint({ url: '/api/collections/orders' })).toBe('orders')
  })

  it('never takes a numeric id or an odd name as a collection', () => {
    expect(collectionHint({ url: '/api/data-model/fields/12' })).toBeNull()
    expect(
      collectionHint({ url: '/api/collection-layouts', body: { collection: 'a b;' } })
    ).toBeNull()
    expect(collectionHint({ url: '/api/roles' })).toBeNull()
  })
})

describe('collectionHint — field settings and data-model tables name their collection', () => {
  it('a Data Model field-settings PATCH names the collection, so its open forms get the notice', () => {
    expect(collectionHint({ url: '/api/field-config/orders/amount', body: { label: 'X' } })).toBe(
      'orders'
    )
  })

  it('a data-model table write names the table it changes', () => {
    expect(collectionHint({ url: '/api/data-model/tables/orders/columns' })).toBe('orders')
    expect(collectionHint({ url: '/api/data-model/tables/orders/fields/amount' })).toBe('orders')
    expect(collectionHint({ url: '/api/data-model/tables/orders/register?x=1' })).toBe('orders')
    expect(collectionHint({ url: '/api/data-model/tables/orders' })).toBe('orders')
  })

  it('creating a table names none (no open form shows it yet), and ids never pass', () => {
    expect(collectionHint({ url: '/api/data-model/tables' })).toBeNull()
    expect(collectionHint({ url: '/api/field-config/12/amount' })).toBeNull()
    expect(collectionHint({ url: '/api/data-model/tables/12/columns' })).toBeNull()
  })
})

describe('collectionHint — writes keyed by id', () => {
  it('a layout or group write names the collection its row belongs to', () => {
    const req = { url: '/api/collection-layouts/12/ops', body: { ops: [], base_rev: 'r' } }
    expect(collectionHint(req)).toBeNull()
    nameConfigCollection(req, 'orders')
    expect(collectionHint(req)).toBe('orders')
  })

  it('the route-named collection wins over a body value, and odd names never pass', () => {
    const req = { url: '/api/field-groups/3', body: { collection: 'other' } }
    nameConfigCollection(req, 'orders')
    expect(collectionHint(req)).toBe('orders')
    const odd = { url: '/api/field-groups/3' }
    nameConfigCollection(odd, 'a b;')
    expect(collectionHint(odd)).toBeNull()
    nameConfigCollection(odd, null)
    expect(collectionHint(odd)).toBeNull()
  })
})

describe('isConfigWrite', () => {
  const req = (method: string, url: string, read = false) => ({
    method,
    url,
    ...(read ? { nvrConfigRead: true } : {})
  })

  it('a read-only POST that marked itself flushes nothing', () => {
    expect(isConfigWrite(req('POST', '/api/field-config/orders/project', true))).toBe(false)
    expect(isConfigWrite(req('POST', '/api/field-config/orders/cascade?x=1', true))).toBe(false)
  })

  it('the same path is a write for any other method, marked or not', () => {
    for (const m of ['PATCH', 'PUT', 'DELETE']) {
      // A field named "project" or "cascade": PATCH /field-config/:collection/:field.
      expect(isConfigWrite(req(m, '/api/field-config/orders/project'))).toBe(true)
      expect(isConfigWrite(req(m, '/api/field-config/orders/cascade', true))).toBe(true)
    }
  })

  it('an unmarked POST is a write, whatever its path says', () => {
    expect(isConfigWrite(req('POST', '/api/field-config/orders/project'))).toBe(true)
    expect(isConfigWrite(req('POST', '/api/collection-layouts/12/ops'))).toBe(true)
    expect(isConfigWrite(req('DELETE', '/api/field-groups/3'))).toBe(true)
  })

  it('reads and other routes are never config writes', () => {
    expect(isConfigWrite(req('GET', '/api/field-config/orders'))).toBe(false)
    expect(isConfigWrite(req('HEAD', '/api/field-config/orders'))).toBe(false)
    expect(isConfigWrite(req('OPTIONS', '/api/collection-layouts/12/ops'))).toBe(false)
    expect(isConfigWrite(req('POST', '/api/items/orders'))).toBe(false)
    expect(isConfigWrite({ ...req('POST', '/api/roles'), nvrConfigRead: true })).toBe(false)
  })
})

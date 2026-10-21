import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/config-epoch.js', () => ({ onConfigStamp: () => () => {} }))
vi.mock('../../../services/record-events.js', () => ({
  emitToTenant: vi.fn(),
  keyedThrottle: () => () => {}
}))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => '' }))

import {
  collectionHint,
  isConfigReadPost,
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

describe('isConfigReadPost', () => {
  it('the draft projection and the rule evaluators change no configuration', () => {
    for (const p of [
      'project',
      'evaluate-visibility',
      'evaluate-defaults',
      'evaluate-lock',
      'cascade'
    ]) {
      expect(isConfigReadPost(`/api/field-config/orders/${p}`)).toBe(true)
      expect(isConfigReadPost(`/api/field-config/orders/${p}?x=1`)).toBe(true)
    }
  })

  it('real config writes still count', () => {
    expect(isConfigReadPost('/api/field-config/orders/status')).toBe(false)
    expect(isConfigReadPost('/api/field-config/orders/project/extra')).toBe(false)
    expect(isConfigReadPost('/api/collection-layouts/12/ops')).toBe(false)
    expect(isConfigReadPost('/api/field-groups/3')).toBe(false)
  })
})

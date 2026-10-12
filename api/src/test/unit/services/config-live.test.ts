import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/config-epoch.js', () => ({ onConfigStamp: () => () => {} }))
vi.mock('../../../services/record-events.js', () => ({
  emitToTenant: vi.fn(),
  keyedThrottle: () => () => {}
}))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => '' }))

import { collectionHint } from '../../../services/config-live.js'

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

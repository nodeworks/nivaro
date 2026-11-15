import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn(() => ({ first: async () => undefined })) }))

import { isCollectionWideSubscription } from '../../../hooks/notification-subscriptions.js'
import { normalizeTarget, resolveTargetUrl } from '../../../services/notification-target.js'

describe('a bulk-change notice opens the collection list on exactly those records', () => {
  it('a collection target carries its query', async () => {
    const spec = normalizeTarget({
      kind: 'record',
      collection: 'workflows',
      query: 'ids=1,2,3',
      action: 'open'
    })
    expect(spec?.query).toBe('ids=1,2,3')
    const url = await resolveTargetUrl(spec, { app: 'admin' })
    expect(url).toMatch(/\/collections\/workflows\?ids=1,2,3$/)
  })

  it('without a query it is still the plain list', async () => {
    const url = await resolveTargetUrl(
      normalizeTarget({ kind: 'record', collection: 'workflows', query: null }),
      { app: 'admin' }
    )
    expect(url).toMatch(/\/collections\/workflows$/)
  })
})

describe('which subscriptions already tell their owner about every update', () => {
  it('only an unfiltered collection-wide one', () => {
    expect(isCollectionWideSubscription({})).toBe(true)
    expect(isCollectionWideSubscription({ filters: '[]' })).toBe(true)
    expect(isCollectionWideSubscription({ filter_field: 'zone' })).toBe(false)
    expect(
      isCollectionWideSubscription({ filters: '[{"field":"zone","op":"eq","value":"1"}]' })
    ).toBe(false)
    expect(isCollectionWideSubscription({ filters: 'not json' })).toBe(false)
  })
})

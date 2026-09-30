import { describe, expect, it } from 'vitest'
import { builtinListed } from './PushBulkButtons'
import { latestFailedPartners } from './RowPushActions'

describe('latestFailedPartners (#622)', () => {
  it('names partners whose LATEST submission failed, newest-first input', () => {
    const rows = [
      { external_api: 1, external_api_name: 'Partner A', status: 'accepted' },
      { external_api: 2, external_api_name: 'Partner B', status: 'failed' },
      { external_api: 1, external_api_name: 'Partner A', status: 'failed' },
      { external_api: 3, external_api_name: null, status: 'rejected' }
    ]
    expect(latestFailedPartners(rows)).toEqual(['Partner B', 'API 3'])
    expect(latestFailedPartners([])).toEqual([])
  })
})

describe('builtinListed (#620)', () => {
  const data = {
    orders: [
      { key: 'push', source: 'builtin' },
      { key: 'on-hold', source: 'db' }
    ]
  } as never
  it('needs the built-in listed for the collection AND allowed on the surface', () => {
    expect(builtinListed(data, null, 'orders', 'push')).toBe(true)
    expect(builtinListed(data, null, 'orders', 'retry-push')).toBe(false)
    expect(builtinListed(data, ['on-hold'], 'orders', 'push')).toBe(false)
    expect(builtinListed(data, ['orders:push'], 'orders', 'push')).toBe(true)
    expect(builtinListed(undefined, null, 'orders', 'push')).toBe(false)
  })
})

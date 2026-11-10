import { describe, expect, it } from 'vitest'
import { exactCountParams, lastPageFor, lastPageFromCount } from './cbv-pager'

describe('CollectionBrowserView Last page', () => {
  it('pages from the exact total', () => {
    expect(lastPageFor(0, 50)).toBe(1)
    expect(lastPageFor(50, 50)).toBe(1)
    expect(lastPageFor(51, 50)).toBe(2)
    expect(lastPageFor(12_345, 100)).toBe(124)
  })

  it('asks for an exact count with the same search and column conditions', () => {
    const conditions = JSON.stringify([{ field: 'name', op: '_contains', value: 'ATL' }])
    expect(exactCountParams({ search: 'kea', conditions })).toEqual({
      limit: 1,
      fields: 'id',
      search: 'kea',
      conditions
    })
    const plain = exactCountParams({})
    expect(plain).toEqual({ limit: 1, fields: 'id' })
    // No `count` param: the items route answers an exact total without it.
    expect(plain).not.toHaveProperty('count')
  })

  it('reads the answer; a timed-out or missing count gives no page', () => {
    expect(lastPageFromCount({ total: 201 }, 50)).toBe(5)
    expect(lastPageFromCount({ total: 0 }, 50)).toBe(1)
    expect(lastPageFromCount({ total: 900, total_timed_out: true }, 50)).toBeNull()
    expect(lastPageFromCount({ total: null }, 50)).toBeNull()
    expect(lastPageFromCount(undefined, 50)).toBeNull()
  })
})

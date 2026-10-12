import { describe, expect, it } from 'vitest'
import { type CollectionUpdateEvent, updateItemIds, updateTouches } from './realtime'

const one: CollectionUpdateEvent = { collection: 'orders', item: 7, action: 'update' }
const burst: CollectionUpdateEvent = {
  collection: 'orders',
  item: null,
  coalesced: true,
  items: [7, 'abc'],
  many: false,
  count: 2
}
const many: CollectionUpdateEvent = {
  collection: 'orders',
  item: null,
  coalesced: true,
  items: null,
  many: true,
  count: 5000
}

describe('coalesced updates (#1681)', () => {
  it('lists the ids an update covers', () => {
    expect(updateItemIds(one)).toEqual([7])
    expect(updateItemIds(burst)).toEqual([7, 'abc'])
    expect(updateItemIds(many)).toBeNull()
  })
  it('says whether a record is touched (string/number alike; "many" touches all)', () => {
    expect(updateTouches(one, '7')).toBe(true)
    expect(updateTouches(one, 8)).toBe(false)
    expect(updateTouches(burst, 'abc')).toBe(true)
    expect(updateTouches(burst, 'zzz')).toBe(false)
    expect(updateTouches(many, 'anything')).toBe(true)
  })
})

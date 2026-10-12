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

describe('live hooks see a coalesced burst per record (lib/live expandCoalesced)', () => {
  it('lists become one event per id; "many" becomes one bulk event', async () => {
    const { expandCoalesced } = await import('./live')
    expect(expandCoalesced(burst as never).map((e) => e.item)).toEqual([7, 'abc'])
    const bulk = expandCoalesced(many as never)
    expect(bulk).toHaveLength(1)
    expect(bulk[0]).toMatchObject({ item: '*', bulk: 5000 })
    expect(bulk[0]).not.toHaveProperty('coalesced')
    expect(expandCoalesced(one as never)).toEqual([one])
  })
})

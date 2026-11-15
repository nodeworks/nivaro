import { describe, expect, it } from 'vitest'
import { configReach, parseReachCollections } from '../../../services/config-reach.js'

const snap = [
  {
    collection: 'orders',
    item: '1',
    viewers: [
      { id: 'A', name: 'Amy' },
      { id: 'B', name: 'Beth' }
    ]
  },
  {
    collection: 'orders',
    item: '2',
    viewers: [
      { id: 'a', name: 'Amy' },
      { id: 'ME', name: 'Me' }
    ]
  },
  { collection: 'invoices', item: '9', viewers: [{ id: 'C', name: 'Cy' }] },
  { collection: 'other', item: '5', viewers: [{ id: 'D', name: 'Di' }] }
]

describe('configReach (rt8 #25)', () => {
  it('counts open forms and people of the named collections, leaving the editor out', () => {
    const r = configReach(snap, ['orders', 'invoices'], 'me')
    expect(r.forms).toBe(4)
    expect(r.people).toBe(3)
    expect(r.people_list[0]).toEqual({ id: 'A', name: 'Amy', forms: 2, records: 2 })
    expect(r.by_collection).toEqual([
      { collection: 'orders', forms: 3, people: 2 },
      { collection: 'invoices', forms: 1, people: 1 }
    ])
  })

  it('caps the people list and says how many more', () => {
    const r = configReach(snap, ['orders', 'invoices', 'other'], null, 2)
    expect(r.people_list).toHaveLength(2)
    expect(r.more).toBe(3)
  })

  it('answers nothing for a collection nobody has open', () => {
    expect(configReach(snap, ['nope'])).toMatchObject({ forms: 0, people: 0, people_list: [] })
  })

  it('parses the collection list safely', () => {
    expect(parseReachCollections('orders, invoices,orders,bad name,x;drop')).toEqual([
      'orders',
      'invoices'
    ])
    expect(parseReachCollections(undefined)).toEqual([])
  })
})

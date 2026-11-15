import { describe, expect, it } from 'vitest'
import {
  deltaNames,
  foldSelectionChanges,
  MAX_ITEMS,
  MAX_WINDOW_MS,
  parseSelectionAsk
} from '../../../services/selection-changes.js'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const T = (min: number) => NOW - min * 60_000
const ME = 'AAAA-ME'
const BETH = 'bbbb-beth'

describe('parseSelectionAsk', () => {
  it('reads ids with their pick times', () => {
    const ask = parseSelectionAsk(
      {
        collection: 'orders',
        items: [
          { id: 7, since: new Date(T(5)).toISOString() },
          { id: 'x-1', since: T(2) }
        ]
      },
      NOW
    )
    expect(ask?.collection).toBe('orders')
    expect([...(ask?.since ?? new Map())]).toEqual([
      ['7', T(5)],
      ['x-1', T(2)]
    ])
  })

  it('refuses system tables and bad names', () => {
    for (const c of ['nivaro_users', 'directus_files', 'a b', '', 7])
      expect(parseSelectionAsk({ collection: c, items: [{ id: 1, since: T(1) }] }, NOW)).toBeNull()
  })

  it('drops unreadable items and caps the list', () => {
    const many = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => ({ id: i + 1, since: T(1) }))
    expect(parseSelectionAsk({ collection: 'orders', items: many }, NOW)?.since.size).toBe(
      MAX_ITEMS
    )
    expect(
      parseSelectionAsk(
        {
          collection: 'orders',
          items: [
            { id: null, since: T(1) },
            { id: 2, since: 'nope' }
          ]
        },
        NOW
      )
    ).toBeNull()
  })

  it('clamps a pick time into [now − window, now]', () => {
    const ask = parseSelectionAsk(
      {
        collection: 'orders',
        items: [
          { id: 1, since: NOW - MAX_WINDOW_MS * 3 },
          { id: 2, since: NOW + 60_000 }
        ]
      },
      NOW
    )
    expect(ask?.since.get('1')).toBe(NOW - MAX_WINDOW_MS)
    expect(ask?.since.get('2')).toBe(NOW)
  })
})

describe('deltaNames', () => {
  it('lists changed fields without audit stamps', () => {
    expect(deltaNames('{"amount":5,"date_updated":"x","status":"a"}')).toEqual(['amount', 'status'])
    expect(deltaNames({ title: 'a' })).toEqual(['title'])
    expect(deltaNames('not json')).toBeNull()
    expect(deltaNames([1])).toBeNull()
  })
})

describe('foldSelectionChanges', () => {
  const ask = {
    collection: 'orders',
    since: new Map([
      ['1', T(10)],
      ['2', T(10)],
      ['ABC', T(10)]
    ])
  }

  it('keeps only changes made after the pick, by someone else', () => {
    const out = foldSelectionChanges(
      ask,
      ME,
      [
        { item: '1', action: 'update', user: BETH, at: T(5), fields: ['amount'] },
        { item: '1', action: 'update', user: BETH, at: T(20), fields: ['title'] }, // before pick
        { item: '2', action: 'update', user: 'aaaa-me', at: T(3), fields: ['amount'] } // mine
      ],
      []
    )
    expect(Object.keys(out)).toEqual(['1'])
    expect(out['1'].fields).toEqual(['amount'])
    expect(out['1'].by).toEqual([BETH])
    expect(out['1'].at).toBe(new Date(T(5)).toISOString())
  })

  it('unions fields, names each person once, newest first', () => {
    const out = foldSelectionChanges(
      ask,
      ME,
      [
        { item: '1', action: 'update', user: BETH, at: T(5), fields: ['amount'] },
        { item: '1', action: 'update', user: 'cccc', at: T(2), fields: ['status'] },
        { item: '1', action: 'update', user: 'BBBB-BETH', at: T(1), fields: ['amount'] }
      ],
      []
    )
    expect(out['1'].fields.sort()).toEqual(['amount', 'status'])
    expect(out['1'].by).toEqual(['BBBB-BETH', 'cccc'])
  })

  it('reports moves and deletes, and keeps the sent id spelling', () => {
    const out = foldSelectionChanges(
      ask,
      ME,
      [{ item: 'abc', action: 'delete', user: BETH, at: T(1) }],
      [
        { item: '2', user: BETH, at: T(4), to: 'Finance' },
        { item: '2', user: BETH, at: T(6), to: 'Review' }
      ]
    )
    expect(out.ABC.deleted).toBe(true)
    expect(out['2'].moved_to).toBe('Finance')
    expect(out['2'].fields).toEqual([])
  })

  it('says when the fields could not be read, and skips stamp-only updates', () => {
    const out = foldSelectionChanges(
      ask,
      ME,
      [
        { item: '1', action: 'update', user: BETH, at: T(5), fields: null },
        { item: '2', action: 'update', user: BETH, at: T(5), fields: [] }
      ],
      []
    )
    expect(out['1'].fields_unknown).toBe(true)
    expect(out['2']).toBeUndefined()
  })

  it('counts an automatic write with no person', () => {
    const out = foldSelectionChanges(
      ask,
      ME,
      [{ item: '1', action: 'update', user: null, at: T(5), fields: ['amount'] }],
      []
    )
    expect(out['1'].by).toEqual([])
  })

  it('ignores records that were never asked about', () => {
    const out = foldSelectionChanges(
      ask,
      ME,
      [{ item: '99', action: 'update', user: BETH, at: T(5), fields: ['amount'] }],
      []
    )
    expect(out).toEqual({})
  })
})

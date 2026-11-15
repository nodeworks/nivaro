import { describe, expect, it } from 'vitest'
import { type CensusRow, censusByState, oldestHint, stateListPath } from './state-census'

const row = (over: Partial<CensusRow>): CensusRow => ({
  state_id: 'AAA',
  collection: 'workflows',
  count: 1,
  oldest_at: null,
  key: 'review',
  label: 'In review',
  color: null,
  orphaned: false,
  ...over
})

describe('censusByState', () => {
  it('sums a step across collections and keeps the longest wait', () => {
    const m = censusByState(
      [
        row({ count: 7, oldest_at: '2026-11-02T00:00:00.000Z' }),
        row({ collection: 'inventory_request', count: 3, oldest_at: '2026-10-20T00:00:00.000Z' }),
        row({ state_id: 'BBB', count: 9 })
      ],
      ['aaa', 'ccc']
    )
    // ids match case-insensitively (SQL Server answers uuids upper-case)
    expect(m.get('aaa')).toEqual({
      count: 10,
      oldestAt: '2026-10-20T00:00:00.000Z',
      byCollection: [
        { collection: 'workflows', count: 7, oldestAt: '2026-11-02T00:00:00.000Z' },
        { collection: 'inventory_request', count: 3, oldestAt: '2026-10-20T00:00:00.000Z' }
      ]
    })
    // a step nobody sits in is a real zero, never missing
    expect(m.get('ccc')).toEqual({ count: 0, oldestAt: null, byCollection: [] })
  })
})

describe('oldestHint', () => {
  const now = Date.parse('2026-11-14T12:00:00.000Z')
  it('reads whole days', () => {
    expect(oldestHint('2026-11-02T11:00:00.000Z', now)).toBe('oldest 12 d')
    // past 60 days: months; past a year: years with one decimal
    expect(oldestHint('2026-08-12T11:00:00.000Z', now)).toBe('oldest 3 mo')
    expect(oldestHint('2025-05-29T11:00:00.000Z', now)).toBe('oldest 1.5 yr')
    expect(oldestHint('2022-02-20T11:00:00.000Z', now)).toBe('oldest 4.7 yr')
    expect(oldestHint('2026-11-13T11:00:00.000Z', now)).toBe('oldest 1 d')
    expect(oldestHint('2026-11-14T08:00:00.000Z', now)).toBe('oldest today')
  })
  it('says nothing when it does not know', () => {
    expect(oldestHint(null, now)).toBeNull()
    expect(oldestHint('not a date', now)).toBeNull()
  })
})

describe('stateListPath', () => {
  it('opens the collection filtered to the step key', () => {
    expect(stateListPath('inventory_request', 'in_review')).toBe(
      '/collections/inventory_request?state=in_review'
    )
  })
})

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

import {
  cleanQuery,
  rewordings,
  type SearchRow,
  summarizeSearches
} from '../../../services/search-analytics.js'

const row = (o: Partial<SearchRow>): SearchRow => ({
  user: 'u1',
  surface: 'palette',
  collection: null,
  query: 'invoice',
  result_count: 3,
  duration_ms: 200,
  opened_type: 'record',
  ...o
})

describe('cleanQuery', () => {
  it('trims, collapses spaces, needs 2 chars', () => {
    expect(cleanQuery('  po   123 ')).toBe('po 123')
    expect(cleanQuery('a')).toBeNull()
    expect(cleanQuery(5)).toBeNull()
    expect(cleanQuery('x'.repeat(300))?.length).toBe(200)
  })
})

describe('summarizeSearches', () => {
  const rows = [
    row({}),
    row({ query: 'Invoice', user: 'u2', opened_type: null }),
    row({ query: 'zzz', result_count: 0, opened_type: null }),
    row({ query: 'zzz', result_count: 0, opened_type: null, user: 'u2' }),
    row({
      query: 'zzz',
      surface: 'collection',
      collection: 'orders',
      result_count: 0,
      opened_type: null
    }),
    row({ query: 'slow one', duration_ms: 2500 }),
    row({ query: 'slow one', duration_ms: 3000, opened_type: null })
  ]
  const s = summarizeSearches(rows)
  it('totals', () => {
    expect(s.totals.searches).toBe(7)
    expect(s.totals.people).toBe(2)
    expect(s.totals.zero_result_rate).toBeCloseTo(3 / 7)
    expect(s.totals.open_rate).toBeCloseTo(2 / 4)
  })
  it('case-insensitive grouping; same words per collection stay apart', () => {
    expect(s.top.find((t) => t.query.toLowerCase() === 'invoice')?.searches).toBe(2)
    const zero = s.zero_results
    expect(zero).toHaveLength(2)
    expect(zero[0]).toMatchObject({
      query: 'zzz',
      collection: null,
      searches: 2,
      zero_results: 2,
      people: 2
    })
    expect(zero[1].collection).toBe('orders')
  })
  it('unopened ignores zero-result searches', () => {
    expect(s.unopened.map((u) => u.query).sort()).toEqual(['invoice', 'slow one'])
  })
  it('slow lists p75 over the threshold', () => {
    expect(s.slow).toHaveLength(1)
    expect(s.slow[0]).toMatchObject({ query: 'slow one', p75_ms: 3000 })
  })
})

describe('rewordings', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 22, 12, 0, s))
  it('takes the next search that found something as the rewording of an empty one', () => {
    const rows = [
      row({ query: 'po 12', result_count: 0, opened_type: null, created_at: t(0) }),
      row({ query: 'purchase order 12', result_count: 4, created_at: t(20) }),
      row({ user: 'u2', query: 'po 12', result_count: 0, opened_type: null, created_at: t(0) }),
      row({ user: 'u2', query: 'po 123', result_count: 2, created_at: t(5) }),
      row({ user: 'u2', query: 'purchase order 12', result_count: 4, created_at: t(9) })
    ]
    const r = rewordings(rows)
    expect(r.get(`palette\u0000\u0000po 12`)).toEqual({
      query: 'purchase order 12',
      times: 2,
      opened: 2
    })
    const s = summarizeSearches(rows)
    expect(s.zero_results[0].reworded_as?.query).toBe('purchase order 12')
  })

  it('ignores follow-ups after the window or in another search box', () => {
    const rows = [
      row({ query: 'xyz', result_count: 0, opened_type: null, created_at: t(0) }),
      row({ query: 'abc', result_count: 3, created_at: new Date(t(0).getTime() + 5 * 60_000) }),
      row({ query: 'xyy', result_count: 0, opened_type: null, created_at: t(0) }),
      row({
        surface: 'collection',
        collection: 'a',
        query: 'abc',
        result_count: 3,
        created_at: t(9)
      })
    ]
    expect(rewordings(rows).size).toBe(0)
  })
})

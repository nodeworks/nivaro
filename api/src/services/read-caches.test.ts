// #2443 list totals + #2444 display-label rows: keys, busts, races, shapes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetReadCaches,
  bustAllReadCaches,
  getCachedRows,
  getCachedTotal,
  LABEL_LOOKUP_MAX_IDS,
  labelLookupIds,
  noteCollectionWrite,
  putCachedRows,
  putCachedTotal,
  readCachesActive,
  readEpoch,
  statementHash
} from './read-caches.js'

beforeEach(() => _resetReadCaches())
afterEach(() => {
  delete process.env.LIST_TOTAL_CACHE_MS
  delete process.env.LABEL_CACHE_MS
  _resetReadCaches()
})

const stmt = (sql: string, b: unknown[] = []) => statementHash(sql, b)

describe('list totals', () => {
  it('serves a stored total for the same statement until it expires', () => {
    const s = stmt('select count(*) from [orders] where [x] = @p0', [1])
    putCachedTotal('orders', s, 42, readEpoch('orders'), 1000)
    expect(getCachedTotal('orders', s, 2000)).toBe(42)
    expect(getCachedTotal('orders', s, 1000 + 30_001)).toBeNull()
  })

  it('keys on the bound values: another caller scope is another total', () => {
    const a = stmt('select count(*) from [orders] where [region] = @p0', [1])
    const b = stmt('select count(*) from [orders] where [region] = @p0', [2])
    putCachedTotal('orders', a, 10, readEpoch('orders'))
    expect(getCachedTotal('orders', b)).toBeNull()
  })

  it('a write to the collection drops its totals, not other collections', () => {
    const s = stmt('q')
    putCachedTotal('orders', s, 5, readEpoch('orders'))
    putCachedTotal('vendors', s, 7, readEpoch('vendors'))
    noteCollectionWrite('orders')
    expect(getCachedTotal('orders', s)).toBeNull()
    expect(getCachedTotal('vendors', s)).toBe(7)
  })

  it('a write that lands while the count runs discards its answer', () => {
    const s = stmt('q')
    const epoch = readEpoch('orders')
    noteCollectionWrite('orders')
    putCachedTotal('orders', s, 5, epoch)
    expect(getCachedTotal('orders', s)).toBeNull()
  })

  it('a configuration write clears everything; LIST_TOTAL_CACHE_MS=0 turns it off', () => {
    const s = stmt('q')
    putCachedTotal('orders', s, 5, readEpoch('orders'))
    expect(readCachesActive()).toBe(true)
    bustAllReadCaches()
    expect(getCachedTotal('orders', s)).toBeNull()
    process.env.LIST_TOTAL_CACHE_MS = '0'
    putCachedTotal('orders', s, 5, readEpoch('orders'))
    expect(getCachedTotal('orders', s)).toBeNull()
  })
})

describe('display-label rows', () => {
  it('returns hits as copies, lists what is missing, remembers absent ids', () => {
    const sig = stmt('select * from [vendors]')
    const epoch = readEpoch('vendors')
    putCachedRows('vendors', sig, ['1', '2'], [{ id: 1, name: 'Acme' }], epoch)
    const got = getCachedRows('vendors', sig, ['1', '2', '3'])
    expect(got.missing).toEqual(['3'])
    expect(got.hits.get('1')).toEqual({ id: 1, name: 'Acme' })
    expect(got.hits.get('2')).toBeNull()
    ;(got.hits.get('1') as Record<string, unknown>).name = 'mutated'
    expect(getCachedRows('vendors', sig, ['1']).hits.get('1')).toEqual({ id: 1, name: 'Acme' })
  })

  it('matches ids case-blind (uniqueidentifier printed upper-case)', () => {
    const sig = stmt('s')
    putCachedRows('people', sig, ['abc-1'], [{ id: 'ABC-1', n: 1 }], readEpoch('people'))
    const got = getCachedRows('people', sig, ['ABC-1'])
    expect(got.missing).toEqual([])
    expect(got.hits.get('ABC-1')).toEqual({ id: 'ABC-1', n: 1 })
  })

  it('another gate signature never sees the rows; a write busts them', () => {
    const sig = stmt('s', ['user-a'])
    putCachedRows('vendors', sig, ['1'], [{ id: 1 }], readEpoch('vendors'))
    expect(getCachedRows('vendors', stmt('s', ['user-b']), ['1']).missing).toEqual(['1'])
    noteCollectionWrite('vendors')
    expect(getCachedRows('vendors', sig, ['1']).missing).toEqual(['1'])
  })
})

describe('labelLookupIds', () => {
  const lookup = (extra: Record<string, unknown> = {}) => ({
    labels: true,
    filter: { id: { _in: [1, '2', 2] } },
    limit: 10,
    ...extra
  })
  it('accepts exactly the relation-cell shape', () => {
    expect(labelLookupIds(lookup())).toEqual(['1', '2'])
  })
  it('refuses anything that changes which rows or their order', () => {
    expect(labelLookupIds(lookup({ labels: false }))).toBeNull()
    expect(labelLookupIds(lookup({ search: 'x' }))).toBeNull()
    expect(labelLookupIds(lookup({ sort: ['name'] }))).toBeNull()
    expect(labelLookupIds(lookup({ after: 'start' }))).toBeNull()
    expect(labelLookupIds(lookup({ page: 2 }))).toBeNull()
    expect(labelLookupIds(lookup({ offset: 5 }))).toBeNull()
    expect(labelLookupIds(lookup({ limit: 1 }))).toBeNull()
    expect(labelLookupIds(lookup({ filter: { id: { _in: [1] }, x: { _eq: 1 } } }))).toBeNull()
    expect(labelLookupIds(lookup({ filter: { id: { _in: [1], _neq: 2 } } }))).toBeNull()
    expect(labelLookupIds(lookup({ filter: { id: { _in: [{ a: 1 }] } } }))).toBeNull()
    expect(labelLookupIds(lookup(), { conditions: '[]' })).toBeNull()
    expect(labelLookupIds(lookup(), { agg: 'amount' })).toBeNull()
    const many = Array.from({ length: LABEL_LOOKUP_MAX_IDS + 1 }, (_, i) => i)
    expect(labelLookupIds(lookup({ filter: { id: { _in: many } }, limit: 1000 }))).toBeNull()
  })
  it('LABEL_CACHE_MS=0 turns it off', () => {
    process.env.LABEL_CACHE_MS = '0'
    expect(labelLookupIds(lookup())).toBeNull()
  })
})

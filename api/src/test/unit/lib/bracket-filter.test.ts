import { describe, expect, it } from 'vitest'
import {
  BracketFilterError,
  bracketFilter,
  foldBracketFilter
} from '../../../lib/bracket-filter.js'

// army 8 b10: `filter[po_total][_gt]=1` (and even `filter[nonexistent_field][_eq]=1`) was
// ignored — the routes read only `filter=<JSON>` — so a filtered list came back whole.
describe('bracketFilter — the Directus bracket form folds into the JSON filter', () => {
  it('field + operator', () => {
    expect(bracketFilter({ 'filter[po_total][_gt]': '1', limit: '1' })).toEqual({
      po_total: { _gt: '1' }
    })
  })

  it('relation paths, list and boolean operators', () => {
    expect(
      bracketFilter({
        'filter[project][division][_eq]': '3',
        'filter[id][_in]': '1,2, 3',
        'filter[closed_at][_null]': 'true',
        'filter[vendor][_nnull]': 'false'
      })
    ).toEqual({
      project: { division: { _eq: '3' } },
      id: { _in: ['1', '2', '3'] },
      closed_at: { _null: true },
      vendor: { _nnull: false }
    })
  })

  it('_or / _and indexes become arrays in index order', () => {
    expect(
      bracketFilter({
        'filter[_or][1][name][_eq]': 'b',
        'filter[_or][0][name][_eq]': 'a'
      })
    ).toEqual({ _or: [{ name: { _eq: 'a' } }, { name: { _eq: 'b' } }] })
  })

  it('no bracket keys = nothing to fold', () => {
    expect(bracketFilter({ filter: '{"a":{"_eq":1}}' })).toBeNull()
    expect(bracketFilter(undefined)).toBeNull()
  })

  // Army 8 review: these were 400s after the fold; Directus-style callers send them.
  it('filter[field]=value with no operator is _eq (also on relation paths and in groups)', () => {
    expect(bracketFilter({ 'filter[status]': 'open' })).toEqual({ status: { _eq: 'open' } })
    expect(bracketFilter({ 'filter[project][division]': '3' })).toEqual({
      project: { division: { _eq: '3' } }
    })
    expect(bracketFilter({ 'filter[_or][0][name]': 'a', 'filter[_or][1][name]': 'b' })).toEqual({
      _or: [{ name: { _eq: 'a' } }, { name: { _eq: 'b' } }]
    })
    // `gt` is a field name here, not an operator: the items gates judge it (400 unknown field).
    expect(bracketFilter({ 'filter[po_total][gt]': '1' })).toEqual({
      po_total: { gt: { _eq: '1' } }
    })
  })

  it('filter=<JSON> and bracket keys together: both must hold', () => {
    expect(bracketFilter({ 'filter[a][_eq]': '1', filter: '{"b":{"_eq":2}}' })).toEqual({
      _and: [{ b: { _eq: 2 } }, { a: { _eq: '1' } }]
    })
  })

  it('malformed keys are a 400, never silently dropped', () => {
    for (const q of [
      { 'filter[_or][0]': '1' },
      { 'filter[_eq]': '1' },
      { 'filter[_or]': '1' },
      { 'filter[a;drop][_eq]': '1' },
      { 'filter[a][_eq]x': '1' },
      { 'filter[a][_eq]': '1', filter: 'not json' },
      { 'filter[a][_eq]': '1', filter: '[1]' },
      { 'filter[a][_eq]': '1', 'filter[a][_eq][b][_eq]': '2' },
      { 'filter[a]': '1', 'filter[a][_eq]': '2' }
    ]) {
      expect(() => bracketFilter(q), JSON.stringify(q)).toThrow(BracketFilterError)
    }
  })

  it('prototype keys are refused (400) and never pollute Object.prototype', () => {
    for (const q of [
      { 'filter[__proto__][polluted][_eq]': '1' },
      { 'filter[__proto__][polluted]': '1' },
      { 'filter[constructor][prototype][x][_eq]': '1' },
      { 'filter[a][__proto__]': '1' },
      { 'filter[a][prototype][_eq]': '1' }
    ]) {
      expect(() => bracketFilter(q), JSON.stringify(q)).toThrow(BracketFilterError)
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })

  it('foldBracketFilter rewrites the query in place', () => {
    const q: Record<string, unknown> = { 'filter[vendor_id][_eq]': '89583', limit: '1' }
    expect(foldBracketFilter(q)).toBe(true)
    expect(q).toEqual({ limit: '1', filter: JSON.stringify({ vendor_id: { _eq: '89583' } }) })
    const plain: Record<string, unknown> = { limit: '1' }
    expect(foldBracketFilter(plain)).toBe(false)
    expect(plain).toEqual({ limit: '1' })
  })
})

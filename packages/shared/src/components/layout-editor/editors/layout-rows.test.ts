import { describe, expect, it } from 'vitest'
import {
  defaultsFromRows,
  rowsFromDefaults,
  rowsFromRules,
  rulesFromRows,
  sameJson
} from './layout-rows'

describe('record condition rows', () => {
  it('reads stored rules from an array or JSON text', () => {
    const rules = [
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'unit', op: 'nnull' }
    ]
    const rows = [
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'unit', op: 'nnull', value: '' }
    ]
    expect(rowsFromRules(rules)).toEqual(rows)
    expect(rowsFromRules(JSON.stringify(rules))).toEqual(rows)
    expect(rowsFromRules('not json')).toEqual([])
    expect(rowsFromRules(null)).toEqual([])
  })

  it('reads a value-less or non-string value as text', () => {
    expect(rowsFromRules([{ field: 'qty', op: 'neq', value: 3 }])).toEqual([
      { field: 'qty', op: 'neq', value: '3' }
    ])
  })

  it('saves only complete rows, and nothing as null', () => {
    expect(
      rulesFromRows([
        { field: 'status', op: 'eq', value: 'open' },
        { field: '', op: 'eq', value: 'x' },
        { field: 'kind', op: 'neq', value: '' },
        { field: 'unit', op: 'nnull', value: 'ignored' }
      ])
    ).toEqual([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'unit', op: 'nnull' }
    ])
    expect(rulesFromRows([{ field: 'kind', op: 'eq', value: '' }])).toBeNull()
  })
})

describe('starting value rows', () => {
  it('round-trips the stored map', () => {
    const rows = rowsFromDefaults('{"status":"draft","tags":[1,2]}')
    expect(rows).toEqual([
      { field: 'status', value: 'draft' },
      { field: 'tags', value: [1, 2] }
    ])
    expect(defaultsFromRows(rows)).toEqual({ status: 'draft', tags: [1, 2] })
  })

  it('drops rows without a field or a value', () => {
    expect(
      defaultsFromRows([
        { field: '', value: 'x' },
        { field: 'a', value: '' },
        { field: 'b', value: [] },
        { field: 'c', value: null },
        { field: 'd', value: false }
      ])
    ).toEqual({ d: false })
    expect(defaultsFromRows([])).toBeNull()
  })
})

describe('sameJson', () => {
  it('ignores key order and JSON text vs parsed', () => {
    expect(sameJson({ a: 1, b: 2 }, '{"b":2,"a":1}')).toBe(true)
    expect(sameJson(null, undefined)).toBe(true)
    expect(sameJson([{ field: 'a' }], [{ field: 'b' }])).toBe(false)
  })
})

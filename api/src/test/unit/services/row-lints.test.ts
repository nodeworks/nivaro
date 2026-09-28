import { describe, expect, it } from 'vitest'
import { failingLints, parseRowLints } from '../../../services/row-lints.js'

const lints = parseRowLints([
  {
    label: 'Labor is Services',
    when: { field: 'category_type', value: 1 },
    expect: { field: 'po_line_type', value: 1 }
  },
  {
    label: 'Materials are Goods',
    when: { field: 'category_type', op: 'eq', value: '2' },
    expect: { field: 'po_line_type', op: 'in', value: '2,3' }
  },
  {
    label: 'Vendor set',
    when: { field: 'amount', op: 'nnull' },
    expect: { field: 'vendor', op: 'nnull' }
  },
  { bad: true }
])

describe('row lints (#766) — the grid rule, server side', () => {
  it('parses only well-formed lints', () => {
    expect(lints).toHaveLength(3)
  })
  it('a satisfied lint and an unmatched when are silent', () => {
    expect(failingLints({ category_type: 1, po_line_type: 1, amount: null }, lints)).toEqual([])
    expect(failingLints({ category_type: 9, po_line_type: 2 }, lints)).toEqual([])
  })
  it('a matched when with a failing expect names the lint; ids compare as strings, M2O objects by id', () => {
    expect(failingLints({ category_type: '1', po_line_type: { id: 2 } }, lints)).toEqual([
      'Labor is Services'
    ])
    expect(failingLints({ category_type: 2, po_line_type: 3 }, lints)).toEqual([])
    expect(failingLints({ category_type: 2, po_line_type: 1 }, lints)).toEqual([
      'Materials are Goods'
    ])
  })
  it('null / nnull judge emptiness; an empty when-field never matches eq', () => {
    expect(failingLints({ amount: 5, vendor: '' }, lints)).toEqual(['Vendor set'])
    expect(failingLints({ amount: '', vendor: '' }, lints)).toEqual([])
  })
})

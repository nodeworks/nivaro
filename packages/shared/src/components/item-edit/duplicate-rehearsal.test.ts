import { describe, expect, it } from 'vitest'
import {
  copiedLineLabel,
  copiedValueChanges,
  rehearsalBody,
  sameLineValue
} from './duplicate-rehearsal'

const KEY = 'workflow_line_items.workflow'

describe('rehearsalBody', () => {
  it('nests every staged line set under its alias, drops form bookkeeping and grandchild keys', () => {
    const { body, aliases } = rehearsalBody(
      { description: 'ARMY9', funding_year: 2026, __step: 2 },
      {
        [KEY]: [{ category: 66, price: 2, quantity: 5, __o2m_allocations: [{ a: 1 }] }],
        'nothing.here': [{ x: 1 }]
      },
      (key) => (key === KEY ? 'line_items' : null)
    )
    expect(body).toEqual({
      description: 'ARMY9',
      funding_year: 2026,
      line_items: [{ category: 66, price: 2, quantity: 5 }]
    })
    expect(aliases).toEqual({ [KEY]: 'line_items' })
  })
})

describe('copiedValueChanges (army9 b09: Duplicate re-priced a line with no notice)', () => {
  const rows = {
    [KEY]: [
      { category: 66, quantity: 104, price: 1, amount: 104, line_number: 1 },
      { category: 66, quantity: 5, price: 2, amount: 10, line_number: 2, changed: '2026-11-07' }
    ]
  }
  it('names a copied value the stored row would not keep — and the computed amount that follows it', () => {
    const changes = copiedValueChanges(
      rows,
      {
        line_items: [
          { index: 0, ok: true, data: { category: 66, quantity: 104, price: '1', amount: 104 } },
          {
            index: 1,
            ok: true,
            data: { category: 66, quantity: 5, price: '1', amount: 5, changed: '2026-11-08' }
          }
        ]
      },
      { [KEY]: 'line_items' }
    )
    expect(changes).toEqual([
      { key: KEY, index: 1, field: 'price', from: 2, to: '1' },
      { key: KEY, index: 1, field: 'amount', from: 10, to: 5 }
    ])
  })
  it('a blank the server fills, a refused row, a row without an answer: nothing to ask', () => {
    expect(
      copiedValueChanges(
        { [KEY]: [{ category: 66, price: null, task: '' }] },
        { line_items: [{ index: 0, ok: true, data: { category: 66, price: 1, task: 10 } }] },
        { [KEY]: 'line_items' }
      )
    ).toEqual([])
    expect(
      copiedValueChanges(rows, { line_items: [{ index: 0, ok: false }] }, { [KEY]: 'line_items' })
    ).toEqual([])
    expect(copiedValueChanges(rows, null, { [KEY]: 'line_items' })).toEqual([])
    expect(copiedValueChanges(rows, { line_items: [] }, {})).toEqual([])
  })
  it('numbers compare as numbers, so "2.00" against 2 is not a change', () => {
    expect(sameLineValue('2.00', 2)).toBe(true)
    expect(sameLineValue(2, 1)).toBe(false)
    expect(sameLineValue('', null)).toBe(true)
    expect(sameLineValue('a', 'b')).toBe(false)
  })
})

describe('copiedLineLabel', () => {
  it('uses the line number, else the position', () => {
    expect(copiedLineLabel({ line_number: 2 }, 0)).toBe('Line 2')
    expect(copiedLineLabel({}, 1)).toBe('Line 2')
  })
})

import { describe, expect, it } from 'vitest'
import {
  gridTotalsFromLayouts,
  isGridTotal,
  sumFieldsWritable,
  sumInputsReadable,
  sumOver,
  takeSumInto
} from '../../../services/sum-into.js'

// Realtime gaps R1 (2026-11-17): the record-grid total is summed by the server
// from the row as it will be stored, not from the months the grid had loaded.

describe('takeSumInto', () => {
  it('reads and strips a well-formed _sum_into', () => {
    const data: Record<string, unknown> = {
      january: 5,
      _sum_into: { field: 'total', of: ['january', 'february', 'january'] }
    }
    expect(takeSumInto(data)).toEqual({ field: 'total', of: ['january', 'february'] })
    expect(data).toEqual({ january: 5 })
  })

  it.each([
    [null],
    ['total'],
    [{ field: 'total', of: [] }],
    [{ field: 'total', of: ['total'] }],
    [{ field: 'to tal', of: ['a'] }],
    [{ field: '_x', of: ['a'] }],
    [{ field: 'total', of: ['a;drop'] }],
    [{ field: 'total', of: 'january' }]
  ])('ignores %j', (raw) => {
    const data: Record<string, unknown> = { _sum_into: raw }
    expect(takeSumInto(data)).toBeNull()
    expect('_sum_into' in data).toBe(false)
  })
})

describe('sumOver', () => {
  it('sums this write over the stored row', () => {
    // Beth saved february = 20 since Rob loaded; Rob writes january = 5.
    expect(
      sumOver(
        ['january', 'february', 'march'],
        { january: 5 },
        { january: 1, february: 20, march: null }
      )
    ).toBe(25)
  })

  it('counts empty and non-numeric values as 0 and keeps money sums clean', () => {
    expect(sumOver(['a', 'b', 'c'], { a: '0.1', b: '' }, { c: 0.2 })).toBe(0.3)
    expect(sumOver(['a'], { a: 'n/a' }, null)).toBe(0)
  })
})

describe('sumFieldsWritable', () => {
  it('needs the target and every input writable', () => {
    expect(sumFieldsWritable({ field: 't', of: ['a', 'b'] }, ['a', 'b', 't'])).toBe(true)
    expect(sumFieldsWritable({ field: 't', of: ['a', 'b'] }, ['a', 't'])).toBe(false)
    expect(sumFieldsWritable({ field: 't', of: ['a'] }, ['a'])).toBe(false)
    expect(sumFieldsWritable({ field: 't', of: ['a'] }, null)).toBe(true)
    expect(sumFieldsWritable({ field: 't', of: ['a'] }, ['*'])).toBe(true)
  })
})

describe('sumInputsReadable', () => {
  it('needs the total and every input readable', () => {
    expect(sumInputsReadable({ field: 't', of: ['a', 'b'] }, ['a', 'b', 't'])).toBe(true)
    expect(sumInputsReadable({ field: 't', of: ['a', 'b'] }, ['a', 't'])).toBe(false)
    expect(sumInputsReadable({ field: 't', of: ['a'] }, null)).toBe(true)
  })
})

describe('gridTotalsFromLayouts / isGridTotal', () => {
  const layout = JSON.stringify({
    columns: 12,
    widgets: [
      {
        id: 'w1',
        type: 'record-grid',
        config: {
          collection: 'forecasts',
          computed_total_field: 'total',
          month_sets: [
            { suffix: '', label: '' },
            { suffix: '_actual', label: 'Actual' }
          ]
        }
      },
      {
        id: 'w2',
        type: 'tabs',
        config: {
          tabs: [
            {
              widget: {
                collection: 'budgets',
                computed_total_field: 'amount',
                month_sets: [{ suffix: '_b' }]
              }
            }
          ]
        }
      }
    ]
  })

  const M = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december'
  ]

  it('finds every grid total for the collection, nested ones too', () => {
    const f = gridTotalsFromLayouts([layout], 'forecasts')
    expect([...f.keys()]).toEqual(['total'])
    expect(f.get('total')?.[0]?.has('january')).toBe(true)
    expect(f.get('total')?.[0]?.has('january_actual')).toBe(false)
    expect([...gridTotalsFromLayouts([layout], 'budgets').keys()]).toEqual(['amount'])
    expect(gridTotalsFromLayouts(['not json', null], 'forecasts').size).toBe(0)
  })

  it("accepts only the configured target over EXACTLY its grid's months", () => {
    const f = gridTotalsFromLayouts([layout], 'forecasts')
    expect(isGridTotal({ field: 'total', of: M }, f)).toBe(true)
    // a subset is not the grid's total
    expect(isGridTotal({ field: 'total', of: ['january', 'march'] }, f)).toBe(false)
    expect(isGridTotal({ field: 'status', of: M }, f)).toBe(false)
    expect(isGridTotal({ field: 'total', of: [...M.slice(1), 'approved_amount'] }, f)).toBe(false)
  })

  it('two pages naming the same target are never merged into one wider set', () => {
    const other = JSON.stringify({
      widgets: [
        {
          config: {
            collection: 'forecasts',
            computed_total_field: 'total',
            month_sets: [{ suffix: '_actual' }]
          }
        }
      ]
    })
    const f = gridTotalsFromLayouts([layout, other], 'forecasts')
    expect(f.get('total')).toHaveLength(2)
    expect(isGridTotal({ field: 'total', of: M }, f)).toBe(true)
    expect(isGridTotal({ field: 'total', of: M.map((m) => `${m}_actual`) }, f)).toBe(true)
    expect(isGridTotal({ field: 'total', of: [...M, 'january_actual'] }, f)).toBe(false)
  })
})

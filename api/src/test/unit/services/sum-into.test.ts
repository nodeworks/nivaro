import { describe, expect, it } from 'vitest'
import { readableSumInputs, sumOver, takeSumInto } from '../../../services/sum-into.js'

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

describe('readableSumInputs', () => {
  it('drops inputs the caller cannot read', () => {
    expect(readableSumInputs({ field: 't', of: ['a', 'b'] }, ['a', 't'])).toEqual({
      field: 't',
      of: ['a']
    })
    expect(readableSumInputs({ field: 't', of: ['a'] }, null)).toEqual({ field: 't', of: ['a'] })
    expect(readableSumInputs({ field: 't', of: ['a'] }, ['*'])).toEqual({ field: 't', of: ['a'] })
  })
})

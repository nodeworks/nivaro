import { describe, expect, it } from 'vitest'
import { diffAddendumLines, lineCellDelta } from './AddendumLinesDiff'
import { resolveAddendumAmounts } from './addendum-summary'

describe('resolveAddendumAmounts', () => {
  it('prefers stored columns', () => {
    expect(
      resolveAddendumAmounts(
        { previous_amount: '100', new_amount: '150', cost_impact: '50' },
        { previous: 1, next: 2 }
      )
    ).toEqual({ previous: 100, next: 150, change: 50 })
  })
  it('falls back to live figures while stored are null', () => {
    expect(
      resolveAddendumAmounts(
        { previous_amount: null, new_amount: null, cost_impact: null },
        { previous: 200, next: 150 }
      )
    ).toEqual({ previous: 200, next: 150, change: -50 })
  })
  it('is empty with nothing known', () => {
    expect(resolveAddendumAmounts({}, null)).toEqual({ previous: null, next: null, change: null })
  })
})

describe('line diff money', () => {
  it('signs the change of a money cell', () => {
    expect(lineCellDelta('amount', false, 10, 25.5)).toBe(15.5)
    expect(lineCellDelta('amount', false, 10, 4)).toBe(-6)
    expect(lineCellDelta('notes', false, 'a', 'b')).toBeNull()
    expect(lineCellDelta('qty', true, null, 3)).toBe(3)
  })
  it('finds added, changed and removed rows', () => {
    const d = diffAddendumLines(
      [
        { id: 1, fk: 9, amount: 20 },
        { id: null, fk: 9, amount: 5 }
      ],
      [
        { id: 1, fk: 9, amount: 10 },
        { id: 2, fk: 9, amount: 7 }
      ],
      'fk'
    )
    expect(d.added).toHaveLength(1)
    expect(d.changed[0].cells[0]).toMatchObject({ field: 'amount', before: 10, after: 20 })
    expect(d.removed.map((r) => r.id)).toEqual([2])
  })
})

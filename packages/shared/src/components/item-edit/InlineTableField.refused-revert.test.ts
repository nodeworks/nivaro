import { describe, expect, it } from 'vitest'
import { dropRevertedFields, isRealLineEdit } from './line-qty'

// army6 H4: PO line qty 3 → 10,000,000,000 (refused at the record's Save) →
// back to 3. "3 is no change" against the stored row, so the staged edit kept
// the refused value and every Save re-sent it.
describe('dropRevertedFields', () => {
  const stored = { id: 7, quantity: 3, price: 2.05, amount: 6.15 }

  it('drops a staged field the draft puts back to the stored value', () => {
    const staged = { quantity: 10_000_000_000, amount: 20_500_000_000 }
    const draft = { ...stored }
    const { rest, reverted } = dropRevertedFields(staged, draft, stored)
    expect(reverted.sort()).toEqual(['amount', 'quantity'])
    expect(rest).toEqual({})
    expect(isRealLineEdit(rest)).toBe(false)
  })

  it('keeps staged fields the person did not put back', () => {
    const staged = { quantity: 10_000_000_000, price: 2.5 }
    const draft = { ...stored, price: 2.5 }
    const { rest, reverted } = dropRevertedFields(staged, draft, stored)
    expect(reverted).toEqual(['quantity'])
    expect(rest).toEqual({ price: 2.5 })
    expect(isRealLineEdit(rest)).toBe(true)
  })

  it('compares as text, the way the grid judges "no change" ("3" = 3)', () => {
    const { reverted } = dropRevertedFields({ quantity: 9 }, { quantity: '3' }, stored)
    expect(reverted).toEqual(['quantity'])
  })

  it('never judges meta keys; a change reason alone is not an edit', () => {
    const staged = { quantity: 9, _change_reason: 'typo', __nested_ops_x: [] }
    const { rest } = dropRevertedFields(staged, { ...stored }, stored)
    expect(rest).toEqual({ _change_reason: 'typo', __nested_ops_x: [] })
    expect(isRealLineEdit({ _change_reason: 'typo' })).toBe(false)
    expect(isRealLineEdit({ _change_reason: 'typo', __flush_early: true })).toBe(false)
    expect(isRealLineEdit(rest)).toBe(true)
  })

  it('no staged edit or no stored row: nothing is reverted', () => {
    expect(dropRevertedFields(undefined, { quantity: 3 }, stored)).toEqual({
      rest: {},
      reverted: []
    })
    expect(dropRevertedFields({ quantity: 9 }, { quantity: 3 }, null)).toEqual({
      rest: { quantity: 9 },
      reverted: []
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  classifyLineConflicts,
  mergedLinePreview,
  mergeReady,
  mergeTheirsKeys,
  previewFields,
  recomputeDerived
} from './line-merge'
import { type LineCollision, lineConflictKey } from './line-midair'

// A workflow line: base 105 × $1. They saved quantity 110 and a note; I
// edited quantity to 107 and the description.
const AMOUNT = [{ field: 'amount', formula: 'item.price * item.quantity' }]
const line = (over: Partial<LineCollision> = {}): LineCollision => ({
  key: 'workflow_line_items.workflow',
  rowId: '475948',
  label: 'Line 1',
  conflicts: [
    { field: 'quantity', current_value: 110 },
    { field: 'amount', current_value: 110 }
  ],
  latest: 41,
  mine: { quantity: 107, amount: 107 },
  edit: { quantity: 107, amount: 107, item_description: 'Splice kit', _change_reason: 'x' },
  current: {
    id: 475948,
    workflow: 372989,
    quantity: 110,
    price: 1,
    amount: 110,
    note: 'theirs',
    item_description: null
  },
  derived: AMOUNT,
  ...over
})
const k = (l: LineCollision, f: string) => lineConflictKey(l, f)

describe('line merge rules (Rob, army 11)', () => {
  it('disjoint fields: theirs keep their change, mine keeps mine — nothing to ask', () => {
    const l = line({
      conflicts: [],
      mine: {},
      edit: { item_description: 'Splice kit' },
      derived: AMOUNT
    })
    const fields = classifyLineConflicts(l)
    expect(fields).toEqual([])
    expect(mergeReady(fields, new Map())).toBe(true)
    const merged = mergedLinePreview(l, new Map())
    expect(merged.note).toBe('theirs') // only they changed it
    expect(merged.item_description).toBe('Splice kit') // only I changed it
    expect(merged.quantity).toBe(110)
  })

  it('both changed to the same value: that value, no question, nothing re-sent for it', () => {
    const l = line({
      conflicts: [{ field: 'price', current_value: '2' }],
      mine: { price: 2 },
      edit: { price: 2 }
    })
    const fields = classifyLineConflicts(l)
    expect(fields.map((f) => f.kind)).toEqual(['same'])
    expect(mergeReady(fields, new Map())).toBe(true)
    expect(mergeTheirsKeys(fields, new Map())).toEqual(new Set([k(l, 'price')]))
  })

  it('a true conflict: nothing preselected, save waits for a pick, the pick decides', () => {
    const l = line()
    const fields = classifyLineConflicts(l)
    expect(fields.find((f) => f.field === 'quantity')?.kind).toBe('conflict')
    expect(mergeReady(fields, new Map())).toBe(false)
    const mine = new Map([[k(l, 'quantity'), 'mine' as const]])
    expect(mergeReady(fields, mine)).toBe(true)
    // Mine for quantity: only the derived amount stays theirs (it re-derives on the server).
    expect(mergeTheirsKeys(fields, mine)).toEqual(new Set([k(l, 'amount')]))
    const theirs = new Map([[k(l, 'quantity'), 'theirs' as const]])
    expect(mergeTheirsKeys(fields, theirs)).toEqual(new Set([k(l, 'quantity'), k(l, 'amount')]))
  })

  it('derived fields are never merged: recomputed from the merged inputs', () => {
    const l = line()
    const fields = classifyLineConflicts(l)
    expect(fields.find((f) => f.field === 'amount')?.kind).toBe('derived')
    const mine = mergedLinePreview(l, new Map([[k(l, 'quantity'), 'mine' as const]]))
    expect(mine.quantity).toBe(107)
    expect(mine.amount).toBe(107) // 107 × $1, not their 110 nor a copied figure
    expect(mine.item_description).toBe('Splice kit')
    expect(mine.note).toBe('theirs')
    const theirs = mergedLinePreview(l, new Map([[k(l, 'quantity'), 'theirs' as const]]))
    expect(theirs.amount).toBe(110)
    // A float input stays a clean figure.
    expect(
      recomputeDerived({ price: 2.1, quantity: 9 }, [
        { field: 'total', formula: 'item.price * item.quantity' }
      ]).total
    ).toBe(18.9)
  })

  it('the preview names touched fields only, never ids or bookkeeping keys', () => {
    expect(previewFields(line())).toEqual(['quantity', 'amount', 'item_description'])
    expect(previewFields(line(), (f) => f === 'item_description')).toEqual(['quantity', 'amount'])
    expect(
      previewFields(
        line({ edit: { cifa_id: 3, workflow: 1, quantity: 2 } }),
        (f) => f === 'workflow'
      )
    ).toEqual(['quantity', 'amount'])
  })
})

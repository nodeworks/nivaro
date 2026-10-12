import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  PREFILL_LIMIT,
  planLineOps,
  projectRows,
  sameValue
} from '../../../services/addendum-lines.js'

const cols = new Set(['id', 'workflow', 'amount', 'quantity', 'item_description', 'changed'])

describe('sameValue', () => {
  it('treats blanks alike', () => {
    expect(sameValue(null, '')).toBe(true)
    expect(sameValue(undefined, null)).toBe(true)
    expect(sameValue(0, null)).toBe(false)
  })
  it('compares numbers across string/number shapes', () => {
    expect(sameValue('1050.84', 1050.84)).toBe(true)
    expect(sameValue(1050.84, 1050.85)).toBe(false)
  })
  it('compares dates across Date/ISO shapes', () => {
    expect(sameValue(new Date('2026-08-07T07:00:05.475Z'), '2026-08-07T07:00:05.475Z')).toBe(true)
    expect(sameValue('2026-08-07', '2026-08-08')).toBe(false)
  })
  it('compares booleans across bit shapes', () => {
    expect(sameValue(true, 1)).toBe(true)
    expect(sameValue(false, 'true')).toBe(false)
  })
})

describe('planLineOps', () => {
  const current = [
    { id: 1, workflow: 9, amount: 100, quantity: 1, changed: new Date('2026-01-01') },
    { id: 2, workflow: 9, amount: 200, quantity: 2 },
    { id: 3, workflow: 9, amount: 300, quantity: 3 }
  ]

  it('patches only what the author changed, never the fk or stamps', () => {
    const proposed = [
      { id: 1, workflow: 9, amount: 150, quantity: 1, changed: '2026-02-02T00:00:00Z' },
      { id: 2, workflow: 9, amount: 200, quantity: 2 },
      { id: 3, workflow: 9, amount: 300, quantity: 3 }
    ]
    const ops = planLineOps(proposed, current, null, 'workflow', cols)
    expect(ops.updates).toEqual([{ id: 1, patch: { amount: 150 }, prior: { amount: 100 } }])
    expect(ops.creates).toEqual([])
    expect(ops.deletes).toEqual([])
  })

  it('reads changes against the draft-time base, so a later import is kept', () => {
    const base = [
      { id: 1, amount: 100, quantity: 1 },
      { id: 2, amount: 200, quantity: 2 },
      { id: 3, amount: 300, quantity: 3 }
    ]
    // Line 2's amount moved to 250 after the draft (PO import); the proposal
    // still carries the pre-filled 200 — that is NOT the author's change.
    const live = current.map((r) => (r.id === 2 ? { ...r, amount: 250 } : r))
    const proposed = [
      { id: 1, amount: 100, quantity: 5 },
      { id: 2, amount: 200, quantity: 2 },
      { id: 3, amount: 300, quantity: 3 }
    ]
    const ops = planLineOps(proposed, live, base, 'workflow', cols)
    expect(ops.updates).toEqual([{ id: 1, patch: { quantity: 5 }, prior: { quantity: 1 } }])
  })

  it('creates id-less rows and removes base rows the proposal dropped', () => {
    const proposed = [
      { id: 1, amount: 100, quantity: 1 },
      { amount: 50, quantity: 1, item_description: 'New line', __prefilled: true }
    ]
    const ops = planLineOps(proposed, current, null, 'workflow', cols)
    expect(ops.creates).toEqual([{ amount: 50, quantity: 1, item_description: 'New line' }])
    expect(ops.deletes.map((r) => r.id)).toEqual([2, 3])
  })

  it('never resurrects a line deleted after the draft', () => {
    const base = [...current]
    const live = current.filter((r) => r.id !== 3)
    const ops = planLineOps(current, live, base, 'workflow', cols)
    expect(ops.creates).toEqual([])
    expect(ops.deletes).toEqual([])
  })

  it('does not read a capped pre-fill as removals', () => {
    const many = Array.from({ length: PREFILL_LIMIT + 5 }, (_, i) => ({ id: i + 1, amount: 1 }))
    const ops = planLineOps(many.slice(0, PREFILL_LIMIT), many, null, 'workflow', cols)
    expect(ops.deletes).toEqual([])
  })
})

describe('projectRows', () => {
  it('keeps ids and readable columns only', () => {
    expect(projectRows([{ id: 1, amount: 2, secret: 3 }], ['amount'])).toEqual([
      { id: 1, amount: 2 }
    ])
    expect(projectRows([{ id: 1, secret: 3 }], null)).toEqual([{ id: 1, secret: 3 }])
  })
})

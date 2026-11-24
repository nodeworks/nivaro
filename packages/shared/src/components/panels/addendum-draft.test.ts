import { describe, expect, it } from 'vitest'
import {
  draftHasWork,
  draftProposes,
  missingRequiredChanges,
  proposedFieldChanges,
  proposedLineChanges
} from './addendum-draft'

const line = {
  id: 446143,
  workflow: 368943,
  quantity: 50000,
  price: 1,
  amount: 50000,
  item_description: 'Labor',
  changed: '2026-05-14T10:31:03.722Z'
}

describe('proposedLineChanges', () => {
  it('pre-filled lines left alone change nothing (workflow 368943)', () => {
    expect(
      proposedLineChanges(
        [{ __prefilled: true, ...line }],
        [{ __prefilled: true, ...line }],
        'workflow'
      )
    ).toBe(0)
  })
  it('Close Out Lines (quantity down) is a change', () => {
    expect(
      proposedLineChanges(
        [{ __prefilled: true, ...line, quantity: 0, amount: 0 }],
        [line],
        'workflow'
      )
    ).toBe(1)
  })
  it('an added and a removed line both count', () => {
    expect(
      proposedLineChanges([{ item_description: 'New', quantity: 1 }], [line], 'workflow')
    ).toBe(2)
  })
  it('a number sent back as text is not a change', () => {
    expect(proposedLineChanges([{ ...line, quantity: '50000' }], [line], 'workflow')).toBe(0)
  })
})

describe('proposedFieldChanges', () => {
  it('skips values equal to the parent and derived fields', () => {
    expect(
      proposedFieldChanges(
        { requisition_amount: 50000, title: 'x', total: 9 },
        { requisition_amount: '50000', title: 'y', total: 1 },
        (f) => f === 'total'
      )
    ).toEqual(['title'])
  })
})

describe('draft verdicts', () => {
  it('typed notes are work but not a proposal', () => {
    const c = { fields: 0, changedFields: [], lines: 0, typed: true }
    expect(draftHasWork(c)).toBe(true)
    expect(draftProposes(c)).toBe(false)
  })
  it('an untouched sheet has neither', () => {
    const c = { fields: 0, changedFields: [], lines: 0, typed: false }
    expect(draftHasWork(c)).toBe(false)
    expect(draftProposes(c)).toBe(false)
  })
})

describe('missingRequiredChanges', () => {
  const label = (f: string) => f.toUpperCase()
  const assignments = [
    { field: 'workflow_lines', overrides: '{"require_change":true}' },
    { field: 'requisition_amount', overrides: { prefill_from_parent: true } },
    { field: 'notes', overrides: { require_change: true }, label_override: 'Why' }
  ]
  it('lists required fields the draft leaves alone, with their labels', () => {
    expect(missingRequiredChanges(assignments, [], label)).toEqual([
      { field: 'workflow_lines', label: 'WORKFLOW_LINES' },
      { field: 'notes', label: 'Why' }
    ])
  })
  it('a changed required field drops off', () => {
    expect(missingRequiredChanges(assignments, ['workflow_lines', 'notes'], label)).toEqual([])
  })
})

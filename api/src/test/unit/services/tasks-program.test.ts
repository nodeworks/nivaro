import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { describeDoneWhen, normalizeDoneWhen, TaskInputError } = await import(
  '../../../services/tasks.js'
)

describe('normalizeDoneWhen', () => {
  it('accepts a list or its JSON text, keeps field/op/value', () => {
    expect(normalizeDoneWhen([{ field: 'requisition_id' }])).toBe(
      JSON.stringify([{ field: 'requisition_id', op: 'nnull', value: null }])
    )
    expect(normalizeDoneWhen('[{"field":"status","op":"eq","value":"done"}]')).toBe(
      JSON.stringify([{ field: 'status', op: 'eq', value: 'done' }])
    )
  })
  it('treats empty as no condition', () => {
    expect(normalizeDoneWhen(null)).toBeNull()
    expect(normalizeDoneWhen('')).toBeNull()
    expect(normalizeDoneWhen([])).toBeNull()
  })
  it('refuses what is not a condition list', () => {
    expect(() => normalizeDoneWhen('{')).toThrow(TaskInputError)
    expect(() => normalizeDoneWhen({ field: 'x' })).toThrow(TaskInputError)
  })
})

describe('describeDoneWhen', () => {
  it('reads the way the history line should', () => {
    const labels = new Map([['requisition_id', 'REQ ID']])
    expect(describeDoneWhen([{ field: 'requisition_id', op: 'nnull', value: null }], labels)).toBe(
      'REQ ID was entered'
    )
    expect(
      describeDoneWhen(
        [
          { field: 'status', op: 'eq', value: 'approved' },
          { field: 'workflow_line_items:workflow', op: 'related_some', value: null }
        ],
        new Map()
      )
    ).toBe('status is approved and workflow line items were added')
  })
})

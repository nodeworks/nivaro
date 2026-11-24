import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))

import { fieldChanged, noChangeRefusal } from './addendum-required.js'

const line = { id: 446143, workflow: 368943, quantity: 50000, price: 1, amount: 50000 }
const writable = new Set(['id', 'workflow', 'quantity', 'price', 'amount'])
const lines = (current = [line]) => ({ current, fk: 'workflow', writable })

describe('fieldChanged — line tables', () => {
  it('the record’s own lines change nothing (workflow 368943)', () => {
    expect(fieldChanged('workflow_lines', { workflow_lines: [{ ...line }] }, {}, lines())).toBe(
      false
    )
  })
  it('a line closed out is a change', () => {
    expect(
      fieldChanged(
        'workflow_lines',
        { workflow_lines: [{ ...line, quantity: 0, amount: 0 }] },
        {},
        lines()
      )
    ).toBe(true)
  })
  it('an added or removed line is a change', () => {
    expect(
      fieldChanged('workflow_lines', { workflow_lines: [line, { quantity: 1 }] }, {}, lines())
    ).toBe(true)
    expect(fieldChanged('workflow_lines', { workflow_lines: [] }, {}, lines())).toBe(true)
  })
  it('no lines in the proposal change nothing', () => {
    expect(fieldChanged('workflow_lines', {}, {}, lines())).toBe(false)
  })
})

describe('fieldChanged — plain fields', () => {
  it('a value equal to the record’s (number as text) is not a change', () => {
    expect(fieldChanged('amount', { amount: '50000' }, { amount: 50000 }, null)).toBe(false)
    expect(fieldChanged('amount', {}, { amount: 50000 }, null)).toBe(false)
  })
  it('a different value is', () => {
    expect(fieldChanged('amount', { amount: 1 }, { amount: 50000 }, null)).toBe(true)
  })
})

describe('noChangeRefusal', () => {
  it('names the fields', () => {
    const r = noChangeRefusal([{ field: 'workflow_lines', label: 'Workflow lines' }])
    expect(r.code).toBe('ADDENDUM_NO_CHANGE')
    expect(r.fields).toEqual(['workflow_lines'])
    expect(r.error).toContain('Workflow lines')
  })
})

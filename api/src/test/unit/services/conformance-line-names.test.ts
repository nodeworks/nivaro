import { describe, expect, it } from 'vitest'
import { lineHeadFor, namedLine } from '../../../services/config-conformance.js'
import { splitLineFinding } from '../../../services/dashboard-feed.js'
import {
  lineCarriesMoney,
  lineIsUnused,
  undoSnapshot
} from '../../../services/integrity-proposals.js'

// army9 b02: the integrity panel named lines by row id ("Line #163116") and
// offered no way to remove an empty line hidden from the grid.
const IR_LINES = [
  { id: 163114, cifa: 39767, quantity: 5, price: null, total: null },
  { id: 163115, cifa: 40011, quantity: 2, price: 0.07, total: 0.18 },
  { id: 163116, cifa: null, quantity: 1, price: null, total: null }
]

describe('integrity line names', () => {
  it('a grid without line numbers names a line by its place, never its id', () => {
    expect(lineHeadFor(IR_LINES, IR_LINES[2], null)).toBe('Line 3')
    expect(lineHeadFor(IR_LINES, IR_LINES[0], null)).toBe('Line 1')
  })

  it('a numbered grid keeps its numbers; a line missing one reads "Unnumbered line N"', () => {
    const wf = [
      { id: 1, line_number: 1 },
      { id: 2, line_number: null },
      { id: 3, line_number: 3 }
    ]
    expect(lineHeadFor(wf, wf[0], 'line_number')).toBe('Line 1')
    expect(lineHeadFor(wf, wf[1], 'line_number')).toBe('Unnumbered line 2')
  })

  it('finds the line a message names — new names and the old "#id" form', () => {
    expect(namedLine(IR_LINES, 'Line 3: CIFA is empty', null)).toBe(IR_LINES[2])
    expect(namedLine(IR_LINES, 'Line #163115: Expenditure Type is empty', null)).toBe(IR_LINES[1])
    expect(namedLine(IR_LINES, 'Vendor is required', null)).toBeUndefined()
    expect(namedLine(IR_LINES, 'Line 9: x', null)).toBeNull()
    const wf = [
      { id: 1, line_number: 3 },
      { id: 2, line_number: null },
      { id: 3, line_number: 1 }
    ]
    expect(namedLine(wf, 'Line 3: x', 'line_number')).toBe(wf[0])
    expect(namedLine(wf, 'Unnumbered line 2: x', 'line_number')).toBe(wf[1])
    // army9 review M6: on a numbered grid an unmatched number is NO line —
    // never the line at that position.
    expect(namedLine(wf, 'Line 2: x', 'line_number')).toBeNull()
    // …and an "Unnumbered" line that has since got a number is not it either.
    expect(namedLine(wf, 'Unnumbered line 1: x', 'line_number')).toBeNull()
  })

  it('the dashboard feed splits the new line names too', () => {
    expect(splitLineFinding('Unnumbered line 2: Category is empty')).toEqual({
      line: '2',
      message: 'Category is empty'
    })
  })

  it('only a line with no money on it is offered for removal', () => {
    expect(lineCarriesMoney(IR_LINES[2])).toBe(false)
    expect(lineCarriesMoney(IR_LINES[1])).toBe(true)
    expect(lineCarriesMoney({ id: 1, amount: '0.00', quantity: 4 })).toBe(false)
    expect(lineCarriesMoney({ id: 1, line_total: 12.5 })).toBe(true)
  })
})

// army9 review M3: only a line with nothing a person filled is offered for
// removal, and its undo never carries a field the caller cannot read/create.
describe('remove-line proposal', () => {
  const opts = { fkField: 'inventory_request', derived: new Set(['expenditure_type']) }
  it('a line with no item, price or note is unused (a bare quantity counts nothing)', () => {
    expect(
      lineIsUnused(
        { id: 1, inventory_request: 9, cifa: null, quantity: 1, price: null, expenditure_type: 7 },
        opts
      )
    ).toBe(true)
  })
  it('an item, a note or money makes it used', () => {
    expect(lineIsUnused({ id: 1, inventory_request: 9, cifa: 5, quantity: 5 }, opts)).toBe(false)
    expect(lineIsUnused({ id: 1, inventory_request: 9, notes: 'keep me' }, opts)).toBe(false)
    expect(lineIsUnused({ id: 1, inventory_request: 9, price: 2 }, opts)).toBe(false)
  })
  it('the undo keeps only fields the caller read and may create', () => {
    const read = {
      id: 7,
      created: 'x',
      inventory_request: 9,
      quantity: 1,
      vendor: { id: 3, name: 'Acme' },
      materials: [{ id: 1 }]
    }
    // `secret_cost` was never in the caller's read, so it cannot appear.
    expect(undoSnapshot(read, ['inventory_request', 'quantity', 'vendor'])).toEqual({
      inventory_request: 9,
      quantity: 1,
      vendor: 3
    })
    expect(undoSnapshot(read, ['quantity'])).toEqual({ quantity: 1 })
    expect(undoSnapshot(read, null)).toEqual({ inventory_request: 9, quantity: 1, vendor: 3 })
    expect(undoSnapshot(read, [])).toEqual({})
  })
})

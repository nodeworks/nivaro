import { describe, expect, it } from 'vitest'
import { lineComputeError, MAX_LINE_MONEY, qtyEntryProblem } from './CatalogPickerField'

// army5 b02-N7: qty 999,999,999 × $13.67 staged fine and the record's Save
// failed on the line ("Total must be smaller than 10,000,000,000").
describe('lineComputeError', () => {
  const compute = { total: 'quantity * price' }
  const labelOf = (f: string) => (f === 'total' ? 'Total' : f)
  it('refuses a quantity whose total does not fit the money column', () => {
    const err = lineComputeError({
      compute,
      probe: { quantity: 999_999_999, price: 13.67 },
      ruleError: () => null,
      labelOf
    })
    expect(err).toMatch(/^Total would be .* — too large to save$/)
  })
  it("the line's own rule on the computed column wins (the server's words)", () => {
    const err = lineComputeError({
      compute,
      probe: { quantity: 999_999_999, price: 13.67 },
      ruleError: (f, v) =>
        f === 'total' && Number(v) >= 10_000_000_000
          ? 'Total must be smaller than 10,000,000,000'
          : null,
      labelOf
    })
    expect(err).toBe('Total must be smaller than 10,000,000,000')
  })
  it('a normal quantity passes', () => {
    expect(
      lineComputeError({
        compute,
        probe: { quantity: 17, price: 13.67 },
        ruleError: () => null,
        labelOf
      })
    ).toBeNull()
    expect(MAX_LINE_MONEY).toBe(9_999_999_999.99)
  })
})

// army5 b01-N10: 2.05 on a whole-number quantity emptied the row on Tab.
describe('qtyEntryProblem', () => {
  it('a decimal on a whole-number column → "Whole numbers only"', () => {
    expect(qtyEntryProblem('2.05', 'integer')).toBe('Whole numbers only')
  })
  it('whole numbers, decimals on a decimal column and blank are fine', () => {
    expect(qtyEntryProblem('3', 'integer')).toBeNull()
    expect(qtyEntryProblem('2.05', 'decimal')).toBeNull()
    expect(qtyEntryProblem('', 'integer')).toBeNull()
  })
  it('negative → the shared check message', () => {
    expect(qtyEntryProblem('-5', 'integer')).toBe("Quantity can't be negative")
  })
})

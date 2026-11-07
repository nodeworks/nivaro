import { describe, expect, it } from 'vitest'
import { lineComputeError, MAX_LINE_MONEY, qtyEntryProblem } from './CatalogPickerField'
import { decimalPlacesProblem } from './line-qty'
import { roundCents } from './NestedRelationEditor'

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

// army6 H5: a hand price 0.005 × 3 showed $0.02, stored price 0.01 / total 0.01.
describe('decimalPlacesProblem', () => {
  it('refuses a price past 2 decimals', () => {
    expect(decimalPlacesProblem('0.005', 'Price')).toBe('Price takes 2 decimals')
    expect(decimalPlacesProblem('5e-3', 'Price')).toBe('Price takes 2 decimals')
    expect(decimalPlacesProblem(100.505, 'Price')).toBe('Price takes 2 decimals')
  })
  it('takes whole numbers, cents and trailing zeros; blank is not its business', () => {
    expect(decimalPlacesProblem('0.01', 'Price')).toBeNull()
    expect(decimalPlacesProblem('1.50', 'Price')).toBeNull()
    expect(decimalPlacesProblem('1.500', 'Price')).toBeNull()
    expect(decimalPlacesProblem('12', 'Price')).toBeNull()
    expect(decimalPlacesProblem('', 'Price')).toBeNull()
    expect(decimalPlacesProblem('abc', 'Price')).toBeNull()
  })
  it('a 2-decimal price × qty is the stored total (0.01 × 3 = 0.03)', () => {
    expect(
      lineComputeError({
        compute: { total: 'round(price, 2) * quantity' },
        probe: { quantity: 3, price: 0.01 },
        ruleError: () => null,
        labelOf: (f) => f
      })
    ).toBeNull()
  })
})

// army6 L2: Unit Workflows "remaining: -301.515".
describe('roundCents', () => {
  it('rounds a remaining figure to the cent', () => {
    expect(roundCents(0.1 + 0.2)).toBe(0.3)
    expect(roundCents(1.005)).toBe(1.01)
    expect(Math.abs(roundCents(-301.515) + 301.52) < 0.011).toBe(true)
    expect(String(roundCents(-301.515)).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2)
    expect(Object.is(roundCents(-0.001), 0)).toBe(true)
  })
})

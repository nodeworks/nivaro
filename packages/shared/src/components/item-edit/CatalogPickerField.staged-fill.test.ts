import { describe, expect, it } from 'vitest'
import { qtyEntryProblem, relatedParentTokens, stagedCatalogFill } from './CatalogPickerField'

// army 11 f2: BOM-staged lines showed "$0.00 · No catalog price" up to Create
// while the save priced them from the warehouse ($16,773.38).
describe('stagedCatalogFill', () => {
  const source = (prices: Record<string, unknown>) => (t: string) => prices[t]

  it('an unpriced staged line takes the catalog (warehouse) price', () => {
    const out = stagedCatalogFill(
      { cifa: 1, quantity: 4 },
      ['price'],
      source({ price: 13.67 }),
      undefined
    )
    expect(out).toEqual({ updates: { price: 13.67 }, auto: { price: '13.67' } })
  })

  it('follows a warehouse change only while the price is still the one filled here', () => {
    const auto = { price: '13.67' }
    expect(
      stagedCatalogFill({ cifa: 1, price: 13.67 }, ['price'], source({ price: 13.41 }), auto)
    ).toEqual({ updates: { price: 13.41 }, auto: { price: '13.41' } })
    // Typed by the person (or carried by the file): kept.
    expect(
      stagedCatalogFill({ cifa: 1, price: 12 }, ['price'], source({ price: 13.41 }), auto)
    ).toBeNull()
    expect(
      stagedCatalogFill({ cifa: 1, price: 12 }, ['price'], source({ price: 13.41 }), undefined)
    ).toBeNull()
  })

  it('no catalog price: nothing to fill (the line still says so)', () => {
    expect(stagedCatalogFill({ cifa: 1 }, ['price'], source({}), undefined)).toBeNull()
  })
})

describe('qtyEntryProblem (army 11 f2)', () => {
  it('refuses exponent notation instead of reading 1e3 as 1,000', () => {
    expect(qtyEntryProblem('1e3', 'integer')).toBe('Type the quantity in full digits')
    expect(qtyEntryProblem('1000', 'integer')).toBeNull()
  })
})

describe('relatedParentTokens', () => {
  it('names nested $parent fields (count_all sends only these)', () => {
    expect([
      ...relatedParentTokens({
        inventory_request: {
          _and: [{ supporting_warehouse: { _eq: '$parent.supporting_warehouse' } }]
        }
      })
    ]).toEqual(['supporting_warehouse'])
  })
})

import { describe, expect, it } from 'vitest'
import {
  gridPriceValue,
  issuesAfterLinesChanged,
  isUnpricedLine,
  savedLinesSignature
} from './CatalogPickerField'

// army6 L5: "Total would be … too large to save — still 2" stayed under the
// line after a later successful Save.
describe('quantity notes after a save', () => {
  it('a changed read of the saved lines is a different signature; a re-read is not', () => {
    const fields = ['cifa', 'quantity', 'price']
    const a = savedLinesSignature([{ id: 1, cifa: 9, quantity: 2, price: 13.41 }], fields)
    const same = savedLinesSignature([{ id: 1, cifa: 9, quantity: 2, price: 13.41 }], fields)
    const saved = savedLinesSignature([{ id: 1, cifa: 9, quantity: 3, price: 13.41 }], fields)
    expect(same).toBe(a)
    expect(saved).not.toBe(a)
  })
  it('refusals go, an open "Remove this line?" ask stays', () => {
    const issues = {
      a: { kind: 'error', message: 'Total would be 13,409,999,986.59 — too large to save' },
      b: { kind: 'remove', row: {} }
    }
    expect(issuesAfterLinesChanged(issues)).toEqual({ b: { kind: 'remove', row: {} } })
    const none = { b: { kind: 'remove' } }
    expect(issuesAfterLinesChanged(none)).toBe(none)
  })
})

// army6 L3: item 113942 (no catalog price) gave a $0.00 line in silence.
describe('isUnpricedLine', () => {
  it('a picked line whose money is 0 or empty', () => {
    expect(isUnpricedLine({ quantity: 3, total: 0 }, 'quantity', ['total'])).toBe(true)
    expect(isUnpricedLine({ quantity: 3, total: null }, 'quantity', ['total'])).toBe(true)
  })
  it('a priced line, a 0-quantity line or no money column is quiet', () => {
    expect(isUnpricedLine({ quantity: 3, total: 14.76 }, 'quantity', ['total'])).toBe(false)
    expect(isUnpricedLine({ quantity: 0, total: 0 }, 'quantity', ['total'])).toBe(false)
    expect(isUnpricedLine({ quantity: 3 }, 'quantity', [])).toBe(false)
  })
})

// army6 L2: the Non-Unit catalog grid showed Price "—" for items the
// supporting warehouse prices ($6,810 appeared only after the pick).
describe('gridPriceValue', () => {
  const copyFields = { price: 'price' }
  const related = [{ key: 'wh_price', copy_to: 'price' }]
  it('the warehouse price the line will take, first', () => {
    expect(
      gridPriceValue({
        field: 'price',
        catalogValue: null,
        copyFields,
        related,
        lookup: (k) => (k === 'wh_price' ? 6810 : undefined)
      })
    ).toBe(6810)
  })
  it("else the catalog's own value; other columns untouched", () => {
    expect(
      gridPriceValue({
        field: 'price',
        catalogValue: 12,
        copyFields,
        related,
        lookup: () => undefined
      })
    ).toBe(12)
    expect(
      gridPriceValue({
        field: 'description',
        catalogValue: 'BATTERY 6V',
        copyFields,
        related,
        lookup: () => 6810
      })
    ).toBe('BATTERY 6V')
  })
})

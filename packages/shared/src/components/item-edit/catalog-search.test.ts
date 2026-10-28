import { describe, expect, it } from 'vitest'
import { catalogRowTier, orderCatalogMatches, rowMatchesFields } from './catalog-search'

const fields = ['cifa_number', 'description']
const row = (
  id: number,
  cifa: string,
  description: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  cifa_number: cifa,
  description,
  ...extra
})

describe('catalog search order (#20)', () => {
  it('tiers: exact CIFA # → CIFA # prefix → description words → other', () => {
    expect(catalogRowTier(row(1, '1002', 'Cable'), fields, '1002')).toBe(0)
    expect(catalogRowTier(row(2, '10021', 'Cable'), fields, '1002')).toBe(2)
    expect(catalogRowTier(row(3, '77', 'Jumper, fiber LC'), fields, 'fiber jum')).toBe(4)
    expect(catalogRowTier(row(4, '77', 'Subfiber'), fields, 'fiber')).toBe(5)
    // Matched only on a column the row does not show.
    expect(catalogRowTier(row(5, '77', 'Cable', { mfr: 'PPC' }), fields, 'ppc')).toBe(6)
  })

  it('puts the exact hit first, then recent picks, then shown by tier, then other fields', () => {
    const shown = [
      row(10, '10021', 'Cable'),
      row(11, '9', 'Kit 1002 spare'),
      row(12, '1002', 'Cable'),
      row(13, '10029', 'Cable')
    ]
    const recent = [row(13, '10029', 'Cable'), row(20, '3', 'Has 1002 inside', { mfr: 'x' })]
    const other = [row(30, '5', 'Box', { mfr: '1002 Corp' }), row(10, '10021', 'Cable')]
    const ids = orderCatalogMatches({ shown, other, recent, shownFields: fields, q: '1002' }).map(
      (r) => r.id
    )
    expect(ids).toEqual([12, 13, 20, 10, 11, 30])
  })

  it('an exact recent pick still sorts with the exact hits', () => {
    const ids = orderCatalogMatches({
      shown: [row(1, '1002a', 'x')],
      other: [],
      recent: [row(2, '1002', 'y')],
      shownFields: fields,
      q: '1002'
    }).map((r) => r.id)
    expect(ids).toEqual([2, 1])
  })

  it('a shown match needs every word in the shown fields', () => {
    expect(rowMatchesFields(row(1, 'LC-1', 'Fiber jumper'), fields, 'lc jumper')).toBe(true)
    expect(rowMatchesFields(row(1, 'LC-1', 'Fiber jumper'), fields, 'lc ppc')).toBe(false)
    expect(rowMatchesFields(row(1, 'LC-1', 'x'), [], 'lc')).toBe(false)
  })
})

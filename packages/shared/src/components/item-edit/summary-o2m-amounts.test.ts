import { describe, expect, it } from 'vitest'
import { o2mAmountOf } from './SummaryPanel'

// army8 b12 (via fix-stock): a request seeded with {cifa, quantity, price}
// read "8 rows $117.15" — the sum of unit prices — where its lines totalled
// $1,568.60.
describe('o2mAmountOf', () => {
  const sum = (rows: Array<Record<string, unknown>>) => {
    const a = o2mAmountOf(rows)
    return a ? rows.reduce((t, r) => t + (a.of(r) ?? 0), 0) : null
  }

  it('never sums unit prices: price × quantity when no total exists', () => {
    const rows = [
      { price: 13.41, quantity: 3 },
      { price: 2.75, quantity: 4 }
    ]
    expect(o2mAmountOf(rows)?.currency).toBe(true)
    expect(sum(rows)).toBeCloseTo(51.23, 2)
  })

  it('uses a stored total, and price × quantity for a seeded row without one', () => {
    const rows = [
      { total: 40.23, price: 13.41, quantity: 3 },
      { total: null, price: 2.75, quantity: 4 }
    ]
    expect(sum(rows)).toBeCloseTo(51.23, 2)
  })

  it('counts quantities (not money) when there is no money at all', () => {
    const a = o2mAmountOf([{ quantity: 2 }, { quantity: '5' }])
    expect(a?.currency).toBe(false)
    expect(sum([{ quantity: 2 }, { quantity: '5' }])).toBe(7)
  })

  it('a price with no quantity is not an amount', () => {
    expect(o2mAmountOf([{ price: 9.99 }])).toBeNull()
  })
})

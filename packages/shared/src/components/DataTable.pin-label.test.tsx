import { describe, expect, it } from 'vitest'
import { pinColumnName } from './DataTable'

// Army 8 b08-N3: screen readers announced "Pin column extra.requisition_amount".
describe('pinColumnName', () => {
  it('uses the header a person sees', () => {
    expect(pinColumnName({ key: 'extra.requisition_amount', header: 'REQ $' })).toBe('REQ $')
    expect(
      pinColumnName({
        key: 'extra.funding_years.id',
        header: (
          <span>
            Funding <b>Year</b>
          </span>
        )
      })
    ).toBe('Funding Year')
  })
  it('falls back to the path’s last part in words, never the raw path', () => {
    expect(pinColumnName({ key: 'extra.purchase_orders.number', header: null })).toBe('Number')
    expect(pinColumnName({ key: 'label', header: '' })).toBe('Label')
  })
})

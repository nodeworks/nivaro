import { describe, expect, it } from 'vitest'
import { columnLabel, emptyOptionsText, fmtDisplay } from './TransitionRequirementsDialog'

describe('requirements dialog wording (army6 M2 / M30)', () => {
  it('prices keep up to 4 decimals', () => {
    expect(fmtDisplay(100.505, 'currency')).toBe('$100.505')
    expect(fmtDisplay(14, 'currency')).toBe('$14.00')
    expect(fmtDisplay(0.0125, 'currency')).toBe('$0.0125')
  })

  it('a header that is still the raw column name reads as words', () => {
    expect(columnLabel({ field: 'line_number', label: 'line_number' })).toBe('Line Number')
    expect(columnLabel({ field: 'price', label: 'price' })).toBe('Price')
    expect(columnLabel({ field: 'quantity', label: 'Qty' })).toBe('Qty')
    expect(columnLabel({ field: 'item_description', label: '' })).toBe('Item Description')
  })

  it('an empty narrowed picker says why and what to do', () => {
    expect(emptyOptionsText({ label: 'Category' }, { project: { _eq: 130979 } })).toBe(
      'This project has no categories set up. Ask an administrator, or pick another project.'
    )
    expect(
      emptyOptionsText({ label: 'Category' }, { _and: [{ project: { id: { _eq: 1 } } }] })
    ).toBe('This project has no categories set up. Ask an administrator, or pick another project.')
    expect(emptyOptionsText({ label: 'Warehouse' }, undefined)).toBe(
      'No warehouses are set up yet. Ask an administrator.'
    )
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeSetAllRows } from './SetAllRowsButton'

describe('normalizeSetAllRows (options.set_all_rows)', () => {
  it('keeps plain fields, defaults admin_only on, accepts bare strings', () => {
    expect(
      normalizeSetAllRows([
        { field: 'requisition_id', label: ' REQ ID ' },
        'po_number',
        { field: 'note', admin_only: false }
      ])
    ).toEqual([
      { field: 'requisition_id', label: 'REQ ID', admin_only: true },
      { field: 'po_number', admin_only: true },
      { field: 'note', admin_only: false }
    ])
  })
  it('drops junk and dotted paths', () => {
    expect(normalizeSetAllRows([null, {}, { field: 'a.b' }, 3])).toEqual([])
    expect(normalizeSetAllRows('requisition_id')).toEqual([])
  })
})

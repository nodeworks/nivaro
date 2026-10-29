import { describe, expect, it } from 'vitest'
import { changeLines } from './changes-lines'

describe('changeLines (#3079)', () => {
  it('formats values, relation labels and text diffs', () => {
    const lines = changeLines({
      collection: 'orders',
      item: '1',
      revision_id: 5,
      at: null,
      notified_at: null,
      changes: [
        { field: 'total_amount', label: null, type: 'decimal', old: 1000, new: 1250.5 },
        {
          field: 'vendor',
          label: 'Vendor',
          type: 'integer',
          old: 1,
          new: 2,
          old_label: 'Acme',
          new_label: 'Globex'
        },
        { field: 'approved', label: 'Approved', type: 'boolean', old: false, new: true },
        {
          field: 'notes',
          label: 'Notes',
          type: 'text',
          old: null,
          new: null,
          diff: { lead: '…the ', removed: 'cat', added: 'dog', trail: ' sat' }
        }
      ]
    })
    expect(lines[0]).toMatchObject({ label: 'Total Amount', old: '1,000', new: '1,250.5' })
    expect(lines[1]).toMatchObject({ old: 'Acme', new: 'Globex' })
    expect(lines[2]).toMatchObject({ old: 'No', new: 'Yes' })
    expect(lines[3]).toMatchObject({ old: '', new: '', diff: { removed: 'cat', added: 'dog' } })
  })
  it('nothing loaded = no lines', () => {
    expect(changeLines(null)).toEqual([])
  })
})

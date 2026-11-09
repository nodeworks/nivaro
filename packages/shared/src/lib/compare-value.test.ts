import { describe, expect, it } from 'vitest'
import { compareSideName } from '../components/RecordCompare'
import { compareValueText } from './compare-value'

// Army 11 staging check (0.3.95): record compare showed "#367714" headings,
// "hold_final_10" (a raw choice key) and unformatted money/dates.

describe('compareValueText', () => {
  it('a choice reads by its label, never its key', () => {
    const meta = {
      type: 'string',
      interface: 'select-dropdown',
      options: {
        choices: [
          { text: 'Hold Final 10%', value: 'hold_final_10' },
          { text: 'Release Full Payment', value: 'release_full' }
        ]
      }
    }
    expect(compareValueText('hold_final_10', meta)).toBe('Hold Final 10%')
    expect(compareValueText(['hold_final_10', 'release_full'], meta)).toBe(
      'Hold Final 10%, Release Full Payment'
    )
    // Options stored as JSON text read the same.
    expect(compareValueText('release_full', { options: JSON.stringify(meta.options) })).toBe(
      'Release Full Payment'
    )
  })
  it('money as money, yes/no in words, whole numbers ungrouped', () => {
    expect(
      compareValueText('3703.68', {
        type: 'decimal',
        options: { format: 'currency', currency: 'USD' }
      })
    ).toBe('$3,703.68')
    expect(compareValueText(1, { type: 'boolean' })).toBe('Yes')
    expect(compareValueText(false)).toBe('No')
    expect(compareValueText(1234567, { type: 'integer' })).toBe('1234567')
    expect(compareValueText('1234.5', { type: 'decimal' })).toBe('1,234.5')
  })
  it('dates local; a date-only value never shifts a day', () => {
    expect(compareValueText('2026-11-08', { type: 'date' })).toContain('2026')
    expect(compareValueText('2026-11-08', { type: 'date' })).toContain('8')
    expect(compareValueText('2026-11-08T20:13:00.000Z', { type: 'timestamp' })).toMatch(/2026/)
    expect(compareValueText('2026-11-08T20:13:00.000Z', { type: 'timestamp' })).not.toContain('T20')
  })
  it('blank reads as a dash', () => {
    expect(compareValueText(null)).toBe('—')
    expect(compareValueText([])).toBe('—')
  })
})

describe('compareSideName', () => {
  const meta = { friendly_id_field: 'workflow_id' }
  it('the business id, never the row id', () => {
    expect(
      compareSideName(meta, { id: 367714, workflow_id: 'MM26-81441' }, 367714, 'workflows', 0)
    ).toBe('MM26-81441')
  })
  it('no business id: the record’s own words, else "Record N"', () => {
    const n = compareSideName(meta, { id: 1, name: 'Draft A' }, 1, 'workflows', 0)
    expect(n).toContain('Draft A')
    expect(n).not.toContain('#')
    expect(compareSideName(null, null, 367714, 'workflows', 1)).toBe('Record 2')
  })
})

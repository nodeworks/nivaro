import { describe, expect, it } from 'vitest'
import { applyValidationRule } from '../../lib/validation-rules'
import { changedRowFields } from './line-qty'

// The server judges validation_rules only on the fields a write carries
// (api services/validation-rules.ts enforceValidationRules). This mirrors that
// over what a line grid sends for each edited row.
const rules = { quantity: [{ type: 'min', value: 0, message: 'Quantity can not be negative' }] }
function judge(payload: Record<string, unknown>): string | null {
  for (const [field, list] of Object.entries(rules)) {
    if (!(field in payload)) continue
    for (const rule of list) {
      const err = applyValidationRule(rule, payload[field], field, payload)
      if (err) return err
    }
  }
  return null
}

const writable = new Set(['quantity', 'price', 'description', '_change_reason'])
const legacy = { id: 1, quantity: -5, price: 10, description: 'close-out' }
const other = { id: 2, quantity: 3, price: 4, description: 'splitter' }

describe('line edits are judged only on what they change', () => {
  it('a stored negative qty nobody touched never blocks another row', () => {
    const sent = changedRowFields({ ...other, quantity: 4 }, other, writable)
    expect(sent).toEqual({ quantity: 4 })
    expect(judge(sent)).toBeNull()
  })

  it('editing another column of the negative row does not send its qty', () => {
    const sent = changedRowFields({ ...legacy, price: 12 }, legacy, writable)
    expect(sent).toEqual({ price: 12 })
    expect(judge(sent)).toBeNull()
  })

  it("changing the negative row's qty to another negative is blocked", () => {
    const sent = changedRowFields({ ...legacy, quantity: -3 }, legacy, writable)
    expect(sent).toEqual({ quantity: -3 })
    expect(judge(sent)).toBe('Quantity can not be negative')
  })

  it('a new row (no stored row) is judged on everything it carries', () => {
    const sent = changedRowFields({ quantity: -1, price: 2, junk: 1 }, null, writable)
    expect(sent).toEqual({ quantity: -1, price: 2 })
    expect(judge(sent)).toBe('Quantity can not be negative')
  })

  it('a change reason always rides along', () => {
    expect(changedRowFields({ ...legacy, _change_reason: 'fix' }, legacy, writable)).toEqual({
      _change_reason: 'fix'
    })
  })
})

import { describe, expect, it } from 'vitest'
import { applyValidationRule } from '../../lib/validation-rules'
import { changedRowFields, lineRuleErrors } from './line-qty'

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

describe('lineRuleErrors (the client twin of the server judgment)', () => {
  const fields = [
    {
      field: 'quantity',
      label: 'Quantity',
      type: 'integer',
      validation_rules: '[{"type":"min","value":0,"message":"Quantity can not be negative"}]'
    },
    {
      field: 'price',
      label: 'Price',
      type: 'decimal',
      validation_rules: [{ type: 'min', value: 0, message: 'Price can not be negative' }]
    },
    { field: 'note', label: 'Note', validation_rules: [{ type: 'max', value: 3, soft: true }] }
  ]

  it('judges only the cells the write carries', () => {
    const record = { ...legacy, price: 12 }
    expect(lineRuleErrors(fields, { price: 12 }, record)).toEqual([])
    expect(lineRuleErrors(fields, { quantity: -3 }, { ...legacy, quantity: -3 })).toEqual([
      { field: 'quantity', message: 'Quantity can not be negative' }
    ])
  })

  it('a new line is judged on everything it carries', () => {
    const row = { quantity: 2, price: -7 }
    expect(lineRuleErrors(fields, row, row)).toEqual([
      { field: 'price', message: 'Price can not be negative' }
    ])
  })

  it('zero passes a min 0 rule (close-outs) and soft rules never block', () => {
    const row = { quantity: 0, note: 'too long' }
    expect(lineRuleErrors(fields, row, row)).toEqual([])
  })

  it('a cross-field rule is judged when its other field is sent', () => {
    const dates = [
      { field: 'end', label: 'End', validation_rules: [{ type: 'gte_field', field: 'start' }] }
    ]
    const stored = { start: '2026-01-10', end: '2026-01-20' }
    expect(
      lineRuleErrors(dates, { start: '2026-02-01' }, { ...stored, start: '2026-02-01' })
    ).toHaveLength(1)
    expect(lineRuleErrors(dates, { note: 'x' }, stored)).toEqual([])
  })

  it('a typed number string is judged as the number it will be saved as', () => {
    const neg = { field: 'quantity', message: 'Quantity can not be negative' }
    expect(lineRuleErrors(fields, { quantity: '-5' }, { quantity: '-5' })).toEqual([neg])
    expect(lineRuleErrors(fields, { quantity: ' -5 ' }, { quantity: ' -5 ' })).toEqual([neg])
    expect(lineRuleErrors(fields, { quantity: -5 }, { quantity: -5 })).toEqual([neg])
    expect(lineRuleErrors(fields, { price: '2.5' }, { price: '2.5' })).toEqual([])
    expect(lineRuleErrors(fields, { price: '-2.5' }, { price: '-2.5' })).toEqual([
      { field: 'price', message: 'Price can not be negative' }
    ])
  })
})

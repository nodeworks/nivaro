import { describe, expect, it } from 'vitest'
import { isEmptyValue, needLabel, needTip, partnerNeedsSignature } from './partner-needs'

describe('partner needs (client helpers)', () => {
  it('sends only the inputs the answer depends on, related records by id', () => {
    const inputs = {
      record: ['warehouse', 'ref'],
      lines: { 'lines.order': { collection: 'lines', fk_field: 'order', fields: ['qty'] } }
    }
    const sig = partnerNeedsSignature(
      inputs,
      { warehouse: { id: 5, name: 'North' }, ref: 'A1', note: 'not asked' },
      new Map([
        ['lines.order', [{ key: 'pending:0', values: { qty: 2, sku: 'x' } }]],
        ['other.fk', [{ key: '1', values: { a: 1 } }]]
      ])
    )
    expect(JSON.parse(sig)).toEqual({
      values: { warehouse: 5, ref: 'A1' },
      lines: { 'lines.order': [{ key: 'pending:0', values: { qty: 2 } }] }
    })
  })

  it('the same values make the same signature (one request per settled set)', () => {
    const inputs = { record: ['a'], lines: {} }
    expect(partnerNeedsSignature(inputs, { a: 1, b: 2 }, new Map())).toBe(
      partnerNeedsSignature(inputs, { a: 1, b: 3 }, new Map())
    )
  })

  it('reads empty the way a person does', () => {
    expect(isEmptyValue(null)).toBe(true)
    expect(isEmptyValue('  ')).toBe(true)
    expect(isEmptyValue([])).toBe(true)
    expect(isEmptyValue({ id: null })).toBe(true)
    expect(isEmptyValue(0)).toBe(false)
    expect(isEmptyValue(false)).toBe(false)
    expect(isEmptyValue({ id: 3 })).toBe(false)
  })

  it('names the partner and the step', () => {
    const m = { partners: ['Acme ERP', 'Depot'], steps: ['Send to warehouse'] }
    expect(needLabel(m)).toBe('Needed by Acme ERP + 1')
    expect(needTip(m)).toContain('Acme ERP, Depot needs this at Send to warehouse')
  })
})

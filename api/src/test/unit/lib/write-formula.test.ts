import { describe, expect, it } from 'vitest'
import { shouldRecomputeWriteField, writeFormulaInputs } from '../../../lib/write-formula.js'

describe('write-computed re-derive rule', () => {
  const formula = 'item.price * item.quantity'
  const previous = { price: 1, quantity: 147349.27, amount: 148355.93, category: 122 }
  it('reads the item.<column> references once each', () => {
    expect(writeFormulaInputs('item.price * item.quantity + item.price')).toEqual([
      'price',
      'quantity'
    ])
    expect(writeFormulaInputs('max(item.a - item.b, 0)')).toEqual(['a', 'b'])
  })
  it('keeps a stored amount when the update touches no input', () => {
    expect(shouldRecomputeWriteField(formula, { category: 66 }, previous)).toBe(false)
  })
  it('keeps it when inputs are re-sent unchanged (numeric string vs number)', () => {
    expect(
      shouldRecomputeWriteField(formula, { price: '1', quantity: '147349.27' }, previous)
    ).toBe(false)
  })
  it('re-derives when an input changed', () => {
    expect(shouldRecomputeWriteField(formula, { quantity: 10 }, previous)).toBe(true)
  })
  it('always derives without a stored row or without inputs', () => {
    expect(shouldRecomputeWriteField(formula, { quantity: 10 }, null)).toBe(true)
    expect(shouldRecomputeWriteField('100', { category: 1 }, previous)).toBe(true)
  })
})

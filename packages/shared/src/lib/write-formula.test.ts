import { describe, expect, it } from 'vitest'
import { formulaInputs, formulaInputsChanged, sameStoredValue } from './write-formula'

describe('formulaInputs', () => {
  it('lists each referenced column once, first segment of a dotted token', () => {
    expect(formulaInputs('{{price}} * {{quantity}} + {{price}}')).toEqual(['price', 'quantity'])
    expect(formulaInputs('{{ workflow.amount }} - {{allocated}}')).toEqual([
      'workflow',
      'allocated'
    ])
    expect(formulaInputs('42')).toEqual([])
  })
  it('reads server-style item.<column> references (the line amount formula)', () => {
    expect(formulaInputs('item.price * item.quantity')).toEqual(['price', 'quantity'])
  })
})

describe('sameStoredValue', () => {
  it('treats null, undefined and empty string as one empty value', () => {
    expect(sameStoredValue(null, undefined)).toBe(true)
    expect(sameStoredValue('', null)).toBe(true)
    expect(sameStoredValue(0, null)).toBe(false)
  })
  it('compares numeric strings with numbers', () => {
    expect(sameStoredValue('147349.27', 147349.27)).toBe(true)
    expect(sameStoredValue('1', 1.0)).toBe(true)
    expect(sameStoredValue('1', 2)).toBe(false)
    expect(sameStoredValue('abc', 'abc')).toBe(true)
    expect(sameStoredValue('abc', 'abd')).toBe(false)
  })
})

describe('formulaInputsChanged on item.<column> formulas', () => {
  const formula = 'item.price * item.quantity'
  const saved = { price: 1, quantity: 1, amount: 3619 }
  it('keeps a stored amount when price and quantity are untouched', () => {
    expect(formulaInputsChanged(formula, { ...saved, item_description: 'x' }, saved)).toBe(false)
  })
  it('re-derives once quantity changes', () => {
    expect(formulaInputsChanged(formula, { ...saved, quantity: 2 }, saved)).toBe(true)
  })
})

describe('formulaInputsChanged', () => {
  const formula = '{{price}} * {{quantity}}'
  const stored = { price: 1, quantity: 147349.27, amount: 148355.93, category: 122 }
  it('is false when the draft touches no input — the stored amount stands', () => {
    expect(formulaInputsChanged(formula, { ...stored, category: 66 }, stored)).toBe(false)
  })
  it('is false when inputs are present but equal to the stored values', () => {
    expect(formulaInputsChanged(formula, { price: '1', quantity: '147349.27' }, stored)).toBe(false)
  })
  it('is true when an input changed', () => {
    expect(formulaInputsChanged(formula, { ...stored, quantity: 10 }, stored)).toBe(true)
  })
  it('is true for a new row (no base) and for a formula with no inputs', () => {
    expect(formulaInputsChanged(formula, { price: 1, quantity: 2 }, null)).toBe(true)
    expect(formulaInputsChanged('100', stored, stored)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { checkNumberEntry, isIntegerFieldType, mergePendingQtyRow } from './line-qty'

describe('checkNumberEntry', () => {
  it('takes a whole quantity on an integer column', () => {
    expect(checkNumberEntry('5', { type: 'integer', min: 0 })).toEqual({ ok: true, value: 5 })
  })

  it('treats an empty box as no value', () => {
    expect(checkNumberEntry('  ', { type: 'integer' })).toEqual({ ok: true, value: null })
    expect(checkNumberEntry(null)).toEqual({ ok: true, value: null })
  })

  it('refuses a fraction on an integer column but not on a decimal one', () => {
    expect(checkNumberEntry('1.5', { type: 'integer', label: 'Quantity' })).toEqual({
      ok: false,
      message: 'Quantity must be a whole number'
    })
    expect(checkNumberEntry('1.5', { type: 'decimal' })).toEqual({ ok: true, value: 1.5 })
  })

  it('refuses values the column cannot store', () => {
    const big = checkNumberEntry('1e308', { type: 'bigInteger', label: 'Qty' })
    expect(big.ok).toBe(false)
    expect(checkNumberEntry('99999999999', { type: 'integer' }).ok).toBe(false)
    expect(checkNumberEntry('99999999999', { type: 'bigint' })).toEqual({
      ok: true,
      value: 99999999999
    })
    expect(checkNumberEntry(String(Number.MAX_SAFE_INTEGER + 2), { type: 'bigint' }).ok).toBe(false)
    expect(checkNumberEntry('1e308', { type: 'decimal' }).ok).toBe(false)
  })

  it('says why a negative is refused', () => {
    expect(checkNumberEntry('-2', { min: 0, label: 'Quantity' })).toEqual({
      ok: false,
      message: "Quantity can't be negative"
    })
    expect(checkNumberEntry('-2', { type: 'integer' })).toEqual({ ok: true, value: -2 })
  })

  it('refuses text', () => {
    expect(checkNumberEntry('abc').ok).toBe(false)
  })
})

describe('isIntegerFieldType', () => {
  it('knows integer types and ignores prototype keys', () => {
    expect(isIntegerFieldType('bigInteger')).toBe(true)
    expect(isIntegerFieldType('decimal')).toBe(false)
    expect(isIntegerFieldType('toString')).toBe(false)
    expect(isIntegerFieldType(null)).toBe(false)
  })
})

describe('mergePendingQtyRow', () => {
  it('keeps a hand-typed price when the quantity changes (catalog has no price)', () => {
    const pending = { item: 105221, quantity: 2, price: 7, total: 14 }
    // buildRowPayload copied the catalog's null price over
    const payload = { item: 105221, quantity: 5, price: null, total: null }
    expect(mergePendingQtyRow(pending, payload, ['price'], { total: 'quantity * price' })).toEqual({
      item: 105221,
      quantity: 5,
      price: 7,
      total: 35
    })
  })

  it('takes the payload value when the row had none', () => {
    const next = mergePendingQtyRow(
      { item: 1, quantity: 1, price: null },
      { item: 1, quantity: 3, price: 4 },
      ['price']
    )
    expect(next.price).toBe(4)
    expect(next.quantity).toBe(3)
  })

  it('leaves non-editable copies to the payload', () => {
    const next = mergePendingQtyRow({ uom: 'EA', quantity: 1 }, { uom: 'BX', quantity: 2 }, [])
    expect(next.uom).toBe('BX')
  })
})

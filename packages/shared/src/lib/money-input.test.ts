import { describe, expect, it } from 'vitest'
import { MONEY_INPUT_MAX, parseMoneyInput } from './money-input'

const val = (t: string) => {
  const r = parseMoneyInput(t)
  return r.ok ? r.value : null
}
const err = (t: string) => {
  const r = parseMoneyInput(t)
  return r.ok ? null : r.error
}

// The same table runs in efp-new (src/pages/forecast-worksheet/money-input.test.ts)
// against its twin — change both together.
describe('parseMoneyInput', () => {
  it('reads plain and grouped amounts', () => {
    expect(val('1234')).toBe(1234)
    expect(val('1234.5')).toBe(1234.5)
    expect(val('.5')).toBe(0.5)
    expect(val('5.')).toBe(5)
    expect(val('$1,234.56')).toBe(1234.56)
    expect(val('12,345,678.90')).toBe(12345678.9)
    expect(val('1 000')).toBe(1000)
    expect(val('  $ 2,000 ')).toBe(2000)
    expect(val('')).toBe(0)
    expect(val('—')).toBe(0)
    expect(val('-')).toBe(0)
  })
  it('keeps negatives negative for the caller to judge', () => {
    expect(val('(500)')).toBe(-500)
    expect(val('-5')).toBe(-5)
    expect(val('-$5')).toBe(-5)
    expect(val('$-5')).toBe(-5)
    expect(val('($5)')).toBe(-5)
    expect(val('$$5')).toBeNull()
    expect(val('--5')).toBeNull()
    expect(err('-(5)')).not.toBeNull()
  })
  it('refuses a comma that is not a thousands separator (army 9 b03 N2)', () => {
    expect(err('12,34')).toMatch(/comma only between thousands/)
    expect(err('1.234,56')).toMatch(/comma only between thousands/)
    expect(err('1,2345')).toMatch(/comma only between thousands/)
    expect(err('1,234,56')).toMatch(/comma only between thousands/)
    expect(err('1,000 000')).not.toBeNull()
  })
  it('refuses hex, exponent and binary forms the record grid used to read', () => {
    expect(val('0x10')).toBeNull()
    expect(val('1e3')).toBeNull()
    expect(val('0b11')).toBeNull()
    expect(val('Infinity')).toBeNull()
    expect(val('1.2.3')).toBeNull()
    expect(val('abc')).toBeNull()
  })
  it('rounds on the digits and says so', () => {
    expect(parseMoneyInput('1.005')).toEqual({ ok: true, value: 1.01, rounded: true })
    expect(parseMoneyInput('2.675')).toEqual({ ok: true, value: 2.68, rounded: true })
    expect(parseMoneyInput('2.50')).toEqual({ ok: true, value: 2.5, rounded: false })
  })
  it('refuses more than a month can hold and multi-cell text', () => {
    expect(val(String(MONEY_INPUT_MAX))).toBe(MONEY_INPUT_MAX)
    expect(err('10000000000')).toMatch(/more than a month can hold/)
    expect(err('1000\t2000')).toBe('Paste one amount per cell')
  })
})

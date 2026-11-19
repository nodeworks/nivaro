import { afterEach, describe, expect, it } from 'vitest'
import { formatCurrency, formatFieldNumber, formatGrouped, toFiniteNumber } from './number-format'
import { numberKindOf, numberKindOfValue } from './number-kind'
import { setNumberFormat } from './utils'

afterEach(() => setNumberFormat(null))

describe('formatCurrency', () => {
  it('reads money with a symbol, grouping and cents', () => {
    expect(formatCurrency(135297.66)).toBe('$135,297.66')
    expect(formatCurrency(12345)).toBe('$12,345.00')
    expect(formatCurrency(0)).toBe('$0.00')
  })
  it('puts the minus before the symbol', () => {
    expect(formatCurrency(-1234.56)).toBe('-$1,234.56')
  })
  it('reads numeric strings', () => {
    expect(formatCurrency('135297.6600')).toBe('$135,297.66')
    expect(formatCurrency(' -12.5 ')).toBe('-$12.50')
  })
  it('empty for null, empty text and NaN; non-numbers unchanged', () => {
    expect(formatCurrency(null)).toBe('')
    expect(formatCurrency(undefined)).toBe('')
    expect(formatCurrency('')).toBe('')
    expect(formatCurrency(Number.NaN)).toBe('')
    expect(formatCurrency(Number.POSITIVE_INFINITY)).toBe('')
    expect(formatCurrency('n/a')).toBe('n/a')
  })
  it('decimals: 0, auto, a field precision', () => {
    expect(formatCurrency(12345.67, { decimals: 0 })).toBe('$12,346')
    expect(formatCurrency(12345, { decimals: 'auto' })).toBe('$12,345')
    expect(formatCurrency(12345.5, { decimals: 'auto' })).toBe('$12,345.50')
    expect(formatCurrency(1.23456, { decimals: 4 })).toBe('$1.2346')
  })
  it('compact rolls over at each unit (never $1000K)', () => {
    expect(formatCurrency(999, { compact: true })).toBe('$999.00')
    expect(formatCurrency(12345, { compact: true })).toBe('$12.3K')
    expect(formatCurrency(999999, { compact: true })).toBe('$1M')
    expect(formatCurrency(1234567, { compact: true })).toBe('$1.2M')
    expect(formatCurrency(-1234567, { compact: true })).toBe('-$1.2M')
  })
  it('other currencies; an unknown code falls back to USD', () => {
    expect(formatCurrency(1234.5, { currency: 'EUR' })).toBe('€1,234.50')
    expect(formatCurrency(1234.5, { currency: 'nope' })).toBe('$1,234.50')
  })
  it('follows the person’s number locale', () => {
    setNumberFormat({ locale: 'de-DE' })
    expect(formatCurrency(1234.5)).toContain('1.234,50')
  })
})

describe('formatFieldNumber — the integer rule', () => {
  it('years and reference numbers stay as stored', () => {
    expect(formatFieldNumber(2026, { field: 'year', type: 'integer' })).toBe('2026')
    expect(formatFieldNumber(2026, { field: 'fiscal_year', type: 'integer' })).toBe('2026')
    expect(formatFieldNumber(4500123, { field: 'po_number', type: 'integer' })).toBe('4500123')
    expect(formatFieldNumber(4500123, { field: 'po_line_no', type: 'integer' })).toBe('4500123')
    expect(formatFieldNumber(372787, { field: 'id', type: 'integer' })).toBe('372787')
    expect(formatFieldNumber(372787, { field: 'workflow_id', type: 'integer' })).toBe('372787')
    expect(formatFieldNumber(372787, { field: 'vendorId', type: 'integer' })).toBe('372787')
    expect(formatFieldNumber(372787, { field: 'vendorid', type: 'integer' })).toBe('372787')
    expect(
      formatFieldNumber(12345, { field: 'pk', type: 'integer', schema: { is_primary_key: true } })
    ).toBe('12345')
  })
  it('a legacy decimal(18,0) reference stays plain', () => {
    expect(formatFieldNumber('4500123', { field: 'po_number', type: 'decimal' })).toBe('4500123')
  })
  it('text-typed fields never group', () => {
    expect(formatFieldNumber('4500123', { field: 'po', type: 'string' })).toBe('4500123')
    expect(formatFieldNumber('12345', { field: 'quantity', type: 'string' })).toBe('12345')
  })
  it('counts and quantities group', () => {
    expect(formatFieldNumber(12345, { field: 'quantity', type: 'integer' })).toBe('12,345')
    expect(formatFieldNumber(12345, { field: 'units', type: 'integer' })).toBe('12,345')
    expect(formatFieldNumber(12345, { field: 'po_line_count', type: 'integer' })).toBe('12,345')
    expect(formatFieldNumber('12345', { field: 'qty', type: 'bigInteger' })).toBe('12,345')
  })
  it('an explicit options.format wins over the name', () => {
    expect(
      formatFieldNumber(4500123, { field: 'po_number', type: 'integer', options: { format: 'int' } })
    ).toBe('4,500,123')
    expect(
      formatFieldNumber(12345, { field: 'quantity', type: 'integer', options: { format: 'plain' } })
    ).toBe('12345')
  })
  it('decimals group, up to the field precision', () => {
    expect(formatFieldNumber('135297.6600', { field: 'rate', type: 'decimal' })).toBe('135,297.66')
    expect(
      formatFieldNumber(1.23456, { field: 'rate', type: 'float', options: { precision: 4 } })
    ).toBe('1.2346')
    expect(formatFieldNumber(2.5, { field: 'quantity', type: 'integer' })).toBe('2.5')
  })
  it('money from the field: format, currency, unit, interface', () => {
    const amount = { field: 'amount', type: 'decimal', options: { format: 'currency' } }
    expect(formatFieldNumber(135297.66, amount)).toBe('$135,297.66')
    expect(formatFieldNumber('-1234.5', amount)).toBe('-$1,234.50')
    expect(
      formatFieldNumber(10, { field: 'x', type: 'decimal', options: { currency: 'EUR' } })
    ).toBe('€10.00')
    expect(formatFieldNumber(10, { field: 'x', type: 'decimal', options: { unit: '$' } })).toBe(
      '$10.00'
    )
    expect(formatFieldNumber(10, { field: 'x', type: 'decimal', interface: 'currency' })).toBe(
      '$10.00'
    )
    expect(
      formatFieldNumber(10, { field: 'x', type: 'decimal', options: '{"format":"currency"}' })
    ).toBe('$10.00')
  })
  it('other units are appended', () => {
    expect(formatFieldNumber(1234, { field: 'lead', type: 'integer', options: { unit: 'days' } })).toBe(
      '1,234 days'
    )
    expect(formatFieldNumber(40, { field: 'share', type: 'decimal', options: { unit: '%' } })).toBe(
      '40%'
    )
  })
  it('no field: numbers group, whole-number strings stay', () => {
    expect(formatFieldNumber(12345)).toBe('12,345')
    expect(formatFieldNumber(1234.567)).toBe('1,234.57')
    expect(formatFieldNumber('12345')).toBe('12345')
    expect(formatFieldNumber('1234.5')).toBe('1,234.5')
  })
  it('empty and non-numbers', () => {
    expect(formatFieldNumber(null, { type: 'decimal' })).toBe('')
    expect(formatFieldNumber('', { type: 'decimal' })).toBe('')
    expect(formatFieldNumber(Number.NaN, { type: 'decimal' })).toBe('')
    expect(formatFieldNumber('abc', { type: 'decimal' })).toBe('abc')
  })
})

describe('number-kind', () => {
  it('non-number fields have no kind', () => {
    expect(numberKindOf({ field: 'status', type: 'string', options: { choices: [] } })).toBe(
      'plain'
    )
    expect(numberKindOf({ field: 'due', type: 'date' })).toBeNull()
    expect(numberKindOf(null)).toBeNull()
  })
  it('a computed field reads its computed type', () => {
    expect(numberKindOf({ field: 'total_cost', type: 'alias', computed_type: 'decimal' })).toBe(
      'decimal'
    )
  })
  it('bare values', () => {
    expect(numberKindOfValue(3)).toBe('count')
    expect(numberKindOfValue(3.5)).toBe('decimal')
    expect(numberKindOfValue('3')).toBe('plain')
    expect(numberKindOfValue('x')).toBeNull()
  })
})

describe('helpers', () => {
  it('toFiniteNumber', () => {
    expect(toFiniteNumber('12.50')).toBe(12.5)
    expect(toFiniteNumber('1e3')).toBe(1000)
    expect(toFiniteNumber('12abc')).toBeNull()
    expect(toFiniteNumber(true)).toBeNull()
    expect(toFiniteNumber('')).toBeNull()
  })
  it('formatGrouped', () => {
    expect(formatGrouped(1234567.891)).toBe('1,234,567.89')
    expect(formatGrouped(1234567.891, 0)).toBe('1,234,568')
    expect(formatGrouped(null)).toBe('')
  })
})

describe('formatFieldNumber — a field with no known type', () => {
  it('a reference-named column stays as stored; others group', () => {
    expect(formatFieldNumber(372787, { field: 'id', type: null })).toBe('372787')
    expect(formatFieldNumber(4500123, { field: 'po_number' })).toBe('4500123')
    expect(formatFieldNumber(12345, { field: 'open_lines' })).toBe('12,345')
  })
})

import { describe, expect, it } from 'vitest'
import { formatHeaderFieldValue } from './ItemEditForm'
import { formatDisplayValue } from './item-edit/GroupSection'
import { extraValueText } from './queue/worklist-helpers'
import { fmtCell } from './ReportView'

// The generic renderers read numbers by the one rule (lib/number-kind.ts): money with its
// symbol, decimals and counts grouped, ids / PO numbers / years as stored.

const field = (f: Record<string, unknown>) => f as never

describe('read-only form field (formatDisplayValue)', () => {
  it('groups a decimal with no format of its own', () => {
    expect(formatDisplayValue('135297.6600', field({ field: 'rate', type: 'decimal' }))).toBe(
      '135,297.66'
    )
  })
  it('money from the field', () => {
    expect(
      formatDisplayValue(
        135297.66,
        field({ field: 'amount', type: 'decimal', options: { format: 'currency' } })
      )
    ).toBe('$135,297.66')
    expect(
      formatDisplayValue(
        -1234.5,
        field({ field: 'amount', type: 'decimal', options: { unit: '$' } })
      )
    ).toBe('-$1,234.50')
  })
  it('counts group; references and years stay as stored', () => {
    expect(formatDisplayValue(12345, field({ field: 'quantity', type: 'integer' }))).toBe('12,345')
    expect(formatDisplayValue(4500123, field({ field: 'po_number', type: 'integer' }))).toBe(
      '4500123'
    )
    expect(formatDisplayValue(2026, field({ field: 'fiscal_year', type: 'integer' }))).toBe('2026')
  })
  it("display_format '0.00' groups too", () => {
    expect(
      formatDisplayValue(
        1234.5,
        field({ field: 'x', type: 'decimal', options: '{"display_format":"0.00"}' })
      )
    ).toBe('1,234.50')
  })
  it('empty stays a dash', () => {
    expect(formatDisplayValue(null, field({ field: 'x', type: 'decimal' }))).toBe('—')
  })
})

describe('record header figure (formatHeaderFieldValue)', () => {
  it('no placement format: the field decides', () => {
    expect(
      formatHeaderFieldValue(135297.66, '', {
        field: 'amount',
        type: 'decimal',
        options: { format: 'currency' }
      })
    ).toBe('$135,297.66')
    expect(formatHeaderFieldValue(4500123, '', { field: 'po_number', type: 'integer' })).toBe(
      '4500123'
    )
    expect(formatHeaderFieldValue(12345, '', { field: 'open_lines', type: 'integer' })).toBe(
      '12,345'
    )
  })
  it("a placement 'currency' honours the field's currency", () => {
    expect(
      formatHeaderFieldValue(1234.5, 'currency', {
        field: 'amount',
        type: 'decimal',
        options: { currency: 'EUR' }
      })
    ).toBe('€1,234.50')
    expect(formatHeaderFieldValue(1234.5, 'currency')).toBe('$1,234.50')
  })
})

describe('queue extra column (extraValueText)', () => {
  it('reads by the kind the server sends', () => {
    expect(
      extraValueText(
        { path: 'amount', number: true, number_kind: 'money', currency: 'USD' },
        '135297.66'
      )
    ).toBe('$135,297.66')
    expect(extraValueText({ path: 'qty', number: true, number_kind: 'count' }, '12345')).toBe(
      '12,345'
    )
    expect(
      extraValueText({ path: 'po.po_number', number: true, number_kind: 'plain' }, '4500123')
    ).toBe('4500123')
  })
  it('an older server (no kind): the column name and value decide', () => {
    expect(extraValueText({ path: 'total_cost', number: true }, '1234.5')).toBe('1,234.5')
    expect(extraValueText({ path: 'po_number', number: true }, '4500123')).toBe('4500123')
  })
  it('non-number columns and choices are unchanged', () => {
    expect(extraValueText({ path: 'code' }, '12345')).toBe('12345')
    expect(
      extraValueText({ path: 's', number: true, choices: [{ value: '1', text: 'One' }] }, '1')
    ).toBe('One')
  })
})

describe('report table cell (fmtCell) with no column format', () => {
  it('groups numbers; a reference key stays as stored', () => {
    expect(fmtCell(135297.66, undefined, undefined, 'spend')).toBe('135,297.66')
    expect(fmtCell(12345, undefined, undefined, 'records')).toBe('12,345')
    expect(fmtCell(4500123, undefined, undefined, 'po_number')).toBe('4500123')
    expect(fmtCell('CR26-81410')).toBe('CR26-81410')
  })
})

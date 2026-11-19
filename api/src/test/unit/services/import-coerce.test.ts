import { describe, expect, it } from 'vitest'
import {
  coerceImportRow,
  coerceImportValue,
  coercesImportType,
  ImportValueError
} from '../../../services/import-coerce.js'
import { sheetCellForType } from '../../../services/import-templates.js'

// EFP prod 2026-11-19: on_hand = "26000.00" for an int column refused all 86,575 rows of a
// collection import. Collection imports now read number / yes-no cells the way staged and
// template imports do (import-templates.ts sheetCellForType over parseSheetNumber).

const qty = { type: 'integer', label: 'On Hand Quantity' }
const read = (v: unknown, type: string) => coerceImportValue(v, 'f', { type, label: 'Field' })

describe('whole-number fields', () => {
  it('reads "26000", "26000.00", "1,234", " 42 " as whole numbers', () => {
    expect(coerceImportValue('26000', 'q', qty)).toBe(26000)
    expect(coerceImportValue('26000.00', 'q', qty)).toBe(26000)
    expect(coerceImportValue('26,000.00', 'q', qty)).toBe(26000)
    expect(coerceImportValue('1,234', 'q', qty)).toBe(1234)
    expect(coerceImportValue(' 42 ', 'q', qty)).toBe(42)
    expect(coerceImportValue('-7', 'q', qty)).toBe(-7)
    expect(coerceImportValue('-0.00', 'q', qty)).toBe(0)
    expect(coerceImportValue(12, 'q', qty)).toBe(12)
  })

  it('a real fraction is a plain row error naming the field and the value', () => {
    expect(() => coerceImportValue('3.5', 'q', qty)).toThrow(
      'On Hand Quantity must be a whole number — got 3.5'
    )
    expect(() => coerceImportValue('3.5', 'q', qty)).toThrow(ImportValueError)
  })

  it('text, a decimal comma or a broken thousands group is not a number', () => {
    expect(() => coerceImportValue('lots', 'q', qty)).toThrow(
      'On Hand Quantity must be a number — got lots'
    )
    expect(() => coerceImportValue('1.234,5', 'q', qty)).toThrow(/must be a number/)
    expect(() => coerceImportValue('12,34', 'q', qty)).toThrow(/must be a number/)
  })

  it('a bigInteger past 2^53 keeps its own digits', () => {
    expect(read('9007199254740993', 'bigInteger')).toBe('9007199254740993')
    expect(read('9,007,199,254,740,993.00', 'bigInteger')).toBe('9007199254740993')
    expect(read('123', 'bigInteger')).toBe(123)
  })
})

describe('decimal / float fields', () => {
  it('drop thousands separators and spaces; must parse', () => {
    expect(read('1,234.56', 'decimal')).toBe(1234.56)
    expect(read(' 3.5 ', 'float')).toBe(3.5)
    expect(read('$4.10', 'decimal')).toBe(4.1)
    expect(() => read('abc', 'decimal')).toThrow('Field must be a number — got abc')
  })
})

describe('yes/no fields', () => {
  it('true/false, yes/no, 1/0, y/n in any case', () => {
    for (const v of ['true', 'TRUE', 'Yes', 'y', '1', 1, true])
      expect(read(v, 'boolean')).toBe(true)
    for (const v of ['false', 'No', 'N', '0', 0, false]) expect(read(v, 'boolean')).toBe(false)
    expect(() => read('maybe', 'boolean')).toThrow(
      'Field must be yes or no (true/false, 1/0) — got maybe'
    )
  })
})

describe('empty text and other types', () => {
  it('empty text is null for number and yes/no fields', () => {
    for (const t of ['integer', 'bigInteger', 'decimal', 'float', 'boolean']) {
      expect(read('', t)).toBeNull()
      expect(read('   ', t)).toBeNull()
      expect(read(null, t)).toBeNull()
    }
  })

  it('other types pass through untouched', () => {
    expect(read(' 007 ', 'string')).toBe(' 007 ')
    expect(read('2026-11-19', 'date')).toBe('2026-11-19')
    expect(coercesImportType('string')).toBe(false)
    expect(coercesImportType('bigInteger')).toBe(true)
    expect(coercesImportType('boolean')).toBe(true)
  })
})

describe('coerceImportRow', () => {
  it('converts the mapped cells in place and fails the row on the first bad one', () => {
    const types = new Map([
      ['on_hand_quantity', qty],
      ['active', { type: 'boolean', label: 'Active' }]
    ])
    const row: Record<string, unknown> = { on_hand_quantity: '26000.00', active: 'yes', name: 'x' }
    coerceImportRow(row, types)
    expect(row).toEqual({ on_hand_quantity: 26000, active: true, name: 'x' })
    const bad: Record<string, unknown> = { on_hand_quantity: '2.5' }
    expect(() => coerceImportRow(bad, types)).toThrow(ImportValueError)
  })
})

describe('sheetCellForType is the one shared reading', () => {
  it('says why a cell cannot be stored', () => {
    expect(sheetCellForType('3.5', 'int')).toEqual({ problem: 'whole' })
    expect(sheetCellForType('x', 'decimal')).toEqual({ problem: 'number' })
    expect(sheetCellForType('maybe', 'bit')).toEqual({ problem: 'boolean' })
    expect(sheetCellForType('26000.00', 'int')).toEqual({ value: 26000 })
    expect(sheetCellForType('anything', 'text')).toEqual({ value: 'anything' })
  })
})

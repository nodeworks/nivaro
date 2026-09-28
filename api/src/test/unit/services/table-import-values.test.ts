import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: {} }))
vi.mock('../../../services/items.js', () => ({
  createOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
  applyWriteComputedFields: vi.fn()
}))
vi.mock('../../../services/queues.js', () => ({ getLabels: vi.fn() }))
vi.mock('../../../services/batch-writes.js', () => ({
  batchCreate: vi.fn(),
  batchUpdate: vi.fn(),
  batchDelete: vi.fn(),
  batchRefusal: vi.fn(),
  columnTypes: vi.fn()
}))
vi.mock('../../../services/run-long.js', () => ({ runLongSql: vi.fn() }))

const { meetsCondition, parseTableConfig, readCell, readDate, sameValue } = await import(
  '../../../services/table-import.js'
)

describe('meetsCondition', () => {
  it('reads a literal loosely and an operator exactly', () => {
    expect(meetsCondition(1, true)).toBe(true)
    expect(meetsCondition('0', true)).toBe(false)
    expect(meetsCondition(null, true)).toBe(false)
    expect(meetsCondition('Approved', 'approved')).toBe(true)
    expect(meetsCondition(null, null)).toBe(true)
    expect(meetsCondition('x', { _nnull: true })).toBe(true)
    expect(meetsCondition('', { _nnull: true })).toBe(false)
    expect(meetsCondition(null, { _null: true })).toBe(true)
    expect(meetsCondition(3, { _in: [1, 2, 3] })).toBe(true)
    expect(meetsCondition('b', { _neq: 'B' })).toBe(false)
    expect(meetsCondition('b', { _eq: 'c' })).toBe(false)
  })
})

const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null

describe('readDate', () => {
  it('reads the forms a file carries', () => {
    expect(day(readDate('2026-09-27'))).toBe('2026-09-27')
    expect(day(readDate('9/27/2026'))).toBe('2026-09-27')
    expect(day(readDate('09/27/26'))).toBe('2026-09-27')
    expect(day(readDate('2026-09-27T14:05:00'))).toBe('2026-09-27')
    expect(day(readDate('12-31-1999'))).toBe('1999-12-31')
  })

  it("reads a spreadsheet's day count", () => {
    expect(day(readDate('46292'))).toBe('2026-09-27')
  })

  it('refuses what is not a date', () => {
    expect(readDate('')).toBe(null)
    expect(readDate('n/a')).toBe(null)
    expect(readDate('13/45/2026')).toBe(null)
    expect(readDate('02/30/2026')).toBe(null)
  })

  it('keeps the day when the text carries a late hour', () => {
    expect(day(readDate('9/27/2026 11:30 PM'))).toBe('2026-09-27')
  })
})

describe('readCell', () => {
  it('reads money and counts as numbers', () => {
    expect(readCell('$1,234.50', 'number')).toEqual({ value: 1234.5, bad: false })
    expect(readCell('(250.00)', 'number')).toEqual({ value: -250, bad: false })
    expect(readCell('1,200', 'int')).toEqual({ value: 1200, bad: false })
    expect(readCell('12%', 'number')).toEqual({ value: 12, bad: false })
  })

  it('says when a cell cannot be the kind the field stores', () => {
    expect(readCell('n/a', 'number')).toEqual({ value: null, bad: true })
    expect(readCell('1.5', 'int')).toEqual({ value: null, bad: true })
    expect(readCell('maybe', 'boolean')).toEqual({ value: null, bad: true })
    expect(readCell('soon', 'date')).toEqual({ value: null, bad: true })
  })

  it('reads an empty cell as nothing, never as bad', () => {
    expect(readCell('  ', 'number')).toEqual({ value: null, bad: false })
  })

  it('reads yes and no', () => {
    expect(readCell('Yes', 'boolean').value).toBe(true)
    expect(readCell('N', 'boolean').value).toBe(false)
  })

  it('stores a date column as a day', () => {
    expect(readCell('9/27/2026', 'date').value).toBe('2026-09-27')
  })
})

describe('sameValue', () => {
  it('compares money to the precision the column holds', () => {
    expect(sameValue('1234.5000', 1234.5, 'decimal(14, 4)')).toBe(true)
    expect(sameValue(519.9, 519.9001, 'decimal(14, 4)')).toBe(false)
    expect(sameValue(519.9, 519.9001, 'decimal(12, 2)')).toBe(true)
  })

  it('treats empty, null and missing as the same nothing', () => {
    expect(sameValue(null, '', 'nvarchar(50)')).toBe(true)
    expect(sameValue(undefined, null, 'int')).toBe(true)
    expect(sameValue(0, null, 'int')).toBe(false)
  })

  it('compares a stored date with the day the file names', () => {
    expect(sameValue(new Date('2026-09-27T00:00:00Z'), '2026-09-27', 'date')).toBe(true)
    expect(sameValue(new Date('2026-09-27T00:00:00Z'), '2026-09-28', 'date')).toBe(false)
    expect(sameValue(new Date('2026-09-27T15:00:00Z'), '2026-09-27', 'datetime2(7)')).toBe(true)
  })

  it('compares a bit with yes and no', () => {
    expect(sameValue(1, true, 'bit')).toBe(true)
    expect(sameValue(false, 0, 'bit')).toBe(true)
    expect(sameValue(true, false, 'bit')).toBe(false)
  })

  it('compares text exactly, outer spaces aside', () => {
    expect(sameValue('ACME INC ', 'ACME INC', 'nvarchar(200)')).toBe(true)
    expect(sameValue('Acme Inc', 'ACME INC', 'nvarchar(200)')).toBe(false)
    expect(sameValue('00123', '123', 'nvarchar(20)')).toBe(false)
  })
})

describe('parseTableConfig', () => {
  const base = {
    collection: 'units',
    match_by: ['system_id'],
    columns: { system_id: { field: 'system_id' } }
  }

  it('accepts a plain definition', () => {
    expect(parseTableConfig(JSON.stringify(base))?.collection).toBe('units')
  })

  it('refuses platform tables and unsafe names', () => {
    expect(parseTableConfig({ ...base, collection: 'nivaro_users' })).toBe(null)
    expect(parseTableConfig({ ...base, collection: 'units; DROP' })).toBe(null)
    expect(parseTableConfig({ ...base, match_by: ['a b'] })).toBe(null)
    expect(parseTableConfig({ ...base, after: ['update_unit_spend; DROP TABLE x'] })).toBe(null)
    expect(parseTableConfig({ ...base, mode: 'delete' })).toBe(null)
    expect(parseTableConfig({ ...base, protect: { when: { 'a b': true } } })).toBe(null)
    expect(parseTableConfig({ ...base, mode: 'remove', protect: { when: { a: true } } })).not.toBe(
      null
    )
    expect(
      parseTableConfig({
        ...base,
        links: { years: { column: 'y', junction: 'a b', parent_field: 'p', related_field: 'r' } }
      })
    ).toBe(null)
  })
})

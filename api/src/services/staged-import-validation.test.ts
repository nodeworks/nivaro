// Pre-flight validation of a staged import file: value bounds (army4 a13-14)
// and number reading that matches the import's own (`readCell`).
import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))

const { boundsProblem, readNumberCell, validateStagedRows } = await import(
  './staged-import-validation.js'
)

// The forecast definition's validation, as stock-import-guards sets it.
const forecastValidation = {
  key_columns: ['warehouse', 'cifa', 'year', 'month'],
  required: ['warehouse', 'cifa', 'year', 'month'],
  numeric: ['year', 'month', 'quantity'],
  bounds: {
    year: { min: 2000, max: 2100, integer: true },
    month: { min: 1, max: 12, integer: true },
    quantity: { min: 0, max: 1_000_000, integer: true }
  }
}
const row = (o: Record<string, string>) => ({
  warehouse: 'PAE77',
  cifa: '103233',
  year: '2026',
  month: '11',
  quantity: '490',
  ...o
})

describe('readNumberCell', () => {
  it('reads numbers the way the import does', () => {
    expect(readNumberCell('1,200')).toBe(1200)
    expect(readNumberCell(' $5.50 ')).toBe(5.5)
    expect(readNumberCell('(3)')).toBe(-3)
    expect(readNumberCell('-3')).toBe(-3)
    expect(readNumberCell('abc')).toBeNull()
    expect(readNumberCell('')).toBeNull()
  })
})

describe('boundsProblem', () => {
  it('names the broken bound', () => {
    const b = { min: 0, max: 1_000_000, integer: true }
    expect(boundsProblem(5, b)).toBeNull()
    expect(boundsProblem(1.5, b)).toBe('not a whole number')
    expect(boundsProblem(-3, b)).toBe('below 0')
    expect(boundsProblem(9_999_999, b)).toBe('above 1,000,000')
  })
})

describe('validateStagedRows bounds', () => {
  it('refuses negative, fractional and huge quantities and a 1999 year', async () => {
    const report = await validateStagedRows({ validation: forecastValidation }, [
      row({ quantity: '-3' }),
      row({ month: '12', quantity: '1.5' }),
      row({ year: '2027', month: '1', quantity: '9,999,999' }),
      row({ year: '1999', month: '2' }),
      row({ year: '2027', month: '3', quantity: '1,200' })
    ])
    const out = report.errors.filter((e) => e.code === 'out_of_bounds')
    expect(out).toHaveLength(2)
    const qty = out.find((e) => e.message.includes('quantity'))!
    expect(qty.rows).toEqual([2, 3, 4])
    expect(qty.message).toContain('a whole number from 0 to 1,000,000')
    const year = out.find((e) => e.message.includes('year'))!
    expect(year.rows).toEqual([5])
    // "1,200" is a number for validation, as it is for the dry run.
    expect(report.errors.some((e) => e.code === 'not_numeric')).toBe(false)
  })

  it('a clean file has no errors; text in a number column is still not_numeric', async () => {
    expect(
      (await validateStagedRows({ validation: forecastValidation }, [row({})])).errors
    ).toEqual([])
    const bad = await validateStagedRows({ validation: forecastValidation }, [
      row({ quantity: 'lots' })
    ])
    expect(bad.errors.map((e) => e.code)).toEqual(['not_numeric'])
  })

  it('no bounds configured → no bounds errors', async () => {
    const { bounds: _b, ...plain } = forecastValidation
    const report = await validateStagedRows({ validation: plain }, [row({ quantity: '-3' })])
    expect(report.errors).toEqual([])
  })
})

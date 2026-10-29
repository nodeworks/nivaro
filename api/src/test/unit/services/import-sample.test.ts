import { describe, expect, it, vi } from 'vitest'

// Staging table empty, one lookup collection with real values.
vi.mock('../../../db/index.js', () => {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    staging_widgets: [],
    warehouses: [{ name: 'ORPDX' }, { name: 'WAPUY' }]
  }
  const qb = (table: string) => {
    const q = {
      select: () => q,
      whereNotNull: () => q,
      limit: async () => rows[table] ?? []
    }
    return q
  }
  const db = Object.assign((t: string) => qb(t), {
    raw: async () => [{ name: 'warehouse' }, { name: 'qty' }, { name: 'ship_date' }]
  })
  return { db }
})

import { buildImportSample, csvCell } from '../../../services/import-sample.js'

const def = {
  key: 'widgets',
  staging_table: 'staging_widgets',
  staging_columns: JSON.stringify([
    { name: 'warehouse', from_header: 'Warehouse', required: true },
    { name: 'qty', type: 'int' },
    { name: 'ship_date', type: 'date' }
  ]),
  validation: JSON.stringify({
    numeric: ['qty'],
    lookups: [{ column: 'Warehouse', collection: 'warehouses', match_field: 'name' }]
  })
}

describe('buildImportSample', () => {
  it('uses the declared headers and generates rows with real lookup values', async () => {
    const s = await buildImportSample(def)
    expect(s.filename).toBe('widgets_sample.csv')
    expect(s.source).toBe('generated')
    const lines = s.csv.trim().split('\r\n')
    expect(lines[0]).toBe('Warehouse,qty,ship_date')
    expect(lines).toHaveLength(4)
    expect(lines[1].split(',')[0]).toBe('ORPDX')
    expect(lines[2].split(',')[0]).toBe('WAPUY')
    expect(lines[1].split(',')[1]).toBe('1')
    expect(lines[1].split(',')[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('accepts a bare list of column names', async () => {
    const s = await buildImportSample({ ...def, staging_columns: '["po_number","line_number"]' })
    expect(s.csv.split('\r\n')[0]).toBe('po_number,line_number')
  })
})

describe('csvCell', () => {
  it('quotes commas and quotes, and defuses spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell('-5')).toBe('-5')
  })
})

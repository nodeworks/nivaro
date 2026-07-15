import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { readSpreadsheet } from '../../../services/import-spreadsheet.js'

function xlsxBuffer(
  sheets: Record<string, Record<string, unknown>[]>,
  bookType: XLSX.BookType = 'xlsx'
): Buffer {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name)
  }
  return XLSX.write(wb, { type: 'buffer', bookType }) as Buffer
}

const CONFIG = {
  sheet_match: 'EFP Import Sheet',
  header_row: 1,
  file_types: ['xlsx', 'xlsm', 'csv'] as ('xlsx' | 'xlsm' | 'xls' | 'csv')[]
}

describe('readSpreadsheet', () => {
  it('picks the sheet matching sheet_match substring', () => {
    const buf = xlsxBuffer({
      Cover: [{ A: 1 }],
      'EFP Import Sheet v2': [{ Vendor: 'Acme', 'Line Number': 1 }]
    })
    const { rows, issues } = readSpreadsheet(buf, 'bid.xlsx', CONFIG)
    expect(issues).toEqual([])
    expect(rows).toEqual([{ Vendor: 'Acme', 'Line Number': 1 }])
  })

  it('errors when no sheet matches', () => {
    const buf = xlsxBuffer({ Cover: [{ A: 1 }] })
    const { rows, issues } = readSpreadsheet(buf, 'bid.xlsx', CONFIG)
    expect(rows).toEqual([])
    expect(issues[0].severity).toBe('error')
  })

  it('uses first sheet when sheet_match is null', () => {
    const buf = xlsxBuffer({ First: [{ X: 'y' }] })
    const { rows } = readSpreadsheet(buf, 'bid.xlsx', { ...CONFIG, sheet_match: null })
    expect(rows).toEqual([{ X: 'y' }])
  })

  it('reads csv buffers', () => {
    const buf = Buffer.from('Vendor,Line Number\nAcme,1\n', 'utf8')
    const { rows, issues } = readSpreadsheet(buf, 'bid.csv', { ...CONFIG, sheet_match: null })
    expect(issues).toEqual([])
    expect(rows).toEqual([{ Vendor: 'Acme', 'Line Number': 1 }])
  })

  it('rejects a disallowed extension', () => {
    const { issues } = readSpreadsheet(Buffer.from(''), 'bid.pdf', CONFIG)
    expect(issues[0].severity).toBe('error')
  })

  it('errors on unreadable bytes instead of throwing', () => {
    const { issues } = readSpreadsheet(Buffer.from([0x00, 0x01, 0x02]), 'bid.xlsx', CONFIG)
    expect(issues[0].severity).toBe('error')
  })

  it('reads xlsm buffers when the config allows the type', () => {
    const buf = xlsxBuffer({ First: [{ Vendor: 'Acme', 'Line Number': 1 }] }, 'xlsm')
    const { rows, issues } = readSpreadsheet(buf, 'bid.xlsm', { ...CONFIG, sheet_match: null })
    expect(issues).toEqual([])
    expect(rows).toEqual([{ Vendor: 'Acme', 'Line Number': 1 }])
  })

  it('caps rows at 5000 with a warn issue', () => {
    const rows = Array.from({ length: 5010 }, (_, i) => ({ 'Line Number': i + 1 }))
    const buf = xlsxBuffer({ Sheet1: rows })
    const result = readSpreadsheet(buf, 'big.xlsx', { ...CONFIG, sheet_match: null })
    expect(result.rows.length).toBe(5000)
    expect(result.issues.some((i) => i.severity === 'warn' && i.message.includes('5000'))).toBe(
      true
    )
  })
})

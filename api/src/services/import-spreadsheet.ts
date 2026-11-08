import * as XLSX from 'xlsx'
import type { ImportTemplateConfig } from './import-templates-config.js'

export const IMPORT_ROW_CAP = 5000

export interface SheetReadResult {
  rows: Record<string, unknown>[]
  issues: { severity: 'warn' | 'error'; message: string }[]
  /** The header row's column names — a column with only blank cells is in
   *  here but in no row object. */
  columns?: string[]
}

/** The names on the header row, as the row objects key them. */
export function sheetHeaderNames(sheet: XLSX.WorkSheet, headerRow: number): string[] {
  const ref = sheet['!ref']
  if (!ref) return []
  const range = XLSX.utils.decode_range(ref)
  const r = Math.max(range.s.r, headerRow - 1)
  const out: string[] = []
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined
    const name = cell ? String(cell.w ?? cell.v ?? '').trim() : ''
    if (name) out.push(name)
  }
  return out
}

export function readSpreadsheet(
  buffer: Buffer,
  fileName: string,
  config: Pick<ImportTemplateConfig, 'sheet_match' | 'header_row' | 'file_types'>
): SheetReadResult {
  const issues: SheetReadResult['issues'] = []
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  if (!config.file_types.includes(ext as 'xlsx' | 'xlsm' | 'xls' | 'csv')) {
    return {
      rows: [],
      issues: [{ severity: 'error', message: `File type ".${ext}" not allowed for this template` }]
    }
  }
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' })
  } catch {
    return {
      rows: [],
      issues: [{ severity: 'error', message: 'File could not be read as a spreadsheet' }]
    }
  }
  // A CSV is one sheet with no name of its own: it IS the sheet the template
  // reads, whatever sheet_match says (army 9 b02 — every CSV failed with "No
  // sheet matching "EFP Import" found" though the picker offered .csv).
  const sheetName =
    config.sheet_match && ext !== 'csv'
      ? workbook.SheetNames.find((s) => s.includes(config.sheet_match as string))
      : workbook.SheetNames[0]
  if (!sheetName) {
    return {
      rows: [],
      issues: [
        {
          severity: 'error',
          message: `This workbook has no sheet named "${config.sheet_match}". Put the rows on a sheet with that name, or upload them as a .csv file.`
        }
      ]
    }
  }
  let rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    range: config.header_row - 1,
    defval: undefined
  })
  if (rows.length === 0)
    issues.push({ severity: 'error', message: `Sheet "${sheetName}" has no data rows` })
  if (rows.length > IMPORT_ROW_CAP) {
    issues.push({
      severity: 'warn',
      message: `Sheet has ${rows.length} rows; only the first ${IMPORT_ROW_CAP} were imported`
    })
    rows = rows.slice(0, IMPORT_ROW_CAP)
  }
  return { rows, issues, columns: sheetHeaderNames(workbook.Sheets[sheetName], config.header_row) }
}

import * as XLSX from 'xlsx'
import type { ImportTemplateConfig } from './import-templates-config.js'

export const IMPORT_ROW_CAP = 5000

export interface SheetReadResult {
  rows: Record<string, unknown>[]
  issues: { severity: 'warn' | 'error'; message: string }[]
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
  const sheetName = config.sheet_match
    ? workbook.SheetNames.find((s) => s.includes(config.sheet_match as string))
    : workbook.SheetNames[0]
  if (!sheetName) {
    return {
      rows: [],
      issues: [{ severity: 'error', message: `No sheet matching "${config.sheet_match}" found` }]
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
  return { rows, issues }
}

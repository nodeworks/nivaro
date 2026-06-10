/**
 * Adds Excel (.xlsx / .xls) and JSON import support to the Data Import wizard.
 * Install: pnpm add xlsx
 */
import type { Extension } from '@nivaro/api/extensions/loader'

const extension: Extension = {
  id: 'example-import-parser',

  async register({ importParsers, logger }) {
    // ── Excel parser ──────────────────────────────────────────────────────────
    importParsers.register({
      mimeTypes: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel'
      ],
      extensions: ['xlsx', 'xls'],
      label: 'Excel (.xlsx / .xls)',

      async parse(content) {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(content, { type: 'buffer' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
        return rows.map((row) =>
          Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)]))
        )
      }
    })

    // ── JSON parser ───────────────────────────────────────────────────────────
    importParsers.register({
      mimeTypes: ['application/json'],
      extensions: ['json'],
      label: 'JSON (array of objects)',

      parse(content) {
        const data = JSON.parse(content.toString()) as unknown
        if (!Array.isArray(data)) throw new Error('JSON import must be an array of objects')
        return data.map((row: unknown) => {
          if (typeof row !== 'object' || row === null) throw new Error('Each row must be an object')
          return Object.fromEntries(
            Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
          )
        })
      }
    })

    logger.info('Excel + JSON import parsers registered')
  }
}

export default extension

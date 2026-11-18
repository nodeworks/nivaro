import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  ColumnWidths,
  ExportTextWriter,
  exportWorkDir,
  NdjsonSpool,
  sendExportFile,
  sweepStaleExportTemps,
  XlsxStreamWriter,
  xlsxWidthFromWch
} from '../../../services/export-files.js'

// Streaming export files (2026-11-18): builders write each page to a temp file as they go;
// the file is the same text / workbook the in-memory build made, and every temp file goes.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nvr-export-test-'))
  process.env.EXPORT_WORK_DIR = dir
})
afterEach(() => {
  delete process.env.EXPORT_WORK_DIR
})

describe('work dir', () => {
  it('EXPORT_WORK_DIR wins; else <tmpdir>/nivaro-exports', () => {
    expect(exportWorkDir()).toBe(dir)
    expect(exportWorkDir({})).toBe(join(tmpdir(), 'nivaro-exports'))
  })

  it('removes temp files older than a day, keeps fresh ones', async () => {
    const old = join(dir, 'old.csv')
    const fresh = join(dir, 'fresh.csv')
    await writeFile(old, 'x')
    await writeFile(fresh, 'y')
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)
    await utimes(old, twoDaysAgo, twoDaysAgo)
    expect(await sweepStaleExportTemps()).toBe(1)
    expect(await readdir(dir)).toEqual(['fresh.csv'])
  })
})

describe('ExportTextWriter', () => {
  it('appends text in order and leaves the file for its taker', async () => {
    const w = await ExportTextWriter.open('.csv')
    for (let i = 0; i < 2000; i++) await w.write(`${'x'.repeat(100)}${i}\n`)
    await w.close()
    const text = await readFile(w.path, 'utf8')
    expect(text.split('\n')).toHaveLength(2001)
    expect(text.endsWith('1999\n')).toBe(true)
  })

  it('discard removes the file', async () => {
    const w = await ExportTextWriter.open('.csv')
    await w.write('abc')
    await w.discard()
    await expect(stat(w.path)).rejects.toThrow()
  })
})

describe('NdjsonSpool', () => {
  it('replays values exactly (strings with newlines, numbers, booleans, null, bigint as text)', async () => {
    const spool = await NdjsonSpool.open()
    const values = [
      { a: 'line\nbreak', b: 1.5, c: true, d: null },
      ['x', 0, false, ''],
      { big: 12345678901234567890n }
    ]
    for (const v of values) await spool.write(v)
    await spool.finish()
    const back: unknown[] = []
    for await (const v of spool.read()) back.push(v)
    expect(back).toEqual([values[0], values[1], { big: '12345678901234567890' }])
    await spool.discard()
    expect(await readdir(dir)).toEqual([])
  })
})

describe('XlsxStreamWriter', () => {
  it('writes what sheetjs reads back: types, header, widths as sheetjs wrote them', async () => {
    const x = await XlsxStreamWriter.open()
    const widths = new ColumnWidths(['id', 'Title', 'flag'])
    const rows: Array<Array<string | number | boolean>> = [
      [1, 'a,b', true],
      [2, '', false],
      [3, '=X', 'long text value here']
    ]
    for (const r of rows) widths.see(r)
    x.sheet('Export', { header: ['id', 'Title', 'flag'], widths: widths.wch() })
    for (const r of rows) x.row(r)
    await x.close()
    const wb = XLSX.read(await readFile(x.path), { cellStyles: true })
    expect(wb.SheetNames).toEqual(['Export'])
    const ws = wb.Sheets.Export
    expect(XLSX.utils.sheet_to_json(ws, { header: 1 })).toEqual([
      ['id', 'Title', 'flag'],
      [1, 'a,b', true],
      [2, '', false],
      [3, '=X', 'long text value here']
    ])
    // The width sheetjs itself writes for { wch } (so the streamed file looks the same).
    const cols = ws['!cols'] as Array<{ width: number }>
    expect(cols.map((c) => c.width)).toEqual(widths.wch().map(xlsxWidthFromWch))
    expect(widths.wch()).toEqual([4, 7, 22])
  })

  it('continues on "<name> 2" with the header repeated past the row limit', async () => {
    const x = await XlsxStreamWriter.open({ maxRowsPerSheet: 4 })
    x.sheet('Export', { header: ['n'] })
    for (let i = 1; i <= 7; i++) x.row([i])
    x.sheet('kids', { header: ['k'] })
    x.row(['a'])
    await x.close()
    const wb = XLSX.read(await readFile(x.path))
    expect(wb.SheetNames).toEqual(['Export', 'Export 2', 'Export 3', 'kids'])
    const rows = (name: string) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 })
    expect(rows('Export')).toEqual([['n'], [1], [2], [3]])
    expect(rows('Export 2')).toEqual([['n'], [4], [5], [6]])
    expect(rows('Export 3')).toEqual([['n'], [7]])
    expect(rows('kids')).toEqual([['k'], ['a']])
  })
})

describe('sendExportFile', () => {
  it('streams the file as the answer and removes it afterwards', async () => {
    const w = await ExportTextWriter.open('.csv')
    await w.write('a,b\r\n1,2')
    await w.close()
    const app = Fastify()
    app.get('/x', (_req, reply) =>
      sendExportFile(reply, { path: w.path, filename: 'x.csv', contentType: 'text/csv' })
    )
    const res = await app.inject({ url: '/x' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('a,b\r\n1,2')
    expect(res.headers['content-disposition']).toBe('attachment; filename="x.csv"')
    expect(res.headers['content-type']).toContain('text/csv')
    for (let i = 0; i < 50 && (await readdir(dir)).length > 0; i++)
      await new Promise((r) => setTimeout(r, 5))
    expect(await readdir(dir)).toEqual([])
    await app.close()
  })
})

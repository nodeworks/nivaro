import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  ColumnWidths,
  ExportBudget,
  ExportFileTooBig,
  ExportTextWriter,
  exportWorkDir,
  exportWorkDirBytes,
  NdjsonSpool,
  sendExportFile,
  setExportProcessTag,
  sweepDeadProcessDirs,
  sweepStaleExportTemps,
  XLSX_SETTLE_EVERY,
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
    expect(await filesUnder(dir)).toEqual(['fresh.csv'])
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
    expect(await filesUnder(dir)).toEqual([])
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
    for (const r of rows) await x.row(r)
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
    for (let i = 1; i <= 7; i++) await x.row([i])
    x.sheet('kids', { header: ['k'] })
    await x.row(['a'])
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
    for (let i = 0; i < 50 && (await filesUnder(dir)).length > 0; i++)
      await new Promise((r) => setTimeout(r, 5))
    expect(await filesUnder(dir)).toEqual([])
    await app.close()
  })
})

describe('fix round 1', () => {
  it('XLSX rows wait for the file stream to drain (no backlog when the disk is slower)', async () => {
    const x = await XlsxStreamWriter.open()
    x.sheet('Export', { header: ['n'] })
    const slow = Object.assign(new EventEmitter(), { writableNeedDrain: true })
    const wb = (x as unknown as { wb: { stream: unknown } }).wb
    const real = wb.stream
    wb.stream = slow
    let settled = false
    const rows = (async () => {
      for (let i = 0; i < XLSX_SETTLE_EVERY; i++) await x.row([i])
      settled = true
    })()
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    slow.emit('drain')
    await rows
    expect(settled).toBe(true)
    wb.stream = real
    await x.close()
    const back = XLSX.read(await readFile(x.path))
    expect(XLSX.utils.sheet_to_json(back.Sheets.Export, { header: 1 })).toHaveLength(
      XLSX_SETTLE_EVERY + 1
    )
  })

  it('sendExportFile removes the file as soon as the connection closes', async () => {
    const w = await ExportTextWriter.open('.csv')
    await w.write('a,b')
    await w.close()
    const raw = new EventEmitter()
    const reply = {
      raw,
      header() {
        return reply
      },
      send() {
        return reply
      }
    }
    sendExportFile(reply as never, { path: w.path, filename: 'x.csv', contentType: 'text/csv' })
    // The client left before anything was read.
    raw.emit('close')
    for (let i = 0; i < 50 && (await filesUnder(dir)).length > 0; i++)
      await new Promise((r) => setTimeout(r, 5))
    expect(await filesUnder(dir)).toEqual([])
  })
})

describe('fix round 3: the spool reader', () => {
  it('a read stopped early closes its file stream', async () => {
    const spool = await NdjsonSpool.open()
    for (let i = 0; i < 100; i++) await spool.write({ i })
    await spool.finish()
    for await (const v of spool.read<{ i: number }>()) {
      if (v.i === 3) break
    }
    expect(spool.lastReader?.destroyed).toBe(true)
    await spool.discard()
  })
})

describe('fix round 2: per-process dirs, one budget per export', () => {
  it('each process writes in its own sub-directory of the work dir', async () => {
    setExportProcessTag('abc12345')
    const w = await ExportTextWriter.open('.csv')
    expect(w.path.startsWith(join(dir, 'p-abc12345'))).toBe(true)
    await w.discard()
  })

  it('the dirs of processes that are gone are swept; live or recent ones stay', async () => {
    setExportProcessTag('me000000')
    const old = Date.now() - 3 * 3_600_000
    for (const tag of ['dead0000', 'live0000', 'fresh000']) {
      await mkdir(join(dir, `p-${tag}`), { recursive: true })
      await writeFile(join(dir, `p-${tag}`, 'x.csv'), 'x')
    }
    for (const tag of ['dead0000', 'live0000']) {
      await utimes(join(dir, `p-${tag}`, 'x.csv'), new Date(old), new Date(old))
      await utimes(join(dir, `p-${tag}`), new Date(old), new Date(old))
    }
    // With a roster: gone from it and quiet for 10 minutes → removed.
    expect(await sweepDeadProcessDirs(new Set(['live0000']))).toBe(1)
    expect((await readdir(dir)).sort()).toEqual(['p-fresh000', 'p-live0000'])
    // Without a roster nothing under 6 hours old is touched.
    expect(await sweepDeadProcessDirs(null)).toBe(0)
  })

  it('the work-dir quota counts every process’s files', async () => {
    await mkdir(join(dir, 'p-other000'), { recursive: true })
    await writeFile(join(dir, 'p-other000', 'big.csv'), Buffer.alloc(3000))
    await writeFile(join(dir, 'loose.csv'), Buffer.alloc(1000))
    expect(await exportWorkDirBytes(true)).toBe(4000)
  })

  it('an export’s files share one byte budget (spool + output together)', async () => {
    const budget = new ExportBudget()
    Object.defineProperty(budget, 'maxBytes', { value: 1500 })
    const out = await ExportTextWriter.open('.csv', budget)
    const spool = await NdjsonSpool.open(budget)
    await out.write('x'.repeat(800))
    // 800 + ~600 is still under; the next write takes both files past 1,500 bytes together.
    await spool.write('y'.repeat(600))
    await expect(out.write('z'.repeat(200))).rejects.toBeInstanceOf(ExportFileTooBig)
    expect(budget.used).toBeGreaterThan(1500)
    await out.discard()
    await spool.discard()
  })
})

/** Every file under `d` (the export work dir has one sub-directory per process). */
async function filesUnder(d: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory())
      for (const f of await filesUnder(join(d, e.name))) out.push(join(e.name, f))
    else out.push(e.name)
  }
  return out
}

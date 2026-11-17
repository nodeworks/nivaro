import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  mapRowsAsync,
  parseImportFile,
  parseImportFileAsync,
  rowKeysAsync,
  toTsv,
  toTsvAsync
} from '../../../services/staged-imports.js'

// EFP prod 2026-11-16: a 30 MB invoices CSV was read with XLSX.read (one synchronous call) on
// a web process, then validated, inside the upload request — 17 s, event loop stalled up to
// 13.4 s. Big files are now read on a worker thread and cleaned in slices; the rows must be
// exactly what the inline reader produced.

function csv(rows: number): Buffer {
  const head = 'invoice_id,vendor,amount,status,notes_formatted_text,blank'
  const lines = [head]
  for (let i = 0; i < rows; i++) {
    lines.push(
      `${5000000 + i},"Vendor ${i % 90}, Inc.",$${(i % 997) + 1}.25,${i % 3 ? 'Paid' : '$-'},"said ""hi"" $5",(blank)`
    )
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

describe('parseImportFileAsync', () => {
  it('reads a CSV off the event loop into the same cleaned rows', async () => {
    const buf = csv(3000)
    const inline = parseImportFile(buf)
    const threaded = await parseImportFileAsync(buf, { minBytes: 0 })
    expect(threaded).toEqual(inline)
    // the legacy cleaning rules still apply: "$-" = 0, "(blank)" = empty, "$1.25" = 1.25
    expect(threaded[0]).toMatchObject({ amount: '1.25', status: '0', blank: '' })
    expect(threaded[0].notes).toContain('"blocks"')
    expect(threaded[1].status).toBe('Paid')
  })

  it('reads an xlsx workbook the same way', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['po', 'amount', 'date'],
        ['0012', 12.5, '2026-11-16'],
        ['0013', '$-', '']
      ]),
      'Sheet1'
    )
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    expect(await parseImportFileAsync(buf, { minBytes: 0 })).toEqual(parseImportFile(buf))
  })

  it('a small file reads inline, as before', async () => {
    const buf = csv(5)
    expect(await parseImportFileAsync(buf)).toEqual(parseImportFile(buf))
  })

  it('keeps the event loop answering while a big file is read', async () => {
    const buf = csv(100_000) // ~7 MB
    let worst = 0
    let last = Date.now()
    const tick = setInterval(() => {
      const now = Date.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 10)
    const began = Date.now()
    const rows = await parseImportFileAsync(buf)
    const took = Date.now() - began
    // the gap still open when the read answers counts too (an inline read never lets a tick run)
    worst = Math.max(worst, Date.now() - last)
    clearInterval(tick)
    expect(rows).toHaveLength(100_000)
    // Inline, the longest gap IS the read; off the loop it is a slice of cleaning.
    expect(worst).toBeLessThan(Math.max(100, took / 3))
  }, 60_000)
})

describe('sliced row helpers', () => {
  const rows = Array.from({ length: 12_345 }, (_, i) => ({
    a: `x||${i}`,
    b: i % 2 ? `|${i}` : `${i}\r\n`,
    ...(i === 9000 ? { late: 'only here' } : {})
  }))

  it('toTsvAsync writes the same text as toTsv', async () => {
    expect(await toTsvAsync(rows, ['a', 'b', 'late'])).toBe(toTsv(rows, ['a', 'b', 'late']))
  })

  it('rowKeysAsync finds a column that only a late row carries', async () => {
    expect(await rowKeysAsync(rows)).toEqual(['a', 'b', 'late'])
  })

  it('mapRowsAsync keeps order and length', async () => {
    const out = await mapRowsAsync(rows, (r) => r.a)
    expect(out).toHaveLength(rows.length)
    expect(out[12_344]).toBe('x||12344')
  })
})

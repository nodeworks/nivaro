import { describe, expect, it } from 'vitest'
import { columnName, crc32, xlsxBytes } from './xlsx-lite'

describe('xlsx-lite', () => {
  it('CRC-32 and column names', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })

  it('writes a ZIP with the workbook parts, escaped text and shaded cells', () => {
    const bytes = xlsxBytes([
      {
        name: 'History',
        rows: [
          [
            { v: 'When', style: 'header' },
            { v: 'Amount', style: 'header' }
          ],
          [{ v: 'Nov 11 & <later>' }, { v: 2060, style: 'changed' }]
        ],
        widths: [20, 12],
        freezeColumns: 1
      }
    ])
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('xl/worksheets/sheet1.xml')
    expect(text).toContain('Nov 11 &amp; &lt;later&gt;')
    expect(text).toContain('<c r="B2" s="2"><v>2060</v></c>')
    expect(text).toContain('xSplit="1"')
  })
})

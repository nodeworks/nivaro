import { describe, expect, it } from 'vitest'
import { csvCell, csvRow } from '../../../lib/csv-cell.js'

describe('csvCell', () => {
  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('"plain"')
    expect(csvCell(42)).toBe('"42"')
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
  })

  it('prefixes a quote to values a spreadsheet would run as a formula', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`)
    expect(csvCell('+SUM(A1)')).toBe(`"'+SUM(A1)"`)
    expect(csvCell('-2+3')).toBe(`"'-2+3"`)
    expect(csvCell('@HYPERLINK("x")')).toBe(`"'@HYPERLINK(""x"")"`)
    expect(csvCell('\t=1')).toBe(`"'\t=1"`)
    expect(csvCell('\r=1')).toBe(`"'\r=1"`)
    expect(csvCell('=HYPERLINK("http://evil","click")')).toBe(
      `"'=HYPERLINK(""http://evil"",""click"")"`
    )
  })

  it('leaves values that only contain those characters later alone', () => {
    expect(csvCell('a=b')).toBe('"a=b"')
    expect(csvCell('items/workflows')).toBe('"items/workflows"')
  })

  it('csvRow joins cells', () => {
    expect(csvRow(['a', '=b', 3])).toBe(`"a","'=b","3"`)
  })
})

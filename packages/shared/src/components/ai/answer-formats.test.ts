import { describe, expect, it } from 'vitest'
import { parseAiMarkdown } from './AiMarkdown'
import { cellNumber, chartOf, formatsFor, listOf, rowsOfBlock } from './answer-formats'

const first = (md: string) => parseAiMarkdown(md)[0]

describe('cellNumber', () => {
  it('reads money, percents, thousands, negatives in brackets and bold', () => {
    expect(cellNumber('$1,234.50')).toBe(1234.5)
    expect(cellNumber('(1,200)')).toBe(-1200)
    expect(cellNumber('12%')).toBe(12)
    expect(cellNumber('**42**')).toBe(42)
    expect(cellNumber('1.5k')).toBe(1500)
    expect(cellNumber('Zone 3')).toBeNull()
    expect(cellNumber('')).toBeNull()
  })
})

describe('switching an answer format (#1885)', () => {
  const table = first(
    '| Vendor | Open POs | Region |\n|---|---|---|\n| Acme | 12 | East |\n| **Globex** | 3 | West |'
  )

  it('a table with a number column offers chart and list', () => {
    expect(formatsFor(table)).toEqual(['table', 'chart', 'list'])
    const spec = chartOf(rowsOfBlock(table)!)
    expect(spec?.title).toBe('Open POs')
    expect(spec?.data).toEqual([
      { label: 'Acme', value: 12 },
      { label: 'Globex', value: 3 }
    ])
    expect(listOf(rowsOfBlock(table)!)).toEqual([
      '**Acme** — Open POs: 12; Region: East',
      '**Globex** — Open POs: 3; Region: West'
    ])
  })

  it('a table of words only offers a list', () => {
    const words = first('| Name | Role |\n|---|---|\n| Ann | Admin |\n| Bo | Viewer |')
    expect(formatsFor(words)).toEqual(['table', 'list'])
  })

  it('a chart becomes a table and a list of the same points', () => {
    const chart = first(
      '```chart\n{"type":"pie","title":"By state","data":[{"label":"Open","value":4},{"label":"Done","value":9}]}\n```'
    )
    expect(formatsFor(chart)).toEqual(['chart', 'table', 'list'])
    expect(rowsOfBlock(chart)).toEqual({
      header: ['By state', 'Value'],
      rows: [
        ['Open', '4'],
        ['Done', '9']
      ]
    })
    expect(listOf(rowsOfBlock(chart)!)).toEqual(['**Open** — 4', '**Done** — 9'])
  })

  it('a "label: number" list switches; a prose list does not', () => {
    const data = first('- Zone 1: 14\n- **Zone 2** — 1,020\n- Zone 3 - 7')
    expect(formatsFor(data)).toEqual(['list', 'table', 'chart'])
    expect(chartOf(rowsOfBlock(data)!)?.data.map((d) => d.label)).toEqual([
      'Zone 1',
      'Zone 2',
      'Zone 3'
    ])
    const prose = first('- Check the vendor\n- Then approve it')
    expect(formatsFor(prose)).toEqual(['list'])
  })
})

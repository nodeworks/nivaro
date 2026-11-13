import { describe, expect, it } from 'vitest'
import { answerChart, exportShortfall, pinSourceFor } from './AskExtras'

// #2738 — which read a chart answer pins: the grouping the chart was drawn from.

describe('pinSourceFor', () => {
  const grouped = (by: string, n: number) => ({
    tool: 'aggregate',
    input: { collection: 'invoices', op: 'count', group_by: by },
    summary: `count by ${by}: ${n} group(s)`
  })

  it('prefers the grouping whose size matches the chart', () => {
    const src = pinSourceFor([grouped('vendor', 5), grouped('status', 3)], 5)
    expect(src).toEqual({ tool: 'aggregate', input: grouped('vendor', 5).input })
  })

  it('falls back to the last saved query; errors and plain reads pin nothing', () => {
    const cq = { tool: 'run_custom_query', input: { slug: 'aging' }, summary: 'aging: 4 row(s)' }
    expect(pinSourceFor([cq], 4)).toEqual({ tool: 'run_custom_query', input: { slug: 'aging' } })
    expect(
      pinSourceFor(
        [
          { ...grouped('vendor', 5), summary: 'error: no access' },
          { tool: 'query_items', input: { collection: 'invoices' }, summary: '3 row(s)' }
        ],
        5
      )
    ).toBeNull()
  })
})

describe('answerChart', () => {
  it('finds the chart block an answer drew', () => {
    const content =
      'By vendor:\n```chart\n{"type":"pie","data":[{"label":"A","value":1},{"label":"B","value":2}]}\n```'
    expect(answerChart(content)?.type).toBe('pie')
    expect(answerChart('No chart here')).toBeNull()
  })
})

// A download the server cut says so; one that holds every row says nothing.
describe('exportShortfall', () => {
  it('names how many rows the file holds out of how many match', () => {
    expect(exportShortfall('10000', '34512')).toEqual({
      title: 'Exported the first 10,000 rows',
      description: '34,512 match — narrow the question to export the rest.',
      note: 'First 10,000 of 34,512 rows'
    })
  })

  // The toast goes away; this line stays beside the download buttons, so the page still
  // says the file is not the whole answer.
  it('has a short line to keep beside the buttons', () => {
    expect(exportShortfall(10000, 12345)?.note).toBe('First 10,000 of 12,345 rows')
  })

  it('is silent when the file holds everything or the server did not say', () => {
    expect(exportShortfall('64', '64')).toBeNull()
    expect(exportShortfall('64', undefined)).toBeNull()
    expect(exportShortfall(undefined, '64')).toBeNull()
    expect(exportShortfall('x', '64')).toBeNull()
  })
})

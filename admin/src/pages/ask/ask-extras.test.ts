import { describe, expect, it } from 'vitest'
import { answerChart, pinSourceFor } from './AskExtras'

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

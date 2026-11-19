import { describe, expect, it } from 'vitest'
import { parseAiMarkdown, parseChartSpec } from './AiMarkdown'

describe('chart blocks in Ask AI answers (#724)', () => {
  it('turns a fenced chart block into a chart node and leaves other fences as code', () => {
    const blocks = parseAiMarkdown(
      'By state:\n\n```chart\n{"type":"bar","title":"Workflows by state","data":[{"label":"Started","value":12},{"label":"Completed","value":40}]}\n```\n\n```sql\nselect 1\n```'
    )
    expect(blocks.map((b) => b.kind)).toEqual(['p', 'chart', 'code'])
    const chart = blocks[1] as { kind: 'chart'; spec: { type: string; data: unknown[] } }
    expect(chart.spec.type).toBe('bar')
    expect(chart.spec.data).toHaveLength(2)
  })
  it('refuses a chart with under two usable points or broken JSON', () => {
    expect(parseChartSpec('{"type":"pie","data":[{"label":"a","value":1}]}')).toBeNull()
    expect(parseChartSpec('{not json')).toBeNull()
    expect(
      parseChartSpec('{"data":[{"label":"a","value":"x"},{"label":"b","value":2}]}')
    ).toBeNull()
  })
  it('keeps a money unit so the axis reads $', () => {
    const data = [
      { label: 'a', value: 1200 },
      { label: 'b', value: 3400 }
    ]
    expect(parseChartSpec(JSON.stringify({ type: 'bar', unit: 'currency', data }))?.unit).toBe(
      'currency'
    )
    expect(parseChartSpec(JSON.stringify({ type: 'bar', unit: 'USD', data }))?.unit).toBe(
      'currency'
    )
    expect(parseChartSpec(JSON.stringify({ type: 'bar', data }))?.unit).toBeUndefined()
  })
  it('defaults an unknown type to bar and caps the points', () => {
    const spec = parseChartSpec(
      JSON.stringify({
        type: 'scatter',
        data: Array.from({ length: 60 }, (_, i) => ({ label: `p${i}`, value: i }))
      })
    )
    expect(spec?.type).toBe('bar')
    expect(spec?.data).toHaveLength(40)
  })
})

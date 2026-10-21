import { describe, expect, it, vi } from 'vitest'
import {
  aiQueryCollection,
  chartFromRows,
  computeAiQueryWidget,
  normalizeAiQuerySpec
} from '../../../services/ai-query-widget.js'
import { packDashboardGrid } from '../../../services/dashboard-grid-pack.js'

// #2738 — a pinned Ask AI chart stores the query and recomputes as the viewer.

describe('normalizeAiQuerySpec', () => {
  it('keeps only the arguments the read tool takes', () => {
    const spec = normalizeAiQuerySpec(
      JSON.stringify({
        source: {
          tool: 'aggregate',
          input: { collection: 'invoices', op: 'count', group_by: 'vendor', sql: 'DROP' }
        },
        chart: 'pie',
        question: '  invoices   by vendor ',
        answer: 'Acme has 12'
      })
    )
    expect(spec).toEqual({
      source: {
        tool: 'aggregate',
        input: { collection: 'invoices', op: 'count', group_by: 'vendor' }
      },
      chart: 'pie',
      question: 'invoices by vendor'
    })
    expect(aiQueryCollection(spec!)).toBe('invoices')
  })

  it('refuses tools that are not a read with an API twin, and bad names', () => {
    for (const source of [
      { tool: 'propose_action', input: {} },
      { tool: 'aggregate', input: { collection: 'x; drop', op: 'count' } },
      { tool: 'aggregate', input: { collection: 'invoices', op: 'median' } },
      { tool: 'run_custom_query', input: { slug: '../etc' } },
      null
    ]) {
      expect(normalizeAiQuerySpec({ source })).toBeNull()
    }
    const cq = normalizeAiQuerySpec({
      source: { tool: 'run_custom_query', input: { slug: 'aging' } }
    })
    expect(cq && aiQueryCollection(cq)).toBeNull()
  })
})

describe('chartFromRows', () => {
  it('reads label + value from an aggregate grouping', () => {
    expect(
      chartFromRows(
        [
          { vendor: 'Acme', value: '12' },
          { vendor: null, value: 3 }
        ],
        { type: 'bar' }
      )
    ).toEqual({
      type: 'bar',
      data: [
        { label: 'Acme', value: 12 },
        { label: '(none)', value: 3 }
      ]
    })
  })

  it('finds a label and a number column in saved-query rows, or honours x/y', () => {
    const rows = [
      { region: 'North', orders: 4, spend: 10 },
      { region: 'South', orders: 6, spend: 20 }
    ]
    expect(chartFromRows(rows)?.data[0]).toEqual({ label: 'North', value: 4 })
    expect(chartFromRows(rows, { y: 'spend' })?.data[1]).toEqual({ label: 'South', value: 20 })
  })
})

describe('computeAiQueryWidget', () => {
  it('runs the stored read AS THE VIEWER and draws what they get back', async () => {
    const spec = normalizeAiQuerySpec({
      source: {
        tool: 'aggregate',
        input: { collection: 'invoices', op: 'count', group_by: 'vendor' }
      },
      question: 'Invoices by vendor'
    })!
    const viewer = { id: 'V' } as never
    const run = vi.fn(async () => ({ result: [{ vendor: 'Acme', value: 2 }], summary: '' }))
    const out = await computeAiQueryWidget(spec, viewer, run)
    expect(run).toHaveBeenCalledWith(viewer, 'aggregate', spec.source.input)
    expect(out).toEqual({
      chart: { type: 'bar', data: [{ label: 'Acme', value: 2 }] },
      question: 'Invoices by vendor'
    })
  })

  it('an ungrouped aggregate is one number; a refusal is thrown to the caller', async () => {
    const spec = normalizeAiQuerySpec({
      source: { tool: 'aggregate', input: { collection: 'invoices', op: 'sum', field: 'amount' } }
    })!
    const v = await computeAiQueryWidget(spec, {} as never, async () => ({
      result: { value: '42.5' },
      summary: ''
    }))
    expect(v.value).toBe(42.5)
    await expect(
      computeAiQueryWidget(spec, {} as never, async () => {
        throw new Error('No read access')
      })
    ).rejects.toThrow('No read access')
  })
})

describe('packDashboardGrid (#2736)', () => {
  it('first-fits in reading order on the 4-column grid without overlaps', () => {
    const placed = packDashboardGrid([
      { width: 1, height: 1 },
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 2, height: 2 },
      { width: 1, height: 1 },
      { width: 9, height: 1 }
    ])
    expect(placed).toEqual([
      { col: 0, row: 0, width: 1, height: 1 },
      { col: 1, row: 0, width: 1, height: 1 },
      { col: 2, row: 0, width: 2, height: 2 },
      { col: 0, row: 1, width: 2, height: 2 },
      { col: 2, row: 2, width: 1, height: 1 },
      { col: 0, row: 3, width: 4, height: 1 }
    ])
  })
})

import { describe, expect, it } from 'vitest'
import {
  aggregateRows,
  computeLiveRollup,
  matchesRollupFilter,
  parseRollupSources
} from './live-rollups'

const LINES = [
  { id: 1, amount: 400, line_type: 1 },
  { id: 2, amount: 100, line_type: 4 },
  { id: 3, amount: 50, line_type: null }
]

describe('parseRollupSources', () => {
  it('reads the legacy single-source shape', () => {
    const s = parseRollupSources({
      related_collection: 'workflow_line_items',
      fk_field: 'workflow',
      aggregate: 'sum',
      value_field: 'amount'
    })
    expect(s).toHaveLength(1)
    expect(s[0].related_collection).toBe('workflow_line_items')
  })

  it('reads the multi-source shape, and a JSON string of either', () => {
    const s = parseRollupSources(
      JSON.stringify({ sources: [{ related_collection: 'a', fk_field: 'w' }, { related_collection: 'b', fk_field: 'w' }] })
    )
    expect(s.map((x) => x.related_collection)).toEqual(['a', 'b'])
  })

  it('returns [] for junk rather than throwing in render', () => {
    expect(parseRollupSources('not json')).toEqual([])
    expect(parseRollupSources(null)).toEqual([])
    expect(parseRollupSources({ nonsense: true })).toEqual([])
  })
})

describe('matchesRollupFilter', () => {
  it('_neq keeps NULL rows — the MSSQL trap the server compensates for', () => {
    expect(matchesRollupFilter({ line_type: null }, { line_type: { _neq: 4 } })).toBe(true)
    expect(matchesRollupFilter({ line_type: 4 }, { line_type: { _neq: 4 } })).toBe(false)
    expect(matchesRollupFilter({ line_type: 1 }, { line_type: { _neq: 4 } })).toBe(true)
  })

  it('supports the documented operator set', () => {
    expect(matchesRollupFilter({ n: 5 }, { n: { _gt: 3 } })).toBe(true)
    expect(matchesRollupFilter({ n: 5 }, { n: { _lte: 4 } })).toBe(false)
    expect(matchesRollupFilter({ s: null }, { s: { _null: true } })).toBe(true)
    expect(matchesRollupFilter({ s: 'x' }, { s: { _nnull: true } })).toBe(true)
    expect(matchesRollupFilter({ t: 2 }, { t: { _in: [1, 2] } })).toBe(true)
    expect(matchesRollupFilter({ t: 9 }, { t: { _in: [1, 2] } })).toBe(false)
  })

  it('treats an unmodelled operator as matching, so the set is never silently narrowed', () => {
    expect(matchesRollupFilter({ x: 1 }, { x: { _weird: 'z' } })).toBe(true)
  })
})

describe('aggregateRows', () => {
  const source = { related_collection: 'workflow_line_items', fk_field: 'workflow' }

  it('sums the filtered rows (the requisition_amount case)', () => {
    expect(
      aggregateRows({ ...source, aggregate: 'sum', value_field: 'amount', filter: { line_type: { _neq: 4 } } }, LINES)
    ).toBe(450)
  })

  it('counts, averages, mins and maxes', () => {
    expect(aggregateRows({ ...source, aggregate: 'count' }, LINES)).toBe(3)
    expect(aggregateRows({ ...source, aggregate: 'avg', value_field: 'amount' }, LINES)).toBeCloseTo(183.333, 2)
    expect(aggregateRows({ ...source, aggregate: 'min', value_field: 'amount' }, LINES)).toBe(50)
    expect(aggregateRows({ ...source, aggregate: 'max', value_field: 'amount' }, LINES)).toBe(400)
  })

  it('evaluates a value_formula per row', () => {
    const rows = [{ new_amount: 10, old_amount: 4 }, { new_amount: 7, old_amount: 7 }]
    expect(
      aggregateRows({ ...source, aggregate: 'sum', value_formula: '{{new_amount}} - {{old_amount}}' }, rows)
    ).toBe(6)
  })

  it('returns null when nothing measurable contributes, so "no rows" is not shown as 0', () => {
    expect(aggregateRows({ ...source, aggregate: 'sum', value_field: 'amount' }, [])).toBeNull()
  })
})

describe('computeLiveRollup', () => {
  const rows = new Map([['workflow_line_items.workflow', LINES]])
  const source = {
    related_collection: 'workflow_line_items',
    fk_field: 'workflow',
    aggregate: 'sum' as const,
    value_field: 'amount',
    filter: { line_type: { _neq: 4 } }
  }

  it('computes from the rows on screen', () => {
    expect(computeLiveRollup([source], rows)).toBe(450)
  })

  it('declines when a source grid is not mounted, rather than showing a partial total', () => {
    expect(computeLiveRollup([source], new Map())).toBeNull()
    expect(
      computeLiveRollup([source, { related_collection: 'other', fk_field: 'workflow' }], rows)
    ).toBeNull()
  })

  it('declines for a recursive rollup, which needs rows beyond this form', () => {
    expect(computeLiveRollup([{ ...source, recursive: true }], rows)).toBeNull()
  })

  it('sums across several mounted sources', () => {
    const two = new Map([
      ['a.w', [{ v: 2 }, { v: 3 }]],
      ['b.w', [{ v: 5 }]]
    ])
    expect(
      computeLiveRollup(
        [
          { related_collection: 'a', fk_field: 'w', aggregate: 'sum', value_field: 'v' },
          { related_collection: 'b', fk_field: 'w', aggregate: 'sum', value_field: 'v' }
        ],
        two
      )
    ).toBe(10)
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  combineTerms,
  formatTotal,
  linearSumTerms,
  loadTotalOverrides,
  overridesAfterSave,
  readTotal,
  rememberTotalOverrides,
  setOverride,
  shownTotals,
  totalsEligibleKey,
  totalsParams,
  totalsSupport,
  totalTip
} from './column-totals'

describe('list totals row', () => {
  afterEach(() => {
    try {
      localStorage.clear()
    } catch {
      /* no storage in this environment */
    }
  })

  it('asks the aggregate endpoint with the list’s own search and conditions', () => {
    const conditions = JSON.stringify([{ field: 'status', op: '_eq', value: 'Open' }])
    expect(totalsParams('amount', 'sum', { search: 'atl', conditions })).toEqual({
      sum: 'amount',
      search: 'atl',
      conditions
    })
    expect(totalsParams('amount', 'count', {})).toEqual({ count: 'amount' })
  })

  it('totals plain columns only', () => {
    expect(totalsEligibleKey('amount')).toBe(true)
    expect(totalsEligibleKey('project.amount')).toBe(false)
    expect(totalsEligibleKey('__f:1')).toBe(false)
  })

  it('reads the figure out of the aggregate answer', () => {
    expect(readTotal({ data: [{ sum: { amount: '1250.5' } }] }, 'amount', 'sum')).toBe(1250.5)
    expect(readTotal({ data: [{ avg: { amount: null } }] }, 'amount', 'avg')).toBeNull()
    expect(readTotal({ data: [] }, 'amount', 'max')).toBeNull()
  })

  it('formats like the column; counts as whole numbers', () => {
    expect(formatTotal(1234.567, 'sum')).toBe('1,234.57')
    const money = { type: 'number', decimals: 2, thousands: true, prefix: '$' } as const
    expect(formatTotal(12, 'count', money)).toBe('12')
    expect(formatTotal(1234.5, 'sum', money)).toBe('$1,234.50')
  })

  it('remembers the person’s own choices per list, dropping anything unknown', () => {
    rememberTotalOverrides('orders', { amount: 'avg', tax: 'off' })
    expect(JSON.parse(localStorage.getItem('nvr_cbv_totals_orders') ?? '')).toEqual({
      v: 2,
      o: { amount: 'avg', tax: 'off' }
    })
    expect(loadTotalOverrides('orders')).toEqual({ amount: 'avg', tax: 'off' })
    expect(loadTotalOverrides('invoices')).toEqual({})
    localStorage.setItem(
      'nvr_cbv_totals_orders',
      JSON.stringify({ v: 2, o: { amount: 'median', 'a.b': 'sum' } })
    )
    expect(loadTotalOverrides('orders')).toEqual({})
    rememberTotalOverrides('orders', {})
    expect(localStorage.getItem('nvr_cbv_totals_orders')).toBeNull()
  })

  it('reads the first stored shape (a flat column → function map) as the person’s choices', () => {
    localStorage.setItem('nvr_cbv_totals_orders', JSON.stringify({ amount: 'sum', x: 'bogus' }))
    expect(loadTotalOverrides('orders')).toEqual({ amount: 'sum' })
  })

  it('lays the person’s choices over the view’s totals', () => {
    const view = { req: 'sum', ft: 'sum' } as const
    expect(shownTotals(view, {})).toEqual(view)
    expect(shownTotals(view, { ft: 'off', po: 'avg', req: 'max' })).toEqual({
      req: 'max',
      po: 'avg'
    })
    // a view stating one total never wipes the person's other choices
    expect(shownTotals({ req: 'sum' }, { po: 'sum', ft: 'sum' })).toEqual({
      req: 'sum',
      po: 'sum',
      ft: 'sum'
    })
    expect(setOverride({}, 'req', null)).toEqual({ req: 'off' })
    expect(setOverride({ req: 'off' }, 'req', 'sum')).toEqual({ req: 'sum' })
  })

  it('drops the choices a saved view now states', () => {
    expect(
      overridesAfterSave({ req: 'sum', ft: 'avg', po: 'off', x: 'off' }, { req: 'sum', x: 'sum' })
    ).toEqual({ ft: 'avg', x: 'off' })
  })

  it('reads a formula that only adds and subtracts fields', () => {
    expect(linearSumTerms('item.requisition_amount - item.forecast_total')).toEqual([
      { field: 'requisition_amount', sign: 1 },
      { field: 'forecast_total', sign: -1 }
    ])
    expect(linearSumTerms('item.a - (item.b - coalesce(item.c, 0))')).toEqual([
      { field: 'a', sign: 1 },
      { field: 'b', sign: -1 },
      { field: 'c', sign: 1 }
    ])
    expect(linearSumTerms('{{a}} + {{ b }}')).toEqual([
      { field: 'a', sign: 1 },
      { field: 'b', sign: 1 }
    ])
    expect(linearSumTerms('-item.a')).toEqual([{ field: 'a', sign: -1 }])
    for (const f of [
      'item.a * 2',
      'item.a / item.b',
      'item.a + 1',
      'item.a + item.a',
      'item.a - item.a',
      'item.a > 0 ? item.a : 0',
      'coalesce(item.a, 5)',
      'roundTo(item.a, 2)',
      '(item.a',
      ''
    ])
      expect(linearSumTerms(f)).toBeNull()
  })

  it('says how each number field can be totalled', () => {
    const fields = new Map(
      [
        {
          field: 'req',
          type: 'decimal',
          computed_type: 'rollup',
          computed_formula: '{}',
          computed_store: true
        },
        {
          field: 'ft',
          type: 'decimal',
          computed_type: 'rollup',
          computed_formula: '{}',
          computed_store: true
        },
        { field: 'amount', type: 'decimal' },
        { field: 'name', type: 'string' },
        {
          field: 'left',
          type: 'decimal',
          computed_type: 'read',
          computed_formula: 'item.req - item.ft',
          computed_store: false
        },
        {
          field: 'open',
          type: 'decimal',
          computed_type: 'rollup',
          computed_formula: '{"sources":[]}',
          computed_store: false
        },
        {
          field: 'ratio',
          type: 'decimal',
          computed_type: 'read',
          computed_formula: 'item.req / item.ft',
          computed_store: false
        },
        {
          field: 'chain',
          type: 'decimal',
          computed_type: 'read',
          computed_formula: 'item.left + item.amount',
          computed_store: false
        }
      ].map((f) => [f.field, f])
    )
    const of = (n: string) => fields.get(n)
    expect(totalsSupport(of('req')!, of)).toEqual({ kind: 'server' })
    expect(totalsSupport(of('amount')!, of)).toEqual({ kind: 'server' })
    expect(totalsSupport(of('left')!, of)).toEqual({
      kind: 'derived',
      terms: [
        { field: 'req', sign: 1 },
        { field: 'ft', sign: -1 }
      ]
    })
    expect(totalsSupport(of('open')!, of).kind).toBe('none')
    expect(totalsSupport(of('ratio')!, of).kind).toBe('none')
    // a calculated input is not a stored column
    expect(totalsSupport(of('chain')!, of).kind).toBe('none')
  })

  it('builds a derived sum from its inputs’ sums', () => {
    const terms = [
      { field: 'req', sign: 1 as const },
      { field: 'ft', sign: -1 as const }
    ]
    expect(combineTerms(terms, (f) => (f === 'req' ? 100.1 : 30.05))).toBe(70.05)
    expect(combineTerms(terms, (f) => (f === 'req' ? 100 : null))).toBeNull()
  })

  it('says what the figure covers', () => {
    expect(totalTip('avg', 'Amount', 1200)).toBe(
      'Average of Amount across all 1,200 matching records'
    )
    expect(totalTip('count', 'Amount', null)).toBe(
      'Records with Amount filled in, across all matching records'
    )
  })
})

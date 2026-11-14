// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { sanitizeQueueLinkState } from '../../lib/list-link'
import {
  loadTotalOverridesAt,
  rememberTotalOverridesAt,
  setOverride,
  shownTotals
} from '../cbv/column-totals'
import {
  FORMULA_NO_TOTAL,
  pickTotal,
  queueTotalColumns,
  queueTotalPaths,
  queueTotalsEligibleKey,
  queueTotalsStoreKey,
  queueTotalsSupport,
  queueTotalTip,
  queueTotalValue
} from './queue-totals'

const ctx = {
  meta: [
    { path: 'amount', number: true },
    { path: 'qty', number: true },
    { path: 'vendor' },
    { path: 'margin', number: true, no_total: 'Calculated each time, so it has no total.' },
    { path: 'years.id', multi_value: true },
    { path: 'pos.amount', multi_value: true, aggregate: 'sum', number: true }
  ],
  numberFormatPaths: new Set(['req_total', 'years.id']),
  formulas: [
    { key: 'left', formula: '{{extra.amount}} - {{extra.qty}}' },
    { key: 'ratio', formula: '{{extra.amount}} / {{extra.qty}}' },
    { key: 'text', formula: '{{extra.amount}} - {{extra.vendor}}' }
  ]
}
const sup = (k: string) => queueTotalsSupport(k, ctx)

afterEach(() => {
  try {
    localStorage.clear()
  } catch {
    /* no storage */
  }
})

describe('queue totals — which columns', () => {
  it('number columns from the server meta or a number format; others have none', () => {
    expect(sup('extra.amount')).toEqual({ kind: 'server', path: 'amount' })
    expect(sup('extra.req_total')).toEqual({ kind: 'server', path: 'req_total' })
    expect(sup('extra.vendor')).toBeNull()
    // A list of values formatted as a number is still a list; a per-row aggregate of one is not.
    expect(sup('extra.years.id')).toBeNull()
    expect(sup('extra.pos.amount')).toEqual({ kind: 'server', path: 'pos.amount' })
    expect(sup('state')).toBeNull()
    expect(sup('extra.margin')).toEqual({
      kind: 'none',
      why: 'Calculated each time, so it has no total.'
    })
  })

  it('a formula column that adds and subtracts number columns is Sum-only; any other says why', () => {
    expect(sup('formula.left')).toEqual({
      kind: 'derived',
      terms: [
        { field: 'amount', sign: 1 },
        { field: 'qty', sign: -1 }
      ]
    })
    expect(sup('formula.ratio')).toEqual({ kind: 'none', why: FORMULA_NO_TOTAL })
    expect(sup('formula.text')).toEqual({ kind: 'none', why: FORMULA_NO_TOTAL })
  })

  it('asks the server for every path the shown totals need, once each', () => {
    const aggs = {
      'extra.amount': 'avg',
      'formula.left': 'sum',
      'formula.ratio': 'sum',
      'extra.vendor': 'sum',
      'formula.text': 'avg'
    } as const
    const cols = queueTotalColumns({ ...aggs }, sup)
    expect(cols).toEqual(['extra.amount', 'formula.left'])
    expect(queueTotalPaths(cols, sup)).toEqual(['amount', 'qty'])
    // A derived column only ever shows Sum.
    expect(queueTotalColumns({ 'formula.left': 'avg' }, sup)).toEqual([])
  })
})

describe('queue totals — figures', () => {
  const answer = {
    amount: {
      sum: 1300,
      count: 4,
      min: 100,
      max: 600,
      avg: 325,
      by_collection: {
        purchase_orders: { sum: 1000, count: 2, min: 400, max: 600 },
        invoices: { sum: 300, count: 2, min: 100, max: 200 }
      }
    },
    qty: { sum: 0, count: 0, min: null, max: null, avg: null, by_collection: {} }
  }

  it('picks the function asked for; nothing filled in has no figure but a 0 count', () => {
    expect(pickTotal(answer.amount, 'sum')).toBe(1300)
    expect(pickTotal(answer.amount, 'avg')).toBe(325)
    expect(pickTotal(answer.amount, 'min')).toBe(100)
    expect(pickTotal(answer.amount, 'max')).toBe(600)
    expect(pickTotal(answer.qty, 'sum')).toBeNull()
    expect(pickTotal(answer.qty, 'count')).toBe(0)
  })

  it('a derived sum is its inputs’ sums; undefined until the answer has them', () => {
    const left = sup('formula.left')!
    expect(queueTotalValue(answer, left, 'sum')).toBe(1300)
    expect(queueTotalValue({ amount: answer.amount }, left, 'sum')).toBeUndefined()
    expect(queueTotalValue(undefined, sup('extra.amount')!, 'sum')).toBeUndefined()
  })

  it('the tooltip names the rows it covers and the figure per source', () => {
    const tip = queueTotalTip({
      fn: 'sum',
      label: 'Amount',
      rows: 4,
      byCollection: answer.amount.by_collection,
      collectionLabel: (c) => (c === 'purchase_orders' ? 'Purchase Orders' : 'Invoices'),
      format: (v) => `$${v}`
    })
    expect(tip).toBe(
      'Sum of Amount across all 4 matching records. Sum by source: Purchase Orders $1000 · Invoices $300'
    )
    expect(
      queueTotalTip({ fn: 'avg', label: 'Amount', rows: 4, format: String, partial: true })
    ).toMatch(/covers the rows it read/)
  })
})

describe('queue totals — remembered per person per queue', () => {
  it('stores the person’s choices under the queue and reads them back over a view', () => {
    const key = queueTotalsStoreKey('q-1')
    let o = setOverride({}, 'extra.amount', 'avg')
    o = setOverride(o, 'extra.qty', null)
    rememberTotalOverridesAt(key, o)
    const back = loadTotalOverridesAt(key, queueTotalsEligibleKey)
    expect(back).toEqual({ 'extra.amount': 'avg', 'extra.qty': 'off' })
    // A view that totals qty and amount: the person's own choices win.
    expect(shownTotals({ 'extra.amount': 'sum', 'extra.qty': 'sum' }, back)).toEqual({
      'extra.amount': 'avg'
    })
    // Another queue has its own.
    expect(loadTotalOverridesAt(queueTotalsStoreKey('q-2'), queueTotalsEligibleKey)).toEqual({})
  })

  it('drops keys that are not queue columns', () => {
    localStorage.setItem(
      queueTotalsStoreKey('q-1'),
      JSON.stringify({ v: 2, o: { 'extra.a': 'sum', amount: 'sum', 'formula.f': 'nope' } })
    )
    expect(loadTotalOverridesAt(queueTotalsStoreKey('q-1'), queueTotalsEligibleKey)).toEqual({
      'extra.a': 'sum'
    })
  })

  it('a shared worklist link carries the totals on screen', () => {
    expect(
      sanitizeQueueLinkState({
        totals: { 'extra.amount': 'avg', 'formula.left': 'sum', label: 'sum', 'extra.x': 'median' }
      })
    ).toEqual({ totals: { 'extra.amount': 'avg', 'formula.left': 'sum' } })
  })
})

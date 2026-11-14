// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatTotal,
  loadRememberedTotals,
  readTotal,
  rememberTotals,
  totalsEligibleKey,
  totalsParams,
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

  it('remembers the choice per list, dropping anything unknown', () => {
    rememberTotals('orders', { amount: 'avg' })
    expect(loadRememberedTotals('orders')).toEqual({ amount: 'avg' })
    expect(loadRememberedTotals('invoices')).toEqual({})
    localStorage.setItem(
      'nvr_cbv_totals_orders',
      JSON.stringify({ amount: 'median', 'a.b': 'sum' })
    )
    expect(loadRememberedTotals('orders')).toEqual({})
    rememberTotals('orders', {})
    expect(localStorage.getItem('nvr_cbv_totals_orders')).toBeNull()
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

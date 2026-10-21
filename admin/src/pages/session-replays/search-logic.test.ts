import { describe, expect, it } from 'vitest'
import {
  collectionsFromRecordKeys,
  matchLabel,
  readSearchParams,
  searchQueryString,
  wantsSearchTab
} from './search-logic'

describe('replay search params (#1374)', () => {
  it('reads the query from the URL', () => {
    const p = new URLSearchParams('collection=orders&item=%201042%20&tab=search')
    expect(readSearchParams(p)).toEqual({
      collection: 'orders',
      item: '1042',
      field: '',
      selector: '',
      outcome: '',
      route: '',
      days: ''
    })
  })

  it('opens the Search tab for ?tab=search or any search key', () => {
    expect(wantsSearchTab(new URLSearchParams('tab=search'))).toBe(true)
    expect(wantsSearchTab(new URLSearchParams('collection=orders&item=1'))).toBe(true)
    expect(wantsSearchTab(new URLSearchParams('recording=abc&t=10'))).toBe(false)
  })

  it('an outcome search (#1315) carries its window; the window alone is nothing', () => {
    const base = {
      collection: '',
      item: '',
      field: '',
      selector: '',
      outcome: '',
      route: '',
      days: '30'
    }
    expect(searchQueryString(base)).toBe('')
    expect(searchQueryString({ ...base, outcome: '5xx' })).toBe('outcome=5xx&days=30')
    expect(searchQueryString({ ...base, route: '/x', days: '30' })).toBe('route=%2Fx')
    expect(wantsSearchTab(new URLSearchParams('outcome=4xx'))).toBe(true)
    expect(wantsSearchTab(new URLSearchParams('days=7'))).toBe(false)
    expect(matchLabel({ kind: 'outcome', key: 'GET /api/x → 500', first_ms: 0, last_ms: 0 })).toBe(
      'GET /api/x → 500'
    )
  })

  it('builds the endpoint query only when it can be answered', () => {
    const base = {
      collection: '',
      item: '',
      field: '',
      selector: '',
      outcome: '',
      route: '',
      days: ''
    }
    expect(searchQueryString(base)).toBe('')
    expect(searchQueryString({ ...base, item: '1042' })).toBe('')
    expect(searchQueryString({ ...base, collection: 'orders', item: '1042' })).toBe(
      'collection=orders&item=1042'
    )
    expect(searchQueryString({ ...base, selector: '[data-field="a"] input' })).toBe(
      'selector=%5Bdata-field%3D%22a%22%5D+input'
    )
  })

  it('lists collections from record keys', () => {
    expect(collectionsFromRecordKeys(['orders/1', 'orders/2', 'customers/7', 'junk'])).toEqual([
      'customers',
      'orders'
    ])
  })

  it('labels matches', () => {
    expect(matchLabel({ kind: 'record', key: 'orders/1', first_ms: 0, last_ms: 0 })).toBe(
      'Opened orders/1'
    )
    expect(matchLabel({ kind: 'field', key: 'due_date', first_ms: 0, last_ms: 0 })).toBe(
      'In field due_date'
    )
  })
})

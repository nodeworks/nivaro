import { describe, expect, it } from 'vitest'
import { filterUnseen, SeenLog, scopeOfQueryKey, type UnseenChange } from './unseen-changes'

const change = (scope: UnseenChange['scope'], at: string, extra: Partial<UnseenChange> = {}) =>
  ({
    kind: scope === 'field' ? 'field' : scope.startsWith('lines') ? 'lines' : 'files',
    scope,
    at,
    by: 'Beth Smith',
    label: 'Amount',
    ...extra
  }) as UnseenChange

describe('scopeOfQueryKey', () => {
  it('names the surface each record-page read fills', () => {
    expect(scopeOfQueryKey(['item', 'orders', '5'], 'orders', '5')).toBe('field')
    expect(scopeOfQueryKey(['rrv-record', 'orders', 5], 'orders', '5')).toBe('field')
    expect(scopeOfQueryKey(['o2m-rows', 'order_lines', 'order', '5', ''], 'orders', '5')).toBe(
      'lines:order_lines'
    )
    expect(scopeOfQueryKey(['m2m-items', 'orders_files', 'orders_id', '5'], 'orders', '5')).toBe(
      'files:orders_files'
    )
  })
  it('ignores other records and other reads', () => {
    expect(scopeOfQueryKey(['item', 'orders', '6'], 'orders', '5')).toBeNull()
    expect(scopeOfQueryKey(['item', 'vendors', '5'], 'orders', '5')).toBeNull()
    expect(scopeOfQueryKey(['comments', 'orders', '5'], 'orders', '5')).toBeNull()
  })
})

describe('filterUnseen — unseen-change detection', () => {
  const at = '2026-11-14T10:00:00.000Z'
  const t = Date.parse(at)
  it('a change no later read brought on screen is unseen', () => {
    const out = filterUnseen([change('field', at)], [{ scope: 'field', at: t - 60_000 }])
    expect(out).toHaveLength(1)
  })
  it('a read of the same surface that started after the change has shown it', () => {
    expect(filterUnseen([change('field', at)], [{ scope: 'field', at: t + 300 }])).toEqual([])
  })
  it('a read of another surface does not count (lines are not on the record read)', () => {
    const out = filterUnseen([change('lines:order_lines', at)], [{ scope: 'field', at: t + 5000 }])
    expect(out).toHaveLength(1)
    expect(
      filterUnseen([change('lines:order_lines', at)], [{ scope: 'lines:order_lines', at: t + 10 }])
    ).toEqual([])
  })
  it('allows a second of clock jitter, no more', () => {
    expect(filterUnseen([change('field', at)], [{ scope: 'field', at: t - 900 }])).toEqual([])
    expect(filterUnseen([change('field', at)], [{ scope: 'field', at: t - 1500 }])).toHaveLength(1)
  })
})

describe('SeenLog', () => {
  it('keeps the first read as "since" and the newest per surface', () => {
    const log = new SeenLog('orders', '5')
    log.mark('field', 1000)
    log.mark('field', 5000)
    log.mark('lines:order_lines', 3000)
    expect(log.since()).toBe(1000)
    expect(log.fieldsSince()).toBe(5000)
    expect(log.all()).toHaveLength(2)
  })
  it('a read counts from when it started, not when it ended', () => {
    const log = new SeenLog('orders', '5')
    log.started('h1', 2000)
    log.succeeded('h1', ['item', 'orders', '5'], 9000)
    expect(log.fieldsSince()).toBe(2000)
    // Another record's read is not this page's.
    log.started('h2', 3000)
    log.succeeded('h2', ['item', 'orders', '7'], 9000)
    expect(log.all()).toHaveLength(1)
  })
  it('seeds from reads already in the cache', () => {
    const log = new SeenLog('orders', '5')
    log.seed([
      { queryKey: ['item', 'orders', '5'], dataUpdatedAt: 10_000 },
      { queryKey: ['item', 'orders', '9'], dataUpdatedAt: 20_000 }
    ])
    expect(log.since()).toBe(9000)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecordGapTracker, type RecordRef, recordRefetchEvent } from './record-gaps'

const up = (item: string | number, iseq?: number, collection = 'orders') => ({
  collection,
  item,
  action: 'update',
  ...(iseq != null ? { _iseq: iseq } : {})
})

function tracker(opts: { graceMs?: number; maxRecords?: number } = {}) {
  const reread: RecordRef[] = []
  const t = createRecordGapTracker({ refetch: (list) => reread.push(...list), ...opts })
  return { t, reread }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('record gap tracker (realtime 23)', () => {
  it('re-reads just the record whose counter skipped, after the grace', () => {
    const { t, reread } = tracker({ graceMs: 4000 })
    t.observe('collection:update', up(7, 1))
    t.observe('collection:update', up(8, 1))
    t.observe('collection:update', up(7, 2))
    t.observe('collection:update', up(7, 4)) // 3 never came
    t.observe('collection:update', up(8, 2))
    vi.advanceTimersByTime(3999)
    expect(reread).toEqual([])
    vi.advanceTimersByTime(1)
    expect(reread).toEqual([{ collection: 'orders', item: '7' }])
    expect(t.stats()).toMatchObject({ gaps: 1, missed: 1, refetched: 1 })
  })

  it('a late arrival fills the gap and nothing is re-read', () => {
    const { t, reread } = tracker()
    t.observe('collection:update', up('a', 5))
    t.observe('collection:update', up('a', 7))
    t.observe('collection:update', up('a', 6)) // out of order, from another server
    vi.advanceTimersByTime(10_000)
    expect(reread).toEqual([])
  })

  it('a replayed event (room catch-up) fills it too', () => {
    const { t, reread } = tracker()
    t.observe('collection:update', up(1, 1))
    t.observe('collection:update', up(1, 3))
    t.observe('collection:update', { ...up(1, 2), _seq: 99 })
    vi.advanceTimersByTime(10_000)
    expect(reread).toEqual([])
  })

  it('a counter that restarts at 1 (lapsed after an idle hour) is a new baseline', () => {
    const { t, reread } = tracker()
    t.observe('collection:update', up(1, 9))
    t.observe('collection:update', up(1, 1))
    t.observe('collection:update', up(1, 2))
    vi.advanceTimersByTime(10_000)
    expect(reread).toEqual([])
  })

  it('duplicates and stale repeats change nothing', () => {
    const { t, reread } = tracker()
    t.observe('collection:update', up(1, 4))
    t.observe('collection:update', up(1, 4))
    t.observe('collection:update', up(1, 3))
    t.observe('collection:update', up(1, 5))
    vi.advanceTimersByTime(10_000)
    expect(reread).toEqual([])
  })

  it('reads merged bursts by their per-record ranges', () => {
    const { t, reread } = tracker()
    t.observe('collection:update', up(1, 1))
    t.observe('collection:update', up(2, 1))
    // 1: 2..4 covered — no gap; 2: 3..3 — 2 is missing
    t.observe('collection:update', {
      collection: 'orders',
      item: null,
      items: [1, 2],
      coalesced: true,
      _iseqs: { '1': [2, 4], '2': [3, 3] }
    })
    vi.advanceTimersByTime(10_000)
    expect(reread).toEqual([{ collection: 'orders', item: '2' }])
  })

  it('forgets what it cannot judge: no number, a collection-wide burst, a refetch', () => {
    const { t, reread } = tracker()
    t.observe('collection:update', up(1, 1))
    t.observe('collection:update', up(1)) // an older server, a durable replay
    t.observe('collection:update', up(1, 5)) // new baseline, not a gap
    t.observe('collection:update', up(2, 1))
    t.observe('collection:update', { collection: 'orders', item: null, many: true })
    t.observe('collection:update', up(2, 5))
    t.observe('collection:update', up(3, 1, 'invoices'))
    t.forget(['invoices'])
    t.observe('collection:update', up(3, 4, 'invoices'))
    vi.advanceTimersByTime(10_000)
    expect(reread).toEqual([])
    expect(t.stats().gaps).toBe(0)
  })

  it('a pending re-read is dropped when the collection is forgotten', () => {
    const { t, reread } = tracker()
    t.observe('collection:update', up(1, 1))
    t.observe('collection:update', up(1, 3))
    t.forget()
    vi.advanceTimersByTime(10_000)
    expect(reread).toEqual([])
  })

  it('ignores other events and keeps a bounded memory', () => {
    const { t } = tracker({ maxRecords: 3 })
    t.observe('chat:message', { collection: 'orders', item: 1, _iseq: 1 })
    expect(t.stats().tracked).toBe(0)
    for (let i = 0; i < 10; i++) t.observe('collection:update', up(i, 1))
    expect(t.stats().tracked).toBe(3)
  })

  it('the re-read notice is an update of that one record', () => {
    expect(recordRefetchEvent({ collection: 'orders', item: '7' })).toEqual({
      event: 'collection:update',
      payload: { collection: 'orders', item: '7' }
    })
  })
})

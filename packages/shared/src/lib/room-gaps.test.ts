import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoomGapTracker, refetchEventsFor } from './room-gaps'

function setup() {
  const requests: Array<{ room: string; cursor: number; missed: number }> = []
  const dispatched: Array<[string, Record<string, unknown>]> = []
  const refetched: string[][] = []
  const t = createRoomGapTracker({
    request: (r) => requests.push(r),
    dispatch: (e, p) => dispatched.push([e, p]),
    refetch: (rooms) => refetched.push(rooms),
    graceMs: 100
  })
  const ev = (rseq: number, seq: number, extra: Record<string, unknown> = {}) => ({
    collection: 'a',
    item: rseq,
    _room: 'collection:a',
    _rseq: rseq,
    _seq: seq,
    ...extra
  })
  return { t, requests, dispatched, refetched, ev }
}

afterEach(() => vi.useRealTimers())

describe('missed-event detection per room (#2462)', () => {
  it('asks for one room after the grace when its counter skips, and replays the gap', () => {
    vi.useFakeTimers()
    const { t, requests, dispatched, ev } = setup()
    t.observe(ev(1, 10))
    t.observe(ev(2, 11))
    t.observe(ev(5, 20)) // 3 and 4 never arrived
    expect(requests).toEqual([])
    vi.advanceTimersByTime(150)
    expect(requests).toEqual([{ room: 'collection:a', cursor: 11, missed: 2 }])
    t.replayed({
      room: 'collection:a',
      events: [
        { seq: 14, rseq: 3, event: 'collection:update', payload: { collection: 'a', item: 3 } },
        { seq: 17, rseq: 4, event: 'collection:update', payload: { collection: 'a', item: 4 } },
        { seq: 20, rseq: 5, event: 'collection:update', payload: { collection: 'a', item: 5 } }
      ]
    })
    expect(dispatched.map(([, p]) => p.item)).toEqual([3, 4])
    expect(t.stats()).toMatchObject({ gaps: 1, missed: 2, replayed: 2 })
  })

  it('a late arrival inside the grace cancels the request', () => {
    vi.useFakeTimers()
    const { t, requests, ev } = setup()
    t.observe(ev(1, 10))
    t.observe(ev(3, 12))
    t.observe(ev(2, 11))
    vi.advanceTimersByTime(150)
    expect(requests).toEqual([])
  })

  it('a merged burst covering the range is no gap; a reset forgets the baseline', () => {
    vi.useFakeTimers()
    const { t, requests, ev } = setup()
    t.observe(ev(1, 10))
    t.observe(ev(4, 13, { _rseq_min: 2 }))
    t.reset(['collection:a'])
    t.observe(ev(9, 30))
    vi.advanceTimersByTime(150)
    expect(requests).toEqual([])
  })

  it('a room that cannot be replayed (or lost too much) is refetched', () => {
    vi.useFakeTimers()
    const { t, refetched, ev } = setup()
    t.observe(ev(1, 10))
    t.observe(ev(3, 12))
    vi.advanceTimersByTime(150)
    t.replayed({ room: 'collection:a', full: true, events: [] })
    t.observe(ev(500, 900))
    expect(refetched).toEqual([['collection:a'], ['collection:a']])
  })

  it('events without a room counter are ignored', () => {
    const { t, requests } = setup()
    t.observe({ collection: 'a', item: 1, _seq: 3 })
    t.observe(null)
    expect(requests).toEqual([])
  })
})

describe('refetch events for stale rooms (#2460)', () => {
  it('maps collection, record and chat rooms to the notices their screens refetch on', () => {
    expect(refetchEventsFor(['collection:a', 'record:b:7', 'chat:dm:x:y', 'presence:z'])).toEqual([
      {
        event: 'collection:update',
        payload: { collection: 'a', item: null, items: null, many: true, count: 0, coalesced: true }
      },
      { event: 'collection:update', payload: { collection: 'b', item: '7' } },
      { event: 'chat:message', payload: { room: 'dm:x:y', touch: true } }
    ])
  })
})

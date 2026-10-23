import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquirePresenceListener, PRESENCE_REFETCH_DELAY_MS } from './presence-live'
import { presenceChangeTouches } from './presence-state'
import type { RealtimeAdapter } from './realtime'

function fakeAdapter() {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  const adapter = {
    on: vi.fn((event: string, cb: (p: unknown) => void) => {
      const set = handlers.get(event) ?? new Set()
      set.add(cb)
      handlers.set(event, set)
      return () => set.delete(cb)
    })
  } as unknown as RealtimeAdapter
  const fire = (event: string, payload: unknown) => {
    for (const cb of handlers.get(event) ?? []) cb(payload)
  }
  const count = (event: string) => handlers.get(event)?.size ?? 0
  return { adapter, fire, count }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('tab-wide presence:changed listener', () => {
  it('many readers share ONE subscription, released with the last one', () => {
    const qc = new QueryClient()
    const { adapter, count } = fakeAdapter()
    const r1 = acquirePresenceListener(qc, adapter)
    const r2 = acquirePresenceListener(qc, adapter)
    const r3 = acquirePresenceListener(qc, adapter)
    expect(count('presence:changed')).toBe(1)
    r1()
    r2()
    r2() // releasing twice is harmless
    expect(count('presence:changed')).toBe(1)
    r3()
    expect(count('presence:changed')).toBe(0)
  })

  it('collapses a burst into one invalidate a second after the first event', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const { adapter, fire } = fakeAdapter()
    const release = acquirePresenceListener(qc, adapter)
    acquirePresenceListener(qc, adapter) // a second reader adds no second refetch
    fire('presence:changed', { user_id: 'a' }) // older server shape
    fire('presence:changed', { user_id: 'b', user_ids: ['b', 'c'] }) // coalesced shape
    vi.advanceTimersByTime(PRESENCE_REFETCH_DELAY_MS - 1)
    expect(spy).not.toHaveBeenCalled()
    fire('presence:changed', { user_id: 'd', user_ids: ['d'] })
    vi.advanceTimersByTime(1)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ queryKey: ['presence-online'] }, { cancelRefetch: false })
    // The next burst schedules again.
    fire('presence:changed', { user_id: 'e', user_ids: ['e'] })
    vi.advanceTimersByTime(PRESENCE_REFETCH_DELAY_MS)
    expect(spy).toHaveBeenCalledTimes(2)
    release()
  })
})

describe('presenceChangeTouches', () => {
  it('reads both payload shapes, case-insensitively', () => {
    expect(presenceChangeTouches({ user_id: 'abc' }, 'ABC')).toBe(true)
    expect(presenceChangeTouches({ user_id: 'x', user_ids: ['x', 'Abc'] }, 'abc')).toBe(true)
    expect(presenceChangeTouches({ user_id: 'x', user_ids: ['x'] }, 'abc')).toBe(false)
    expect(presenceChangeTouches({ user_id: 'x', user_ids: ['x'], many: true }, 'abc')).toBe(true)
    expect(presenceChangeTouches(null, 'abc')).toBe(false)
    expect(presenceChangeTouches({ user_id: 'abc' }, null)).toBe(false)
  })
})

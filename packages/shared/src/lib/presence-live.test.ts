import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquirePresenceListener,
  PRESENCE_MIN_REFRESH_GAP_MS,
  PRESENCE_REFRESH_JITTER_MS,
  PRESENCE_REFRESH_WINDOW_MS,
  presenceLiveClock,
  presenceRefreshDelay
} from './presence-live'
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

const realRandom = presenceLiveClock.random
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-23T12:00:00Z'))
})
afterEach(() => {
  presenceLiveClock.random = realRandom
  vi.useRealTimers()
})

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
    vi.advanceTimersByTime(PRESENCE_REFRESH_WINDOW_MS - 1)
    expect(spy).not.toHaveBeenCalled()
    fire('presence:changed', { user_id: 'd', user_ids: ['d'] })
    vi.advanceTimersByTime(1)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith({ queryKey: ['presence-online'] }, { cancelRefetch: false })
    // The next burst schedules again — but it comes right after a refresh, so it waits the gap.
    presenceLiveClock.random = () => 0
    fire('presence:changed', { user_id: 'e', user_ids: ['e'] })
    vi.advanceTimersByTime(PRESENCE_MIN_REFRESH_GAP_MS - 1)
    expect(spy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(spy).toHaveBeenCalledTimes(2)
    release()
  })
})

describe('refresh throttle (250 people ≈ 400 tabs)', () => {
  it('the delay rule: ~1 s when quiet, the rest of the 10 s gap plus jitter when busy', () => {
    expect(presenceRefreshDelay(PRESENCE_MIN_REFRESH_GAP_MS, 0.9)).toBe(PRESENCE_REFRESH_WINDOW_MS)
    expect(presenceRefreshDelay(60_000, 0.9)).toBe(PRESENCE_REFRESH_WINDOW_MS)
    expect(presenceRefreshDelay(3000, 0)).toBe(7000)
    expect(presenceRefreshDelay(3000, 1)).toBe(7000 + PRESENCE_REFRESH_JITTER_MS)
    expect(presenceRefreshDelay(0, 0.5)).toBe(10_000 + PRESENCE_REFRESH_JITTER_MS / 2)
  })

  // The worst case Rob asked to see: changes every few hundred ms for a minute, the server
  // window at its 3 s cap, the jitter at its maximum. Every change must be read by a refresh
  // that STARTS within ~12 s of it, and the tab refreshes at most once per 10 s.
  for (const serverWindowMs of [2000, 3000]) {
    it(`worst case with a ${serverWindowMs} ms server window: ≤ 12 s stale, ≤ 1 refresh / 10 s`, () => {
      presenceLiveClock.random = () => 1
      const qc = new QueryClient()
      const fires: number[] = []
      vi.spyOn(qc, 'invalidateQueries').mockImplementation(async () => {
        fires.push(Date.now())
      })
      const { adapter, fire } = fakeAdapter()
      const release = acquirePresenceListener(qc, adapter, 'me')
      const t0 = Date.now()
      const changes: number[] = []
      // A change every 250 ms; the server emits the first at once, then one per window.
      let nextEmit = t0
      for (let t = 0; t < 60_000; t += 250) {
        vi.setSystemTime(t0 + t)
        vi.advanceTimersByTime(0)
        changes.push(Date.now())
        if (Date.now() >= nextEmit) {
          fire('presence:changed', { user_id: 'x', user_ids: ['x', 'y'] })
          nextEmit = Date.now() + serverWindowMs
        }
        vi.advanceTimersByTime(250)
        vi.setSystemTime(t0 + t + 250)
      }
      vi.advanceTimersByTime(20_000)
      // Staleness: from each change to the first refresh that starts after it.
      let worst = 0
      for (const c of changes) {
        const f = fires.find((x) => x > c)
        if (f == null) continue
        worst = Math.max(worst, f - c)
      }
      expect(worst).toBeLessThanOrEqual(PRESENCE_MIN_REFRESH_GAP_MS + PRESENCE_REFRESH_JITTER_MS)
      for (let i = 1; i < fires.length; i++)
        expect(fires[i] - fires[i - 1]).toBeGreaterThanOrEqual(PRESENCE_MIN_REFRESH_GAP_MS)
      // ~60 s / ~11 s: a handful of refreshes, not one per event (~20–30 events).
      expect(fires.length).toBeLessThanOrEqual(7)
      release()
    })
  }

  it('the first change after a quiet spell refreshes after ~1 s', () => {
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const { adapter, fire } = fakeAdapter()
    const release = acquirePresenceListener(qc, adapter)
    fire('presence:changed', { user_id: 'a', user_ids: ['a'] })
    vi.advanceTimersByTime(PRESENCE_REFRESH_WINDOW_MS)
    expect(spy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PRESENCE_MIN_REFRESH_GAP_MS) // quiet for > 10 s
    fire('presence:changed', { user_id: 'b', user_ids: ['b'] })
    vi.advanceTimersByTime(PRESENCE_REFRESH_WINDOW_MS)
    expect(spy).toHaveBeenCalledTimes(2)
    release()
  })

  it("the tab's own change refreshes at once, replacing a pending refresh", () => {
    presenceLiveClock.random = () => 0
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const { adapter, fire } = fakeAdapter()
    const release = acquirePresenceListener(qc, adapter, 'Me-1')
    fire('presence:changed', { user_id: 'a', user_ids: ['a'] })
    vi.advanceTimersByTime(PRESENCE_REFRESH_WINDOW_MS) // refresh #1
    fire('presence:changed', { user_id: 'b', user_ids: ['b'] }) // busy: waits ~10 s
    vi.advanceTimersByTime(2000)
    expect(spy).toHaveBeenCalledTimes(1)
    fire('presence:changed', { user_id: 'b', user_ids: ['b', 'ME-1'] })
    expect(spy).toHaveBeenCalledTimes(2) // at once
    // The pending timer was replaced, not left to fire as well.
    vi.advanceTimersByTime(8000)
    expect(spy).toHaveBeenCalledTimes(2)
    // `many` means "maybe everyone" — not a reason to skip the throttle.
    fire('presence:changed', { user_id: 'z', user_ids: ['z'], many: true })
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

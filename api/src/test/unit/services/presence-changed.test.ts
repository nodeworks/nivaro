import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPresenceChangedCoalescer,
  PRESENCE_CHANGED_MAX_IDS,
  PRESENCE_CHANGED_MAX_WINDOW_MS,
  PRESENCE_CHANGED_WINDOW_MS,
  type PresenceChangedPayload,
  payloadFor
} from '../../../services/presence-changed.js'

let sent: Array<{ tenant: string; payload: PresenceChangedPayload }>
const emit = (tenant: string, payload: PresenceChangedPayload) => sent.push({ tenant, payload })

beforeEach(() => {
  sent = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('presence:changed coalescer', () => {
  it('sends the first change at once (leading edge), with user_id kept for old clients', () => {
    const c = createPresenceChangedCoalescer(emit, 2000)
    c.note('', 'u-1')
    expect(sent).toEqual([{ tenant: '', payload: { user_id: 'u-1', user_ids: ['u-1'] } }])
    c.dispose()
  })

  it('gathers a burst into ONE trailing event carrying every changed id', () => {
    const c = createPresenceChangedCoalescer(emit, 2000)
    c.note('', 'u-1')
    c.note('', 'u-2')
    c.note('', 'U-3')
    c.note('', 'u-2') // same person twice in a window: listed once
    c.note('', 'u-3') // ids compare case-insensitively
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(1999)
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].payload).toEqual({ user_id: 'u-2', user_ids: ['u-2', 'u-3'] })
    c.dispose()
  })

  it('sends at most one event per window while changes keep coming', () => {
    const c = createPresenceChangedCoalescer(emit, 2000)
    for (let i = 0; i < 100; i++) {
      c.note('', `u-${i}`)
      vi.advanceTimersByTime(100) // 10 s of churn, one change every 100 ms
    }
    // Leading edge + one per elapsed 2 s window.
    expect(sent.length).toBeLessThanOrEqual(6)
    vi.advanceTimersByTime(10_000)
    const ids = new Set(sent.flatMap((s) => s.payload.user_ids))
    expect(ids.size).toBe(100) // nobody lost
    c.dispose()
  })

  it('goes quiet after an empty window, so the next change is prompt again', () => {
    const c = createPresenceChangedCoalescer(emit, 2000)
    c.note('', 'u-1')
    vi.advanceTimersByTime(2000) // window closes with nothing pending
    expect(c.stats().open_windows).toBe(0)
    c.note('', 'u-2')
    expect(sent.map((s) => s.payload.user_ids)).toEqual([['u-1'], ['u-2']])
    c.dispose()
  })

  it('keeps tenants apart', () => {
    const c = createPresenceChangedCoalescer(emit, 2000)
    c.note('t1', 'a')
    c.note('t2', 'b')
    c.note('t1', 'c')
    expect(sent.map((s) => [s.tenant, s.payload.user_ids])).toEqual([
      ['t1', ['a']],
      ['t2', ['b']]
    ])
    vi.advanceTimersByTime(2000)
    expect(sent[2]).toEqual({ tenant: 't1', payload: { user_id: 'c', user_ids: ['c'] } })
    expect(sent).toHaveLength(3)
    c.dispose()
  })

  it('cuts a very long list and says so with many', () => {
    const ids = Array.from({ length: PRESENCE_CHANGED_MAX_IDS + 5 }, (_, i) => `u-${i}`)
    const p = payloadFor(ids)
    expect(p.user_ids).toHaveLength(PRESENCE_CHANGED_MAX_IDS)
    expect(p.many).toBe(true)
    expect(p.user_id).toBe('u-0')
    expect(payloadFor(['x']).many).toBeUndefined()
  })

  it('a throwing emit never breaks the coalescer', () => {
    const c = createPresenceChangedCoalescer(() => {
      throw new Error('boom')
    }, 2000)
    expect(() => c.note('', 'u-1')).not.toThrow()
    c.note('', 'u-2')
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
    c.dispose()
  })

  describe('adaptive window', () => {
    it('grows while changes keep arriving, capped, and stays leading-edge when quiet', () => {
      const c = createPresenceChangedCoalescer(emit, { minMs: 2000, maxMs: 8000, growth: 2 })
      c.note('', 'u-0')
      expect(sent).toHaveLength(1) // leading edge
      expect(c.windowFor('')).toBe(2000)
      const at: number[] = []
      const start = Date.now()
      for (let i = 1; i <= 300; i++) {
        c.note('', `u-${i}`)
        vi.advanceTimersByTime(100)
        if (sent.length > at.length + 1) at.push(Date.now() - start)
      }
      // Gaps between trailing events: 2 s, 4 s, then 8 s (the cap) — never more.
      const gaps = at.map((t, i) => t - (i ? at[i - 1] : 0))
      expect(gaps.slice(0, 3)).toEqual([2000, 4000, 8000])
      for (const g of gaps.slice(3)) expect(g).toBe(8000)
      expect(c.windowFor('')).toBe(8000)
      c.dispose()
    })

    it('decays when quiet and starts over at the start size', () => {
      const c = createPresenceChangedCoalescer(emit, { minMs: 2000, maxMs: 8000, growth: 2 })
      for (let i = 0; i < 100; i++) {
        c.note('', `u-${i}`)
        vi.advanceTimersByTime(100)
      }
      expect(c.windowFor('')).toBeGreaterThan(2000)
      vi.advanceTimersByTime(60_000) // quiet: windows close empty, the size comes back down
      expect(c.stats().open_windows).toBe(0)
      expect(c.windowFor('')).toBe(2000)
      const before = sent.length
      c.note('', 'late')
      expect(sent).toHaveLength(before + 1) // a quiet tenant still hears the first change at once
      vi.advanceTimersByTime(1999)
      c.note('', 'later')
      vi.advanceTimersByTime(1)
      expect(sent).toHaveLength(before + 2) // and its window is the 2 s start again
      c.dispose()
    })

    it('keeps each tenant on its own size', () => {
      const c = createPresenceChangedCoalescer(emit, { minMs: 2000, maxMs: 8000, growth: 2 })
      for (let i = 0; i < 100; i++) {
        c.note('busy', `u-${i}`)
        vi.advanceTimersByTime(100)
      }
      expect(c.windowFor('busy')).toBeGreaterThan(2000)
      expect(c.windowFor('quiet')).toBe(2000)
      c.note('quiet', 'q')
      expect(sent.at(-1)).toEqual({ tenant: 'quiet', payload: { user_id: 'q', user_ids: ['q'] } })
      c.dispose()
    })

    it('the defaults: 2 s quiet, never past the 3 s cap (the client throttle does the spreading)', () => {
      expect(PRESENCE_CHANGED_WINDOW_MS).toBe(2000)
      expect(PRESENCE_CHANGED_MAX_WINDOW_MS).toBeLessThanOrEqual(3000)
      const c = createPresenceChangedCoalescer(emit)
      for (let i = 0; i < 200; i++) {
        c.note('', `u-${i}`)
        vi.advanceTimersByTime(100)
      }
      expect(c.windowFor('')).toBe(PRESENCE_CHANGED_MAX_WINDOW_MS)
      // 20 s of churn: leading edge + about one event per 3 s.
      expect(sent.length).toBeLessThanOrEqual(1 + Math.ceil(20_000 / 2000))
      expect(sent.length).toBeGreaterThanOrEqual(
        Math.floor(20_000 / PRESENCE_CHANGED_MAX_WINDOW_MS)
      )
      c.dispose()
    })
  })
})

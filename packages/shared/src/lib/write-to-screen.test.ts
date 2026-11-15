import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteOwnWrite } from './own-writes'
import {
  createWriteToScreenSampler,
  FLUSH_EVERY_MS,
  START_WINDOW_MS,
  type W2SDeps,
  type W2SSample
} from './write-to-screen'

function harness(over: Partial<W2SDeps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const sent: W2SSample[][] = []
  let server = 1_000_000
  const deps: W2SDeps = {
    now: () => Date.now(),
    serverNow: () => server + Date.now(),
    client: () => qc,
    visible: () => true,
    liveMode: () => 'normal',
    frame: (cb) => setTimeout(cb, 16),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    screen: () => '/collections/:c',
    send: (s) => sent.push(s),
    ...over
  }
  const sampler = createWriteToScreenSampler(deps)
  return {
    qc,
    sent,
    sampler,
    skew: (ms: number) => {
      server += ms
    }
  }
}

const ev = (seq: number, extra: Record<string, unknown> = {}) => ({
  collection: 'workflows',
  item: 7,
  action: 'update',
  changed_fields: ['amount'],
  _seq: seq,
  _st: 1_000_000 + Date.now() - 50,
  ...extra
})

/** A read that takes `ms` to answer. */
function refetch(qc: QueryClient, key: unknown[], ms: number) {
  return qc.fetchQuery({
    queryKey: key,
    queryFn: () => new Promise((r) => setTimeout(() => r({ ok: true }), ms)),
    staleTime: 0
  })
}

describe('write-to-screen sampler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('times a stamped event from arrival to the screen settling', async () => {
    const h = harness()
    expect(h.sampler.note(ev(50))).toBe(true)
    // The list coalesces for ~1 s, then re-reads for 300 ms.
    await vi.advanceTimersByTimeAsync(1000)
    void refetch(h.qc, ['items', 'workflows', { page: 1 }], 300)
    await vi.advanceTimersByTimeAsync(400)
    expect(h.sampler.measuring()).toBe(false)
    expect(h.sampler.pending()).toBe(1)
    await vi.advanceTimersByTimeAsync(FLUSH_EVERY_MS)
    const [s] = h.sent[0]
    expect(s).toMatchObject({ seq: 50, collection: 'workflows', screen: '/collections/:c' })
    expect(s.rx - s.st).toBe(50)
    // ~1 s coalesce + 300 ms read + two frames.
    expect(s.done - s.rx).toBeGreaterThanOrEqual(1300)
    expect(s.done - s.rx).toBeLessThan(1400)
  })

  it('waits for every read the event set off, preferring ones named for the collection', async () => {
    const h = harness()
    h.sampler.note(ev(51))
    void refetch(h.qc, ['items', 'workflows'], 200)
    void refetch(h.qc, ['record', 'workflows', 7], 900)
    void refetch(h.qc, ['unrelated-poll'], 5000)
    await vi.advanceTimersByTimeAsync(500)
    expect(h.sampler.measuring()).toBe(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(h.sampler.measuring()).toBe(false)
    h.sampler.flush()
    expect(h.sent[0][0].done - h.sent[0][0].rx).toBeLessThan(1000)
  })

  it('sends nothing when the screen re-read nothing for it', async () => {
    const h = harness()
    h.sampler.note(ev(52))
    await vi.advanceTimersByTimeAsync(START_WINDOW_MS + 10)
    expect(h.sampler.measuring()).toBe(false)
    h.sampler.flush()
    expect(h.sent).toEqual([])
  })

  it('ignores unstamped events, repeats, own writes, Calm/Off and hidden tabs', async () => {
    const h = harness()
    expect(h.sampler.note({ collection: 'workflows', item: 1, _seq: 3 })).toBe(false)
    noteOwnWrite('workflows', 99, undefined, ['amount'])
    expect(h.sampler.note(ev(60, { item: 99 }))).toBe(false)
    expect(harness({ liveMode: () => 'calm' }).sampler.note(ev(61))).toBe(false)
    expect(harness({ liveMode: () => 'off' }).sampler.note(ev(62))).toBe(false)
    expect(harness({ visible: () => false }).sampler.note(ev(63))).toBe(false)
    expect(h.sampler.note(ev(64))).toBe(true)
    // Same event through a second subscriber: counted once.
    expect(h.sampler.note(ev(64))).toBe(false)
  })

  it('measures one change at a time, with a gap between', async () => {
    const h = harness()
    expect(h.sampler.note(ev(70))).toBe(true)
    expect(h.sampler.note(ev(71))).toBe(false)
    await vi.advanceTimersByTimeAsync(START_WINDOW_MS + 10)
    expect(h.sampler.note(ev(72))).toBe(true)
  })

  it('flushes a full batch at once', async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) {
      h.sampler.note(ev(100 + i))
      void refetch(h.qc, ['items', 'workflows', i], 50)
      await vi.advanceTimersByTimeAsync(2100)
    }
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].map((s) => s.seq)).toEqual([100, 101, 102, 103, 104])
  })
})

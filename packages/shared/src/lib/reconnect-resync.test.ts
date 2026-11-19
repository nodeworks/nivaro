import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RealtimeStatus } from './realtime'
import { createResyncDetector } from './reconnect-resync'

function statusSource(initial: RealtimeStatus['state'] = 'live') {
  let cur: RealtimeStatus = { state: initial, transport: 'websocket', resumed: null }
  const cbs = new Set<(s: RealtimeStatus) => void>()
  return {
    rt: {
      status: () => cur,
      onStatus(cb: (s: RealtimeStatus) => void) {
        cbs.add(cb)
        return () => {
          cbs.delete(cb)
        }
      }
    },
    set(s: Partial<RealtimeStatus>) {
      cur = { ...cur, ...s }
      for (const cb of cbs) cb(cur)
    }
  }
}

function fakeDoc() {
  const cbs = new Set<() => void>()
  const d = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: (_t: string, cb: () => void) => cbs.add(cb),
    removeEventListener: (_t: string, cb: () => void) => cbs.delete(cb),
    show() {
      d.visibilityState = 'visible'
      for (const cb of cbs) cb()
    }
  }
  return d
}

let t = 0
beforeEach(() => {
  vi.useFakeTimers()
  t = 1_000_000
})
afterEach(() => vi.useRealTimers())

const base = (doc: ReturnType<typeof fakeDoc>) => ({
  doc: doc as unknown as Document,
  win: null,
  now: () => t,
  random: () => 0,
  jitterMs: 1000,
  cooldownMs: 5000,
  wakeTickMs: 0,
  allowed: () => true
})

describe('reconnect resync', () => {
  it('fires once after a reconnect whatever the catch-up says (replayed included)', () => {
    const src = statusSource()
    const doc = fakeDoc()
    const d = createResyncDetector(src.rt, base(doc))
    const seen: string[] = []
    d.subscribe((r) => seen.push(r))
    src.set({ state: 'reconnecting' })
    src.set({ state: 'live', resumed: 'replayed' })
    expect(seen).toEqual([])
    vi.advanceTimersByTime(0)
    expect(seen).toEqual(['reconnect'])
    d.dispose()
  })

  it('a first connection (resumed null) is not a reconnect', () => {
    const src = statusSource('reconnecting')
    const doc = fakeDoc()
    const d = createResyncDetector(src.rt, base(doc))
    const seen: string[] = []
    d.subscribe((r) => seen.push(r))
    src.set({ state: 'live', resumed: null })
    vi.advanceTimersByTime(10_000)
    expect(seen).toEqual([])
    d.dispose()
  })

  it('folds a flapping connection into one burst, then one more after the cooldown', () => {
    const src = statusSource()
    const doc = fakeDoc()
    const d = createResyncDetector(src.rt, { ...base(doc), random: () => 0.5 })
    const seen: number[] = []
    d.subscribe(() => seen.push(t))
    for (let i = 0; i < 3; i++) {
      src.set({ state: 'reconnecting' })
      src.set({ state: 'live', resumed: 'unverified' })
    }
    vi.advanceTimersByTime(500)
    expect(seen).toHaveLength(1)
    // Inside the cooldown: waits it out.
    t += 1000
    src.set({ state: 'reconnecting' })
    src.set({ state: 'live', resumed: 'replayed' })
    vi.advanceTimersByTime(3000)
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(1500)
    expect(seen).toHaveLength(2)
    d.dispose()
  })

  it('a hidden tab owes the burst until it is shown', () => {
    const src = statusSource()
    const doc = fakeDoc()
    doc.visibilityState = 'hidden'
    const d = createResyncDetector(src.rt, base(doc))
    const seen: string[] = []
    d.subscribe((r) => seen.push(r))
    src.set({ state: 'reconnecting' })
    src.set({ state: 'live', resumed: 'replayed' })
    vi.advanceTimersByTime(10_000)
    expect(seen).toEqual([])
    doc.show()
    expect(seen).toEqual(['reconnect'])
    doc.show()
    expect(seen).toHaveLength(1)
    d.dispose()
  })

  it('notices a wake from sleep by a late timer tick', () => {
    const doc = fakeDoc()
    const d = createResyncDetector(null, { ...base(doc), wakeTickMs: 15_000, wakeGapMs: 150_000 })
    const seen: string[] = []
    d.subscribe((r) => seen.push(r))
    // Normal ticks: nothing.
    for (let i = 0; i < 4; i++) {
      t += 15_000
      vi.advanceTimersByTime(15_000)
    }
    expect(seen).toEqual([])
    // The machine slept 20 minutes: the next tick comes far too late.
    t += 20 * 60_000
    vi.advanceTimersByTime(15_000)
    vi.advanceTimersByTime(10)
    expect(seen).toEqual(['wake'])
    d.dispose()
  })

  it('does nothing while the person has live updates off', () => {
    const src = statusSource()
    const doc = fakeDoc()
    const d = createResyncDetector(src.rt, { ...base(doc), allowed: () => false })
    const seen: string[] = []
    d.subscribe((r) => seen.push(r))
    src.set({ state: 'reconnecting' })
    src.set({ state: 'live', resumed: 'replayed' })
    vi.advanceTimersByTime(10_000)
    expect(seen).toEqual([])
    d.dispose()
  })
})

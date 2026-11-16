import { describe, expect, it } from 'vitest'
import { createLiveIdle, LIVE_ACTIVE_MS, liveIdleLabel, liveIdleMs, noteLiveEvents } from './idle'

// rrweb: 3 = IncrementalSnapshot; source 0 = Mutation (page changing by itself), 2 = MouseInteraction.
const mutation = (ts: number) => ({ type: 3, timestamp: ts, data: { source: 0 } })
const click = (ts: number) => ({ type: 3, timestamp: ts, data: { source: 2 } })

describe('live idle', () => {
  it('counts from the last input, not from page changes', () => {
    const s = createLiveIdle()
    noteLiveEvents(s, [click(1_000), mutation(50_000), mutation(90_000)], 90_000)
    expect(liveIdleMs(s, 100_000)).toBe(99_000)
  })

  it('keeps counting when the stream goes quiet', () => {
    const s = createLiveIdle()
    noteLiveEvents(s, [click(10_000)], 12_000)
    expect(liveIdleMs(s, 10_000 + 7 * 60_000)).toBe(7 * 60_000)
  })

  it('takes off the lead of a clock that runs ahead of the viewer', () => {
    const s = createLiveIdle()
    noteLiveEvents(s, [click(20_000)], 15_000) // their clock is 5 s ahead
    expect(liveIdleMs(s, 15_000)).toBe(0)
    expect(liveIdleMs(s, 75_000)).toBe(60_000)
  })

  it('is unknown before any input arrives', () => {
    const s = createLiveIdle()
    noteLiveEvents(s, [mutation(1_000)], 1_000)
    expect(liveIdleMs(s, 5_000)).toBeNull()
    expect(liveIdleLabel(null)).toBeNull()
  })

  it('labels active, idle and away', () => {
    expect(liveIdleLabel(LIVE_ACTIVE_MS - 1)?.text).toBe('Active now')
    expect(liveIdleLabel(3 * 60_000 + 12_000)).toMatchObject({ tone: 'idle', text: 'Idle 3m 12s' })
    expect(liveIdleLabel(6 * 60_000)).toMatchObject({ tone: 'away', text: 'Idle 6m 00s' })
    expect(liveIdleLabel(2 * 3_600_000 + 5 * 60_000)?.text).toBe('Idle 2h 05m')
  })
})

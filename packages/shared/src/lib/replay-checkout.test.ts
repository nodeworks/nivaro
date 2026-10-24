import { describe, expect, it } from 'vitest'
import {
  createReplayCheckoutState,
  noteReplayEvent,
  REPLAY_CHECKOUT_ACTIVE_MS,
  REPLAY_CHECKOUT_IDLE_MS
} from './replay-checkout'

const mutation = { type: 3, data: { source: 0 } }
const click = { type: 3, data: { source: 2 } }
const full = { type: 2, data: {} }

describe('replay checkouts', () => {
  it('a page updating itself with nobody there checks out every 15 minutes, not every minute', () => {
    const s = createReplayCheckoutState(0)
    let snapshots = 0
    // A live dashboard: a mutation every 10 s for 75 minutes, no input.
    for (let t = 10_000; t <= 75 * 60_000; t += 10_000) {
      if (noteReplayEvent(s, mutation, t)) {
        snapshots++
        noteReplayEvent(s, full, t)
      }
    }
    // rrweb's 60 s checkout took 75 here; ~1 MB each filled the 15 MB cap.
    expect(snapshots).toBe(5)
  })

  it('someone using the tab still gets a checkout a minute', () => {
    const s = createReplayCheckoutState(0)
    expect(noteReplayEvent(s, click, 30_000)).toBe(false)
    expect(noteReplayEvent(s, mutation, REPLAY_CHECKOUT_ACTIVE_MS - 1)).toBe(false)
    expect(noteReplayEvent(s, mutation, REPLAY_CHECKOUT_ACTIVE_MS)).toBe(true)
  })

  it('asks once until the snapshot arrives, and any full snapshot restarts the clock', () => {
    const s = createReplayCheckoutState(0)
    noteReplayEvent(s, click, 1000)
    expect(noteReplayEvent(s, mutation, 61_000)).toBe(true)
    expect(noteReplayEvent(s, mutation, 62_000)).toBe(false)
    noteReplayEvent(s, full, 62_500)
    expect(s.interacted).toBe(false)
    // No input since: the idle interval applies again.
    expect(noteReplayEvent(s, mutation, 62_500 + REPLAY_CHECKOUT_ACTIVE_MS)).toBe(false)
    expect(noteReplayEvent(s, mutation, 62_500 + REPLAY_CHECKOUT_IDLE_MS)).toBe(true)
  })

  it('ignores junk events', () => {
    const s = createReplayCheckoutState(0)
    expect(noteReplayEvent(s, null, 1000)).toBe(false)
    expect(noteReplayEvent(s, { type: 5, data: { tag: 'request' } }, 2000)).toBe(false)
    expect(s.interacted).toBe(false)
  })
})

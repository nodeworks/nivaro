import { describe, expect, it } from 'vitest'
import type { VideoEdits } from '../types'
import { historyReducer, initHistory } from './history'

const e = (n: number): VideoEdits => ({
  v: 1,
  segments: [{ start_ms: 0, end_ms: n, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [],
  blurs: [],
  captions: []
})

describe('historyReducer', () => {
  it('undoes and redoes', () => {
    let h = initHistory(e(1000))
    h = historyReducer(h, { type: 'set', edits: e(2000), now: 0 })
    h = historyReducer(h, { type: 'set', edits: e(3000), now: 5000 })
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.segments[0].end_ms).toBe(2000)
    h = historyReducer(h, { type: 'redo' })
    expect(h.present.segments[0].end_ms).toBe(3000)
  })
  it('merges a drag into one step', () => {
    let h = initHistory(e(1000))
    for (let i = 0; i < 5; i++)
      h = historyReducer(h, { type: 'set', edits: e(2000 + i), key: 'drag:a', now: i * 100 })
    expect(h.past).toHaveLength(1)
    expect(historyReducer(h, { type: 'undo' }).present.segments[0].end_ms).toBe(1000)
  })
  it('starts a new step after a pause in the same drag key', () => {
    let h = initHistory(e(1000))
    h = historyReducer(h, { type: 'set', edits: e(2000), key: 'drag:a', now: 0 })
    h = historyReducer(h, { type: 'set', edits: e(3000), key: 'drag:a', now: 2000 })
    expect(h.past).toHaveLength(2)
  })
  it('clears redo after a new change and caps at 100 steps', () => {
    let h = initHistory(e(1000))
    h = historyReducer(h, { type: 'set', edits: e(2000), now: 0 })
    h = historyReducer(h, { type: 'undo' })
    h = historyReducer(h, { type: 'set', edits: e(5000), now: 1 })
    expect(h.future).toHaveLength(0)
    for (let i = 0; i < 150; i++)
      h = historyReducer(h, { type: 'set', edits: e(6000 + i), now: 10_000 + i * 1000 })
    expect(h.past.length).toBe(100)
  })

  it('adopts the saved copy in place: no undo step, redo kept', () => {
    let h = initHistory(e(1000))
    const sent = e(2000)
    h = historyReducer(h, { type: 'set', edits: sent, now: 0 })
    const saved = e(2000)
    const next = historyReducer(h, { type: 'adopt', from: sent, edits: saved })
    expect(next.present).toBe(saved)
    expect(next.past).toBe(h.past)
    expect(next.future).toBe(h.future)
    expect(historyReducer(next, { type: 'undo' }).present.segments[0].end_ms).toBe(1000)
  })
  it('does not adopt once the author has moved on', () => {
    let h = initHistory(e(1000))
    const sent = e(2000)
    h = historyReducer(h, { type: 'set', edits: sent, now: 0 })
    h = historyReducer(h, { type: 'set', edits: e(3000), now: 5000 })
    expect(historyReducer(h, { type: 'adopt', from: sent, edits: e(2000) })).toBe(h)
  })
})

import { describe, expect, it } from 'vitest'
import {
  createReplayIdleState,
  noteReplayIdle,
  REPLAY_IDLE_PAUSE_MS,
  REPLAY_IDLE_RESUME_WAIT_MS
} from './replay-idle'

const T0 = 1_700_000_000_000
const MIN = 60_000
const meta = { type: 4, data: { href: 'https://app.test/' } }
const snapshot = { type: 2, data: {} }
const mutation = { type: 3, data: { source: 0 } }
const mouseMove = { type: 3, data: { source: 1 } }
const click = { type: 3, data: { source: 2 } }
const custom = { type: 5, data: { tag: 'console', payload: {} } }

describe('noteReplayIdle', () => {
  it('records while someone is at the tab', () => {
    const s = createReplayIdleState(T0)
    expect(noteReplayIdle(s, snapshot, T0)).toBe('keep')
    expect(noteReplayIdle(s, mutation, T0 + 4 * MIN)).toBe('keep')
    expect(noteReplayIdle(s, click, T0 + 4.5 * MIN)).toBe('keep')
    // The clock restarts at each input: 9 minutes in, 4.5 minutes after the click.
    expect(noteReplayIdle(s, mutation, T0 + 9 * MIN)).toBe('keep')
    expect(noteReplayIdle(s, custom, T0 + 9 * MIN)).toBe('keep')
  })

  it('stops recording after five minutes without input, whatever the page does by itself', () => {
    const s = createReplayIdleState(T0)
    expect(REPLAY_IDLE_PAUSE_MS).toBe(5 * MIN)
    expect(noteReplayIdle(s, mutation, T0 + 5 * MIN - 1)).toBe('keep')
    expect(noteReplayIdle(s, mutation, T0 + 5 * MIN)).toBe('drop')
    expect(noteReplayIdle(s, mutation, T0 + 40 * MIN)).toBe('drop')
    expect(noteReplayIdle(s, custom, T0 + 41 * MIN)).toBe('drop')
    // An idle checkout the recorder had already asked for.
    expect(noteReplayIdle(s, meta, T0 + 42 * MIN)).toBe('drop')
    expect(noteReplayIdle(s, snapshot, T0 + 42 * MIN)).toBe('drop')
  })

  it('asks for a snapshot when someone is back and records from that snapshot on', () => {
    const s = createReplayIdleState(T0)
    noteReplayIdle(s, mutation, T0 + 6 * MIN)
    expect(noteReplayIdle(s, mouseMove, T0 + 20 * MIN)).toBe('resume')
    expect(s.idleMs).toBe(20 * MIN)
    // What happens before the snapshot refers to a page the recording never saw.
    expect(noteReplayIdle(s, mouseMove, T0 + 20 * MIN + 5)).toBe('drop')
    expect(noteReplayIdle(s, mutation, T0 + 20 * MIN + 6)).toBe('drop')
    expect(noteReplayIdle(s, custom, T0 + 20 * MIN + 7)).toBe('drop')
    expect(noteReplayIdle(s, meta, T0 + 20 * MIN + 40)).toBe('keep')
    expect(noteReplayIdle(s, snapshot, T0 + 20 * MIN + 41)).toBe('keep')
    expect(noteReplayIdle(s, mutation, T0 + 20 * MIN + 50)).toBe('keep')
    expect(noteReplayIdle(s, click, T0 + 21 * MIN)).toBe('keep')
    // Five minutes count from the input that brought them back, not from the pause.
    expect(noteReplayIdle(s, mutation, T0 + 25 * MIN)).toBe('keep')
    expect(noteReplayIdle(s, mutation, T0 + 26 * MIN + 1)).toBe('drop')
  })

  it('asks once: more input before the snapshot does not ask again', () => {
    const s = createReplayIdleState(T0)
    noteReplayIdle(s, mutation, T0 + 6 * MIN)
    expect(noteReplayIdle(s, click, T0 + 7 * MIN)).toBe('resume')
    expect(noteReplayIdle(s, click, T0 + 7 * MIN + 100)).toBe('drop')
  })

  it('records again when the snapshot never comes', () => {
    const s = createReplayIdleState(T0)
    noteReplayIdle(s, mutation, T0 + 6 * MIN)
    const back = T0 + 7 * MIN
    expect(noteReplayIdle(s, click, back)).toBe('resume')
    expect(noteReplayIdle(s, mutation, back + REPLAY_IDLE_RESUME_WAIT_MS - 1)).toBe('drop')
    expect(noteReplayIdle(s, mutation, back + REPLAY_IDLE_RESUME_WAIT_MS)).toBe('keep')
    expect(noteReplayIdle(s, mutation, back + REPLAY_IDLE_RESUME_WAIT_MS + 10)).toBe('keep')
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  autoRecordingActive,
  parseAutoRecord,
  runAutoRecording,
  stopAutoRecording
} from './auto-record'
import { emitReplayTap, setReplayRecorderMode } from './replay-capture'
import { createDeadClickCounter } from './rum'

const TOKEN = 'a'.repeat(36)

function fakeRecord() {
  let emit: ((e: unknown) => void) | null = null
  const stop = vi.fn()
  const record = Object.assign(
    vi.fn((opts: { emit: (e: unknown) => void }) => {
      emit = opts.emit
      return stop
    }),
    {
      addCustomEvent: vi.fn((tag: string, payload: unknown) => emit?.({ type: 5, tag, payload })),
      takeFullSnapshot: vi.fn(() => emitReplayTap({ type: 2, snapshot: true }))
    }
  )
  return { record, stop, fire: (e: unknown) => emit?.(e) }
}

function deps(record: unknown) {
  const appended: Array<{ id: string; seq: number; events: unknown[] }> = []
  const d = {
    loadRecord: vi.fn(async () => record as never),
    start: vi.fn(async (_t: string) => 'rec-1'),
    append: vi.fn(async (id: string, seq: number, events: unknown[]) => {
      appended.push({ id, seq, events })
      return 'ok' as const
    }),
    end: vi.fn(async () => {}),
    flushMs: 1000
  }
  return { d, appended }
}

afterEach(async () => {
  await stopAutoRecording()
  setReplayRecorderMode(null)
  vi.useRealTimers()
})

describe('parseAutoRecord', () => {
  it('accepts only a known signal with the server token', () => {
    expect(parseAutoRecord({ signal: 'rage-click', minutes: 3, token: TOKEN })).toEqual({
      signal: 'rage-click',
      minutes: 3,
      token: TOKEN
    })
    expect(parseAutoRecord({ signal: 'rage-click', minutes: 60, token: TOKEN })?.minutes).toBe(5)
    expect(parseAutoRecord({ signal: 'whatever', minutes: 3, token: TOKEN })).toBeNull()
    expect(parseAutoRecord({ signal: 'monitor', minutes: 3 })).toBeNull()
    expect(parseAutoRecord(null)).toBeNull()
  })
})

describe('runAutoRecording', () => {
  it('only marks the live recording when full recording is on', async () => {
    setReplayRecorderMode('full')
    const { record } = fakeRecord()
    const { d } = deps(record)
    expect(await runAutoRecording({ signal: 'monitor', minutes: 3, token: TOKEN }, d)).toBe(
      'marked'
    )
    expect(record.addCustomEvent).toHaveBeenCalledWith('signal', { signal: 'monitor' })
    expect(d.start).not.toHaveBeenCalled()
  })

  it('records its own three minutes when nothing is recording, then ends', async () => {
    vi.useFakeTimers()
    const { record, stop, fire } = fakeRecord()
    const { d, appended } = deps(record)
    expect(await runAutoRecording({ signal: 'rage-click', minutes: 3, token: TOKEN }, d)).toBe(
      'started'
    )
    expect(d.start).toHaveBeenCalledWith(TOKEN)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ maskAllInputs: true, blockClass: 'nvr-no-record' })
    )
    expect(autoRecordingActive()).toBe(true)
    // a second signal while one runs is ignored
    expect(await runAutoRecording({ signal: 'rage-click', minutes: 3, token: TOKEN }, d)).toBe(
      'busy'
    )
    fire({ type: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(appended[0]).toMatchObject({ id: 'rec-1', seq: 0 })
    fire({ type: 3 })
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(stop).toHaveBeenCalled()
    expect(d.end).toHaveBeenCalledWith('rec-1')
    expect(appended.flatMap((a) => a.events)).toContainEqual({ type: 3 })
    expect(autoRecordingActive()).toBe(false)
  })

  it('rides the error-clip buffer instead of starting a second rrweb stream', async () => {
    setReplayRecorderMode('clip')
    const { record } = fakeRecord()
    const { d, appended } = deps(record)
    expect(await runAutoRecording({ signal: 'breaker', minutes: 1, token: TOKEN }, d)).toBe(
      'started'
    )
    expect(record).not.toHaveBeenCalled()
    expect(record.takeFullSnapshot).toHaveBeenCalled()
    emitReplayTap({ type: 3, from: 'clip' })
    await stopAutoRecording()
    const events = appended.flatMap((a) => a.events)
    expect(events[0]).toEqual({ type: 2, snapshot: true })
    expect(events).toContainEqual({ type: 3, from: 'clip' })
  })

  it('gives up quietly when the server refuses the token', async () => {
    const { record } = fakeRecord()
    const { d } = deps(record)
    d.start.mockRejectedValueOnce(new Error('409'))
    expect(await runAutoRecording({ signal: 'dead-click', minutes: 3, token: TOKEN }, d)).toBe(
      'failed'
    )
    expect(autoRecordingActive()).toBe(false)
  })
})

describe('dead-click bursts', () => {
  it('fire on the third dead click inside ten seconds', () => {
    const dead = createDeadClickCounter()
    expect(dead(0)).toBe(false)
    expect(dead(4000)).toBe(false)
    expect(dead(9000)).toBe(true)
    // reset after a burst; a slow trickle never adds up
    expect(dead(9500)).toBe(false)
    expect(dead(30_000)).toBe(false)
    expect(dead(45_000)).toBe(false)
  })
})

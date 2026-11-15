import { describe, expect, it } from 'vitest'
import {
  type BuildStatus,
  DEFAULT_IDLE_RESYNC_MS,
  DEFAULT_REPLAY_WINDOW_MS,
  decideIdleResync,
  RESYNC_MIN_GAP_MS
} from './idle-reload'

const NOW = 1_800_000_000_000
const base = {
  now: NOW,
  lastInput: NOW - 1000,
  awayMs: 0,
  missed: false,
  lastResyncAt: 0,
  status: null as BuildStatus | null
}

describe('decideIdleResync (idea 13: stale data refreshes, only a new build reloads)', () => {
  it('a tab in use with fresh data does nothing', () => {
    expect(decideIdleResync(base)).toEqual({ action: 'none', reason: 'fresh' })
  })

  it('away longer than the replay window refreshes data', () => {
    expect(decideIdleResync({ ...base, awayMs: DEFAULT_REPLAY_WINDOW_MS })).toEqual({
      action: 'resync',
      reason: 'replay-window'
    })
  })

  it('the server can shorten the replay window', () => {
    const status: BuildStatus = {
      older: null,
      target: null,
      id: null,
      reason: 'current',
      auto_reload: { enabled: true, idle_seconds: 60 },
      data_resync: { replay_window_s: 600, idle_hours: 4 }
    }
    expect(decideIdleResync({ ...base, status, awayMs: 601_000 }).action).toBe('resync')
    expect(decideIdleResync({ ...base, status, awayMs: 599_000 }).action).toBe('none')
  })

  it('events lost while away refresh data', () => {
    expect(decideIdleResync({ ...base, awayMs: 60_000, missed: true })).toEqual({
      action: 'resync',
      reason: 'missed-events'
    })
  })

  it('hours without input refresh data, once per idle period', () => {
    const idle = { ...base, lastInput: NOW - DEFAULT_IDLE_RESYNC_MS }
    expect(decideIdleResync(idle)).toEqual({ action: 'resync', reason: 'idle-hours' })
    expect(decideIdleResync({ ...idle, lastResyncAt: NOW - RESYNC_MIN_GAP_MS - 1 }).reason).toBe(
      'fresh'
    )
  })

  it('a due build reload wins (it reloads everything)', () => {
    expect(
      decideIdleResync({ ...base, awayMs: DEFAULT_REPLAY_WINDOW_MS, reloadDue: true })
    ).toEqual({ action: 'none', reason: 'build' })
  })

  it('two resyncs are at least a minute apart', () => {
    expect(
      decideIdleResync({ ...base, missed: true, lastResyncAt: NOW - RESYNC_MIN_GAP_MS + 5 })
    ).toEqual({ action: 'none', reason: 'recent' })
  })
})

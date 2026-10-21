import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => ({
  emits: [] as Array<{ room: string; event: string; payload: Record<string, unknown> }>,
  config: {} as Record<string, unknown>
}))

vi.mock('../../../services/event-journal.js', () => ({
  journaledEmit: vi.fn(async (room: string, event: string, payload: Record<string, unknown>) => {
    sent.emits.push({ room, event, payload })
    return { seq: 1, path: 'adapter', room }
  })
}))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async (name: string) => ({
    collection: name,
    browser_config: sent.config[name]
  }))
}))

import {
  forgetLiveMode,
  liveModeNow,
  liveModeOf,
  liveModeStats,
  parseLiveMode,
  queueBatched,
  resetLiveMode
} from '../../../services/collection-live-mode.js'

beforeEach(() => {
  sent.emits = []
  sent.config = {}
  resetLiveMode()
})
afterEach(() => vi.useRealTimers())

describe('per-collection realtime switch (#2490)', () => {
  it('reads browser_config.live_events, defaulting to on', () => {
    expect(parseLiveMode(null)).toBe('on')
    expect(parseLiveMode({ live_events: 'off' })).toBe('off')
    expect(parseLiveMode('{"live_events":"batched"}')).toBe('batched')
    expect(parseLiveMode({ live_events: 'sometimes' })).toBe('on')
    expect(parseLiveMode('not json')).toBe('on')
  })

  it('caches the mode and reads it again after a settings change', async () => {
    sent.config.staging = '{"live_events":"off"}'
    expect(liveModeNow('staging')).toBeNull()
    expect(await liveModeOf('staging')).toBe('off')
    expect(liveModeNow('staging')).toBe('off')
    sent.config.staging = null
    expect(liveModeNow('staging')).toBe('off')
    forgetLiveMode('staging')
    expect(await liveModeOf('staging')).toBe('on')
  })

  it('batches a window of writes into one id-list message', async () => {
    vi.useFakeTimers()
    queueBatched('staging', { collection: 'staging', item: 1, action: 'create' }, 50)
    queueBatched('staging', { collection: 'staging', item: 2, action: 'create' }, 50)
    queueBatched('staging', { collection: 'staging', item: 2, action: 'create' }, 50)
    expect(sent.emits).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60)
    expect(sent.emits).toHaveLength(1)
    expect(sent.emits[0].room).toBe('collection:staging')
    expect(sent.emits[0].payload).toMatchObject({
      collection: 'staging',
      item: null,
      items: [1, 2],
      count: 2,
      coalesced: true,
      batched: true,
      action: 'create'
    })
    expect(liveModeStats()).toMatchObject({ batches: 1 })
  })
})

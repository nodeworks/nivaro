import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetScaleFiguresForTests,
  _setQueueRedisForTests,
  LAT_BOUNDS_MS,
  noteLatency,
  p95Of,
  processLatency,
  queueDepths
} from '../../../services/capacity/scale-figures.js'

// Hub autoscaling figures, app side: the answer-time histogram (last 5 complete minutes, never the
// minute still running) and the hand-off queue depths read from Redis list lengths.

afterEach(() => {
  _resetScaleFiguresForTests()
  _setQueueRedisForTests(undefined)
})

describe('answer times', () => {
  it('counts complete minutes only, within the last five', () => {
    const t = Date.UTC(2026, 10, 25, 12, 10, 30)
    for (let i = 0; i < 95; i++) noteLatency(40, t - 2 * 60_000)
    for (let i = 0; i < 5; i++) noteLatency(2500, t - 2 * 60_000)
    noteLatency(99_999, t) // the running minute: not yet
    noteLatency(99_999, t - 9 * 60_000) // older than five minutes
    const h = processLatency(t)
    expect(h.reduce((a, b) => a + b, 0)).toBe(100)
    expect(p95Of(h)).toBe(50)
    expect(h.length).toBe(LAT_BOUNDS_MS.length + 1)
  })
})

describe('queue depths', () => {
  it('sums the import (runs + jobs) and export lists of the app', async () => {
    const lens = new Map<string, number>()
    _setQueueRedisForTests({
      llen: async (k: string) => {
        if (k.includes('import-handoff') && k.endsWith(':jobs')) return 2
        if (k.includes('import-handoff')) return 3
        if (k.includes('export-handoff')) return 4
        return lens.get(k) ?? 0
      }
    })
    expect(await queueDepths(null)).toEqual({ imports: 5, exports: 4 })
  })

  it('without Redis (or when it fails) there is no figure, never a zero', async () => {
    _setQueueRedisForTests(null)
    expect(await queueDepths(null)).toEqual({ imports: null, exports: null })
    _setQueueRedisForTests({
      llen: async () => {
        throw new Error('down')
      }
    })
    expect(await queueDepths(null)).toEqual({ imports: null, exports: null })
  })
})

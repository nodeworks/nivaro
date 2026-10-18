// #2223 detector settings: normalising, defaults, and the detectors reading them.
import { afterEach, describe, expect, it } from 'vitest'
import {
  DETECTORS,
  defaultDetectorSettings,
  detectorKnob,
  detectorOn,
  normalizeDetectorSettings,
  setDetectorSettingsForTest
} from './traffic-detectors.js'
import { judgeRequest } from './traffic-taps/near-timeout.js'

afterEach(() => setDetectorSettingsForTest(null))

describe('normalizeDetectorSettings', () => {
  it('starts every detector on at its defaults', () => {
    const d = defaultDetectorSettings()
    for (const def of DETECTORS) expect(d[def.id].enabled).toBe(true)
    expect(d.duplicates.window_ms).toBe(500)
    expect(d.retry_storms.per_min).toBe(10)
  })

  it('clamps to each range, drops unknown keys and stores only what differs', () => {
    const { settings, stored } = normalizeDetectorSettings({
      fanout: { limit: 1 },
      retry_storms: { enabled: false, per_min: 10 },
      duplicates: { window_ms: 99_999, junk: 4 },
      nonsense: { enabled: false },
      near_timeout: { share_pct: 'x' }
    })
    expect(settings.fanout.limit).toBe(5)
    expect(settings.duplicates.window_ms).toBe(10_000)
    expect(settings.retry_storms.enabled).toBe(false)
    expect(settings.near_timeout.share_pct).toBe(80)
    expect(stored).toEqual({
      fanout: { limit: 5 },
      retry_storms: { enabled: false },
      duplicates: { window_ms: 10_000 }
    })
  })
})

describe('detectors read the settings', () => {
  it('switches and thresholds apply on the request path', () => {
    setDetectorSettingsForTest({ duplicates: { enabled: false }, n_plus_one: { trips: 100 } })
    expect(detectorOn('duplicates')).toBe(false)
    expect(detectorOn('fanout')).toBe(true)
    expect(detectorKnob('n_plus_one', 'trips')).toBe(100)
  })

  it('near-timeout uses the share in force', () => {
    const r = { latencyMs: 0, maxStmtMs: 11_000, timeouts: 0, status: 200 }
    const B = { db: 15_000, proxy: 60_000 }
    expect(judgeRequest(r, B)).toEqual([]) // 73% < 80%
    setDetectorSettingsForTest({ near_timeout: { share_pct: 70 } })
    expect(judgeRequest(r, B).map((h) => h.budget)).toEqual(['db'])
  })
})

import { describe, expect, it } from 'vitest'
import { TUNING_DEFAULTS, validateTuningSettings } from '../../../../services/db-tuning/settings.js'

describe('validateTuningSettings', () => {
  it('fills defaults from an empty object', () => {
    expect(validateTuningSettings({})).toEqual(TUNING_DEFAULTS)
  })
  it('refuses a watch window outside 1..30 days', () => {
    expect(() => validateTuningSettings({ watch_days: 0 })).toThrow(/watch_days/)
    expect(() => validateTuningSettings({ watch_days: 31 })).toThrow(/watch_days/)
  })
  it('refuses regression_pct outside 5..100 and timeout outside 1..30', () => {
    expect(() => validateTuningSettings({ regression_pct: 4 })).toThrow(/regression_pct/)
    expect(() => validateTuningSettings({ proc_timeout_minutes: 31 })).toThrow(
      /proc_timeout_minutes/
    )
  })
  it('keeps the floor at zero or above and coerces booleans', () => {
    const s = validateTuningSettings({ enabled: 1, ai_rewrites: 0, min_estimate_ms_per_day: 0 })
    expect(s.enabled).toBe(true)
    expect(s.ai_rewrites).toBe(false)
    expect(s.min_estimate_ms_per_day).toBe(0)
    expect(() => validateTuningSettings({ min_estimate_ms_per_day: -1 })).toThrow(/min_estimate/)
  })
})

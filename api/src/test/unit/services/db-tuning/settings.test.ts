import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bustTuningSettings,
  readTuningSettings,
  TUNING_DEFAULTS,
  validateTuningSettings
} from '../../../../services/db-tuning/settings.js'

const m = vi.hoisted(() => ({
  tenant: undefined as string | undefined,
  stored: {} as Record<string, string>
}))

vi.mock('../../../../db/tenant-context.js', () => ({ getTenantId: () => m.tenant }))
vi.mock('../../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../../../../services/settings-overrides.js', () => ({
  overlaySettings: async (row: unknown) => row
}))
vi.mock('../../../../db/index.js', () => {
  // each tenant's request reads its own database (the tenant ALS), keyed here by m.tenant
  const chain = {
    where: () => chain,
    first: async () => ({ db_tuning: m.stored[m.tenant ?? ''] ?? null })
  }
  return { db: Object.assign(() => chain, { raw: async () => [] }) }
})

describe('readTuningSettings', () => {
  beforeEach(() => {
    bustTuningSettings()
    m.tenant = undefined
    m.stored = {}
  })
  it("caches per tenant: one tenant never reads another tenant's settings", async () => {
    m.stored = {
      a: JSON.stringify({ enabled: true, watch_days: 3 }),
      b: JSON.stringify({ enabled: false })
    }
    m.tenant = 'a'
    expect(await readTuningSettings()).toMatchObject({ enabled: true, watch_days: 3 })
    m.tenant = 'b'
    expect(await readTuningSettings()).toMatchObject({ enabled: false, watch_days: 7 })
    m.tenant = 'a'
    m.stored.a = JSON.stringify({ enabled: false })
    // a's value is still cached for a
    expect((await readTuningSettings()).enabled).toBe(true)
  })
  it('self-hosted (no tenant) is one key', async () => {
    m.stored = { '': JSON.stringify({ watch_days: 5 }) }
    expect((await readTuningSettings()).watch_days).toBe(5)
    m.stored = { '': JSON.stringify({ watch_days: 9 }) }
    expect((await readTuningSettings()).watch_days).toBe(5)
    bustTuningSettings()
    expect((await readTuningSettings()).watch_days).toBe(9)
  })
})

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../job-runs.js', () => ({
  startJobRun: vi.fn().mockResolvedValue({
    id: 7,
    progress: vi.fn(),
    log: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined)
  })
}))

import { _resetDrillForTests, setDrillHooks } from './drill.js'
import './faults/index.js'
import {
  inMonkeyHours,
  looksLikeProduction,
  monkeyVerdict,
  tickMonkey,
  ticksLeftThisWeek,
  weekStart
} from './monkey.js'
import { _resetRegistryForTests, armedFaults } from './registry.js'
import { _setRunStoreForTests, listRuns } from './runs.js'
import { _setChaosSettingsForTests, MONKEY_DEFAULTS, normalizeChaosSettings } from './settings.js'

// Wednesday 2026-10-21 14:00 EDT = 18:00 UTC; Saturday 2026-10-24 14:00 EDT.
const WED_2PM = new Date('2026-10-21T18:00:00Z')
const WED_8PM = new Date('2026-10-22T00:00:00Z')
const SAT_2PM = new Date('2026-10-24T18:00:00Z')
const on = { ...MONKEY_DEFAULTS, enabled: true, faults: ['slow_requests'] }
const base = {
  settings: on,
  now: WED_2PM,
  thisWeek: 0,
  gateRefusal: null,
  production: false,
  armed: 0
}

describe('monkey time (#2829)', () => {
  it('knows its hours in Eastern time', () => {
    expect(inMonkeyHours(on.hours, WED_2PM)).toBe(true)
    expect(inMonkeyHours(on.hours, WED_8PM)).toBe(false)
    expect(inMonkeyHours(on.hours, SAT_2PM)).toBe(false)
  })

  it('counts the ticks left this week and the week start', () => {
    // Wed 14:00–16:00 = 8 ticks, Thu + Fri 24 each.
    expect(ticksLeftThisWeek(on.hours, WED_2PM)).toBe(8 + 24 + 24)
    expect(ticksLeftThisWeek(on.hours, SAT_2PM)).toBe(0)
    expect(weekStart(WED_2PM, 'America/New_York').toISOString()).toBe('2026-10-19T04:00:00.000Z')
  })
})

describe('monkey eligibility (#2829)', () => {
  it('rolls only when on, allowed, in hours, under the cap and alone', () => {
    const ok = monkeyVerdict(base)
    expect(ok.ok).toBe(true)
    expect(ok.chance).toBeCloseTo(3 / 56)
    expect(monkeyVerdict({ ...base, settings: { ...on, enabled: false } }).why).toMatch(/off/)
    expect(monkeyVerdict({ ...base, gateRefusal: 'cloud' }).why).toBe('cloud')
    expect(monkeyVerdict({ ...base, production: true }).why).toMatch(/production/)
    expect(monkeyVerdict({ ...base, settings: { ...on, faults: [] } }).why).toMatch(/No faults/)
    expect(monkeyVerdict({ ...base, now: SAT_2PM }).why).toMatch(/Outside/)
    expect(monkeyVerdict({ ...base, thisWeek: 3 }).why).toMatch(/max 3/)
    expect(monkeyVerdict({ ...base, armed: 1 }).why).toMatch(/Another drill/)
  })

  it('treats production-looking instances as production', () => {
    expect(looksLikeProduction('production', {})).toBe(true)
    expect(looksLikeProduction('efp-prod', {})).toBe(true)
    expect(looksLikeProduction('staging', {})).toBe(false)
    expect(looksLikeProduction('development', {})).toBe(false)
    expect(looksLikeProduction('staging', { NIVARO_TIER: 'production' })).toBe(true)
  })
})

describe('monkey tick (#2829)', () => {
  beforeEach(() => {
    delete process.env.CLOUD_META_DB_URL
    process.env.NODE_ENV = 'test'
    _setRunStoreForTests('memory')
  })
  afterEach(async () => {
    await _resetRegistryForTests()
    _resetDrillForTests()
    _setRunStoreForTests(null)
    _setChaosSettingsForTests(null)
  })

  it('starts one small, short monkey run when the dice say so', async () => {
    _setChaosSettingsForTests(
      normalizeChaosSettings({ monkey: { ...on, max_seconds: 20, max_share_pct: 5 } })
    )
    const r = await tickMonkey(null, { now: WED_2PM, rng: () => 0 })
    expect(r.acted).toBe(true)
    const [f] = armedFaults()
    expect(f.fault_key).toBe('slow_requests')
    expect(f.target).toEqual({ kind: 'share', share_pct: 5 })
    expect(Math.round((f.ends_at - f.started_at) / 1000)).toBe(20)
    const [run] = await listRuns({ kind: 'monkey' })
    expect(run).toMatchObject({ id: r.run_id, kind: 'monkey', status: 'running' })
    expect(run.hypothesis.length).toBeGreaterThan(0)
    // Another drill is armed now: the next tick refuses.
    expect((await tickMonkey(null, { now: WED_2PM, rng: () => 0 })).why).toMatch(/Another drill/)
  })

  it('does nothing outside the hours, and records a pre-flight refusal as a refused run', async () => {
    _setChaosSettingsForTests(normalizeChaosSettings({ monkey: on }))
    expect(await tickMonkey(null, { now: SAT_2PM, rng: () => 0 })).toMatchObject({ acted: false })
    expect(armedFaults()).toEqual([])

    setDrillHooks({
      preflight: async () => ({
        ok: false,
        checks: [{ key: 'maintenance', ok: false, why: 'A maintenance window is on' }]
      })
    })
    const r = await tickMonkey(null, { now: WED_2PM, rng: () => 0 })
    expect(r.acted).toBe(false)
    expect(r.why).toMatch(/Pre-flight/)
    expect(armedFaults()).toEqual([])
    const [run] = await listRuns({ kind: 'monkey' })
    expect(run.status).toBe('refused')
  })

  it('a refused run does not count toward the weekly cap', async () => {
    _setChaosSettingsForTests(normalizeChaosSettings({ monkey: { ...on, max_per_week: 1 } }))
    setDrillHooks({ preflight: async () => ({ ok: false, checks: [] }) })
    await tickMonkey(null, { now: WED_2PM, rng: () => 0 })
    _resetDrillForTests()
    const r = await tickMonkey(null, { now: WED_2PM, rng: () => 0 })
    expect(r.acted).toBe(true)
    await _resetRegistryForTests()
    expect((await tickMonkey(null, { now: WED_2PM, rng: () => 0 })).why).toMatch(/max 1/)
  })
})

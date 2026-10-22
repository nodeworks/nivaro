import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetPreflightForTests,
  insideWorkingHours,
  type PreflightDeps,
  registerPreflightCheck,
  runPreflight
} from './preflight.js'

const healthy = (): PreflightDeps => ({
  productionTier: async () => null,
  mixedVersions: async () => ['0.3.0'],
  migrationLocked: async () => false,
  maintenance: async () => ({ on: false, until: null }),
  openIncident: async () => null,
  poolHealth: async () => ({ wait_p95_ms: 12, saturated_pct: 0 }),
  loopLagMs: async () => 20,
  armedCount: () => 0
})

// A Tuesday 10:30 Eastern (14:30 UTC in October).
const TUESDAY = new Date('2026-10-20T14:30:00Z')
// A Saturday noon Eastern.
const SATURDAY = new Date('2026-10-24T16:00:00Z')
// A Tuesday 23:00 Eastern.
const LATE = new Date('2026-10-21T03:00:00Z')

beforeEach(() => _resetPreflightForTests())
afterEach(() => _resetPreflightForTests())

describe('insideWorkingHours', () => {
  it('is Mon–Fri 08:00–18:00 Eastern', () => {
    expect(insideWorkingHours(TUESDAY)).toBe(true)
    expect(insideWorkingHours(SATURDAY)).toBe(false)
    expect(insideWorkingHours(LATE)).toBe(false)
    expect(insideWorkingHours(new Date('2026-10-20T12:00:00Z'))).toBe(true) // 08:00 ET
    expect(insideWorkingHours(new Date('2026-10-20T22:00:00Z'))).toBe(false) // 18:00 ET
  })
})

describe('runPreflight', () => {
  it('passes every built-in on a healthy dev instance in working hours', async () => {
    const r = await runPreflight({ env: { NODE_ENV: 'development' }, now: TUESDAY }, healthy())
    expect(r.ok).toBe(true)
    expect(r.checks.map((c) => c.key)).toEqual([
      'gate',
      'tier',
      'deploy',
      'maintenance',
      'incident',
      'working_hours',
      'health',
      'armed'
    ])
    expect(r.checks.every((c) => c.ok)).toBe(true)
  })

  it('names why each check failed', async () => {
    const deps: PreflightDeps = {
      productionTier: async () => 'Production',
      mixedVersions: async () => ['0.3.0', '0.3.1'],
      migrationLocked: async () => true,
      maintenance: async () => ({ on: true, until: '2026-10-20T20:00:00Z' }),
      openIncident: async () => 'Database slow',
      poolHealth: async () => ({ wait_p95_ms: 3000, saturated_pct: 80 }),
      loopLagMs: async () => 20,
      armedCount: () => 2
    }
    const r = await runPreflight({ env: { CLOUD_META_DB_URL: 'x' }, now: SATURDAY }, deps)
    expect(r.ok).toBe(false)
    const why = Object.fromEntries(r.checks.map((c) => [c.key, c.why]))
    expect(why.gate).toMatch(/cloud/)
    expect(why.tier).toMatch(/Production/)
    expect(why.deploy).toMatch(/two API versions/)
    expect(why.maintenance).toMatch(/maintenance is on until/)
    expect(why.incident).toMatch(/Database slow/)
    expect(why.working_hours).toMatch(/outside working hours/)
    expect(why.health).toMatch(/saturated 80%/)
    expect(why.armed).toMatch(/2 faults are armed/)
  })

  it('lets an admin override working hours only, and records it', async () => {
    const r1 = await runPreflight({ env: { NODE_ENV: 'test' }, now: LATE }, healthy())
    expect(r1.ok).toBe(false)
    expect(r1.checks.find((c) => c.key === 'working_hours')).toMatchObject({
      ok: false,
      overridable: true
    })
    const r2 = await runPreflight(
      { env: { NODE_ENV: 'test' }, now: LATE, override: { working_hours: true } },
      healthy()
    )
    expect(r2.ok).toBe(true)
    expect(r2.overridden).toEqual(['working_hours'])
    expect(r2.checks.find((c) => c.key === 'working_hours')?.why).toMatch(/overridden/)
    // Another failing check is never overridable.
    const deps = healthy()
    deps.armedCount = () => 1
    const r3 = await runPreflight(
      { env: { NODE_ENV: 'test' }, now: TUESDAY, override: { working_hours: true } },
      deps
    )
    expect(r3.ok).toBe(false)
  })

  it('runs checks other areas register and survives a throwing one', async () => {
    registerPreflightCheck({ key: 'custom', label: 'Custom', run: () => 'nope' })
    registerPreflightCheck({
      key: 'boom',
      label: 'Boom',
      run: () => {
        throw new Error('kaput')
      }
    })
    const r = await runPreflight({ env: { NODE_ENV: 'test' }, now: TUESDAY }, healthy())
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.key === 'custom')?.why).toBe('nope')
    expect(r.checks.find((c) => c.key === 'boom')?.why).toMatch(/kaput/)
  })
})

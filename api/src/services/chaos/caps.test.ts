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

import { applyCaps } from './caps.js'
import { type FaultDefinition, getFault } from './catalog.js'
import { _resetDrillForTests, startDrill } from './drill.js'
import './faults/index.js'
import { _resetRegistryForTests, armedFaults, CHAOS_NODE, chaosPoint } from './registry.js'
import { _setRunStoreForTests } from './runs.js'
import {
  _setChaosSettingsForTests,
  CHAOS_SETTINGS_DEFAULTS,
  capsFor,
  mergeChaosPatch,
  NO_CAPS,
  normalizeChaosSettings
} from './settings.js'

const def: FaultDefinition = {
  key: 'test_slow',
  label: 'Test slow',
  proves: 'p',
  claim_keys: [],
  targets: ['all', 'share', 'route', 'node'],
  params: {
    delay_ms: { type: 'number', label: 'Delay', min: 100, max: 5000, default: 1500, unit: 'ms' }
  },
  max_seconds: 300,
  default_seconds: 30,
  points: ['http.request']
}

describe('applyCaps (#2862)', () => {
  it('passes everything through with no caps', () => {
    const r = applyCaps(
      def,
      { target: { kind: 'all' }, params: { delay_ms: 4000 }, seconds: 200 },
      NO_CAPS
    )
    expect(r).toEqual({
      target: { kind: 'all' },
      params: { delay_ms: 4000 },
      seconds: 200,
      applied: []
    })
  })

  it('clamps share, latency and seconds, naming each cap', () => {
    const caps = { ...NO_CAPS, max_share_pct: 10, max_latency_ms: 2000, max_seconds: 60 }
    const r = applyCaps(
      def,
      { target: { kind: 'share', share_pct: 50 }, params: { delay_ms: 4000 }, seconds: 200 },
      caps
    )
    expect(r.target).toEqual({ kind: 'share', share_pct: 10 })
    expect(r.params.delay_ms).toBe(2000)
    expect(r.seconds).toBe(60)
    expect(r.applied.join(' | ')).toMatch(/max_share_pct.*max_latency_ms.*max_seconds/)
  })

  it('turns "everything" into the capped share when the fault can target a share', () => {
    const r = applyCaps(def, { target: { kind: 'all' } }, { ...NO_CAPS, max_share_pct: 5 })
    expect(r.target).toEqual({ kind: 'share', share_pct: 5 })
  })

  it('samples every non-share target at the share cap, on top of its match', () => {
    const caps = { ...NO_CAPS, max_share_pct: 5 }
    const r = applyCaps(def, { target: { kind: 'route', pattern: '/api/items/*' } }, caps)
    expect(r.target).toEqual({ kind: 'route', pattern: '/api/items/*', sample_pct: 5 })
    expect(r.applied.join()).toMatch(/route target sampled at 5%/)
    const node = applyCaps(def, { target: { kind: 'node', node: 'n1' } }, caps)
    expect(node.target).toEqual({ kind: 'node', node: 'n1', sample_pct: 5 })
    // A fault that cannot take a share is sampled when aimed at everything.
    const noShare = { ...def, targets: ['all' as const] }
    expect(applyCaps(noShare, { target: { kind: 'all' } }, caps).target).toEqual({
      kind: 'all',
      sample_pct: 5
    })
  })

  it('refuses route patterns that reach almost everything under a share cap', () => {
    const caps = { ...NO_CAPS, max_share_pct: 10 }
    for (const pattern of ['/*', '/api/*', '/api', '/api/:id/*'])
      expect(() => applyCaps(def, { target: { kind: 'route', pattern } }, caps)).toThrow(
        /two fixed path segments/
      )
    // Without a cap the pattern is the operator's call.
    expect(
      applyCaps(def, { target: { kind: 'route', pattern: '/api/*' } }, NO_CAPS).target
    ).toEqual({ kind: 'route', pattern: '/api/*' })
  })

  it('refuses a fault off the allowlist', () => {
    expect(() => applyCaps(def, {}, { ...NO_CAPS, allowed_faults: ['other'] })).toThrow(
      /allowed_faults/
    )
    try {
      applyCaps(def, {}, { ...NO_CAPS, allowed_faults: [] })
    } catch (e) {
      expect((e as { statusCode: number; code: string }).statusCode).toBe(403)
      expect((e as { code: string }).code).toBe('CHAOS_CAP')
    }
  })

  it('narrows to one replica, or refuses when the fault cannot target one', () => {
    const caps = { ...NO_CAPS, max_replicas: 1 }
    const r = applyCaps(def, { target: { kind: 'all' } }, caps, { nodes: 3, node: 'n1' })
    expect(r.target).toEqual({ kind: 'node', node: 'n1' })
    const noNode = { ...def, targets: ['all' as const] }
    expect(() => applyCaps(noNode, { target: { kind: 'all' } }, caps, { nodes: 3 })).toThrow(
      /max_replicas/
    )
    // A single replica is within any replica cap.
    expect(applyCaps(noNode, { target: { kind: 'all' } }, caps, { nodes: 1 }).target).toEqual({
      kind: 'all'
    })
  })

  it('refuses a latency cap under the fault minimum instead of exceeding it', () => {
    expect(() =>
      applyCaps(def, { params: { delay_ms: 500 } }, { ...NO_CAPS, max_latency_ms: 50 })
    ).toThrow(/max_latency_ms/)
  })
})

describe('chaos settings (#2862)', () => {
  it('normalizes junk to defaults and picks this instance, else default', () => {
    expect(normalizeChaosSettings('nope')).toEqual(CHAOS_SETTINGS_DEFAULTS)
    const s = normalizeChaosSettings({
      operator_roles: ['A0000000-0000-0000-0000-000000000001', 'bad'],
      environments: {
        default: { max_seconds: 30 },
        staging: { allowed_faults: ['slow_requests'], max_share_pct: 10 }
      }
    })
    expect(s.operator_roles).toEqual(['a0000000-0000-0000-0000-000000000001'])
    expect(capsFor(s, 'staging')).toMatchObject({
      allowed_faults: ['slow_requests'],
      max_share_pct: 10
    })
    expect(capsFor(s, 'development')).toMatchObject({ allowed_faults: '*', max_seconds: 30 })
    expect(capsFor(CHAOS_SETTINGS_DEFAULTS, 'x')).toEqual(NO_CAPS)
  })

  it('names every bad field on a patch and keeps what was not sent', () => {
    expect(() =>
      mergeChaosPatch(CHAOS_SETTINGS_DEFAULTS, {
        operator_roles: 'admins',
        environments: { staging: { max_share_pct: 400 } },
        monkey: { hours: { start: '25:00' } },
        nonsense: 1
      })
    ).toThrow(/unknown key nonsense.*operator_roles.*max_share_pct.*hours.start/)
    const next = mergeChaosPatch(CHAOS_SETTINGS_DEFAULTS, {
      environments: { staging: { max_share_pct: 10 } },
      monkey: { enabled: true, faults: ['slow_requests'], hours: { start: '09:00' } }
    })
    expect(next.environments.staging.max_share_pct).toBe(10)
    expect(next.monkey).toMatchObject({ enabled: true, faults: ['slow_requests'], max_per_week: 3 })
    expect(next.monkey.hours).toMatchObject({
      start: '09:00',
      end: '16:00',
      tz: 'America/New_York'
    })
    // null removes an environment.
    expect(mergeChaosPatch(next, { environments: { staging: null } }).environments).toEqual({})
  })
})

describe('caps in the run start path (#2862)', () => {
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

  it('clamps whatever the caller sends and records the clamp on the run', async () => {
    _setChaosSettingsForTests(
      normalizeChaosSettings({
        environments: { default: { max_share_pct: 10, max_latency_ms: 1000, max_seconds: 20 } }
      })
    )
    expect(getFault('slow_requests')).not.toBeNull()
    const { run, fault } = await startDrill({
      fault_key: 'slow_requests',
      target: { kind: 'all' },
      params: { delay_ms: 5000 },
      seconds: 300,
      by: { id: null, name: 'test' }
    })
    expect(fault.target).toEqual({ kind: 'share', share_pct: 10 })
    expect(fault.params.delay_ms).toBe(1000)
    expect(Math.round((fault.ends_at - fault.started_at) / 1000)).toBe(20)
    expect((run.meta.caps as string[]).length).toBe(3)
  })

  it('a wide route under a share cap reaches only the capped share of calls', async () => {
    _setChaosSettingsForTests(
      normalizeChaosSettings({ environments: { default: { max_share_pct: 10 } } })
    )
    const { fault, run } = await startDrill({
      fault_key: 'slow_requests',
      target: { kind: 'route', pattern: '/api/items/*' },
      by: { id: null, name: 'test' }
    })
    expect(fault.target).toMatchObject({ kind: 'route', sample_pct: 10 })
    expect(run.params.sample_pct).toBe(10)
    let hit = 0
    for (let i = 0; i < 2000; i++)
      if (chaosPoint('http.request', { route: '/api/items/x', key: `r${i}` })) hit++
    expect(hit).toBeGreaterThan(100)
    expect(hit).toBeLessThan(320)
    expect(chaosPoint('http.request', { route: '/api/users/x', key: 'r1' })).toBeNull()
  })

  it('refuses a fault this environment does not allow, arming nothing', async () => {
    _setChaosSettingsForTests(
      normalizeChaosSettings({ environments: { default: { allowed_faults: ['mail_down'] } } })
    )
    await expect(
      startDrill({ fault_key: 'slow_requests', by: { id: null, name: 'test' } })
    ).rejects.toMatchObject({ statusCode: 403, code: 'CHAOS_CAP' })
    expect(armedFaults()).toEqual([])
    expect(CHAOS_NODE).toBeTruthy()
  })
})

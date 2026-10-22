import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetCatalogForTests, registerFault } from './catalog.js'
import {
  _resetRecoveryForTests,
  type RecoveryIo,
  recoveryTargets,
  watchRecovery,
  wireRecoveryWatch
} from './recovery.js'
import { _resetRegistryForTests, armFault, disarm, stopAll } from './registry.js'
import type { ChaosRun } from './runs.js'

const saved = { ...process.env }

function run(over: Partial<ChaosRun> = {}): ChaosRun {
  return {
    id: 'run-1',
    kind: 'drill',
    status: 'completed',
    fault_key: 'slow',
    label: 'Slow',
    target: { kind: 'all' },
    params: {},
    hypothesis: [{ sampler: 'http.p95_ms', op: '<', limit: 800 }],
    verdict: 'broke',
    verdict_detail: null,
    baseline: { samplers: { 'http.p95_ms': { value: 200 } } },
    started_by: null,
    started_at: null,
    ends_at: null,
    ended_at: null,
    preset_id: null,
    gameday_id: null,
    meta: {},
    created_at: new Date().toISOString(),
    ...over
  }
}

function fakeIo(values: number[], r: ChaosRun | null = run()) {
  const events: Array<Record<string, unknown>> = []
  let i = 0
  const io: RecoveryIo = {
    getRun: async () => r,
    sample: async () => ({ 'http.p95_ms': values[Math.min(i++, values.length - 1)] }),
    event: async (_id, data) => {
      events.push(data)
    }
  }
  return { io, events, sampled: () => i }
}

const fast = { intervalMs: 1, settleMs: 1, maxMs: 200 }

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _resetCatalogForTests()
  registerFault({
    key: 'slow',
    label: 'Slow',
    proves: 'x',
    claim_keys: [],
    targets: ['all'],
    params: {},
    max_seconds: 60,
    points: ['http.request']
  })
})

afterEach(async () => {
  _resetRecoveryForTests()
  await _resetRegistryForTests()
  process.env = { ...saved }
})

describe('recovery watch', () => {
  it('judges only hypothesis samplers that have a baseline', () => {
    expect(recoveryTargets(run()).map((t) => t.key)).toEqual(['http.p95_ms'])
    expect(recoveryTargets(run({ baseline: null }))).toEqual([])
  })

  it('samples after the fault until two samples in a row are back in the baseline', async () => {
    const { io, events } = fakeIo([900, 600, 230, 210, 205])
    expect(await watchRecovery('run-1', { ...fast, io })).toBe('recovered')
    expect(events.map((e) => (e.s as Record<string, number>)['http.p95_ms'])).toEqual([
      900, 600, 230, 210
    ])
    expect(events.every((e) => e.phase === 'after')).toBe(true)
  })

  it('gives up at the time cap, and skips runs it cannot judge', async () => {
    const { io } = fakeIo([900])
    expect(await watchRecovery('run-1', { ...fast, maxMs: 20, io })).toBe('timeout')
    const none = fakeIo([900], run({ hypothesis: [] }))
    expect(await watchRecovery('run-2', { ...fast, io: none.io })).toBe('skipped')
    expect(none.sampled()).toBe(0)
  })

  it('does nothing while nothing ends, and starts when a fault armed here ends', async () => {
    const { io, sampled } = fakeIo([210, 205])
    wireRecoveryWatch({ ...fast, io })
    const f = await armFault({ fault_key: 'slow', seconds: 30, run_id: 'run-1' })
    await new Promise((r) => setTimeout(r, 20))
    expect(sampled()).toBe(0)
    await disarm(f.id, 'test')
    await new Promise((r) => setTimeout(r, 40))
    expect(sampled()).toBeGreaterThanOrEqual(2)
  })

  it('starts on Stop all too, once per run', async () => {
    const { io, sampled } = fakeIo([210, 205])
    wireRecoveryWatch({ ...fast, io })
    await armFault({ fault_key: 'slow', seconds: 30, run_id: 'run-1' })
    await stopAll('test')
    await new Promise((r) => setTimeout(r, 40))
    expect(sampled()).toBe(2)
  })
})

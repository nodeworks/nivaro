import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerFault } from './catalog.js'
import {
  _resetMonitorsForTests,
  _setMonitorDepsForTests,
  type ReadinessSnapshot,
  summarizeReadiness,
  wireRunMonitors
} from './monitors.js'
import { _resetRegistryForTests, armFault, stopAll } from './registry.js'

const saved = { ...process.env }
const events: Array<{ runId: string; kind: string; data: Record<string, unknown> }> = []
let snaps: ReadinessSnapshot[] = []

const snap = (score: number, failing: string[] = []): ReadinessSnapshot => ({
  score,
  counts: { pass: 1, fail: failing.length },
  failing,
  warning: []
})

beforeEach(() => {
  vi.useFakeTimers()
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  registerFault({
    key: 'mon_test',
    label: 'Monitor test',
    proves: 'x',
    claim_keys: [],
    targets: ['all'],
    params: {},
    max_seconds: 300,
    points: ['test.point']
  })
  events.length = 0
  snaps = []
  _resetMonitorsForTests()
  _setMonitorDepsForTests({
    snapshot: async () => snaps.shift() ?? snap(100),
    addEvent: async (runId, kind, data) => {
      events.push({ runId, kind, data })
    }
  })
  wireRunMonitors()
})

afterEach(async () => {
  _resetMonitorsForTests()
  await _resetRegistryForTests()
  vi.useRealTimers()
  process.env = { ...saved }
})

describe('summarizeReadiness', () => {
  it('keeps the score, counts and failing / warning ids', () => {
    expect(
      summarizeReadiness({
        score: 80,
        counts: { pass: 1, fail: 1, warn: 1, error: 1 },
        checks: [
          { id: 'a', status: 'pass' },
          { id: 'b', status: 'fail' },
          { id: 'c', status: 'warn' },
          { id: 'd', status: 'error' }
        ]
      })
    ).toEqual({
      score: 80,
      counts: { pass: 1, fail: 1, warn: 1, error: 1 },
      failing: ['b', 'd'],
      warning: ['c']
    })
  })
})

describe('run monitors', () => {
  it('records nothing for a fault without a run', async () => {
    await armFault({ fault_key: 'mon_test' })
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual([])
  })

  it('takes readiness at arm, midpoint and end, naming what changed', async () => {
    snaps = [snap(100), snap(70, ['db.reachable']), snap(100)]
    await armFault({ fault_key: 'mon_test', run_id: 'r1', seconds: 60 })
    await vi.advanceTimersByTimeAsync(0)
    expect(events[0]).toMatchObject({ runId: 'r1', kind: 'readiness', data: { phase: 'arm' } })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(events[1].data).toMatchObject({
      phase: 'mid',
      score: 70,
      newly_failing: ['db.reachable'],
      changed: true
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(events[2].data).toMatchObject({ phase: 'end', score: 100, changed: false })
    expect(events).toHaveLength(3)
  })

  it('ends on Stop all without a midpoint', async () => {
    await armFault({ fault_key: 'mon_test', run_id: 'r2', seconds: 60 })
    await vi.advanceTimersByTimeAsync(0)
    await stopAll('test')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events.map((e) => e.data.phase)).toEqual(['arm', 'end'])
  })

  it('notes an unavailable scorecard instead of failing', async () => {
    _setMonitorDepsForTests({
      snapshot: () => new Promise(() => {}),
      addEvent: async (runId, kind, data) => {
        events.push({ runId, kind, data })
      }
    })
    await armFault({ fault_key: 'mon_test', run_id: 'r4', seconds: 10 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events[0].data).toMatchObject({ phase: 'arm', unavailable: true })
  })
})

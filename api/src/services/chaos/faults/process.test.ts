import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getFault, validateParams } from '../catalog.js'
import { appNow, clockSkewMs, MAX_SKEW_MS, setClockSkew } from '../clock.js'
import { _resetRegistryForTests, armFault, CHAOS_NODE, stopAll } from '../registry.js'
import './clock.js'
import {
  _resetProcessFaultsForTests,
  _setHeapProbeForTests,
  busyWait,
  growStep,
  MAX_BLOCK_MS,
  memoryPressureBytes
} from './process.js'

const saved = { ...process.env }
const MB = 1024 * 1024

beforeEach(() => {
  vi.useFakeTimers()
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _resetProcessFaultsForTests()
})

afterEach(async () => {
  await _resetRegistryForTests()
  setClockSkew(0)
  vi.useRealTimers()
  process.env = { ...saved }
})

describe('event_loop_block', () => {
  it('caps a block at 2 s whatever is asked', () => {
    expect(validateParams(getFault('event_loop_block')!, { block_ms: 60_000 }).block_ms).toBe(
      MAX_BLOCK_MS
    )
    vi.useRealTimers()
    const spent = busyWait(5)
    expect(spent).toBeGreaterThanOrEqual(5)
    expect(spent).toBeLessThan(200)
  })

  it('blocks every M seconds while armed and stops on Stop all', async () => {
    const perf = vi.spyOn(performance, 'now')
    let t = 0
    let spins = 0
    perf.mockImplementation(() => {
      spins++
      t += 50
      return t
    })
    await armFault({ fault_key: 'event_loop_block', params: { block_ms: 100, every_s: 2 } })
    expect(spins).toBe(0)
    vi.advanceTimersByTime(2000)
    const afterOne = spins
    expect(afterOne).toBeGreaterThan(0)
    await stopAll('test')
    vi.advanceTimersByTime(10_000)
    expect(spins).toBe(afterOne)
    perf.mockRestore()
  })

  it('does nothing on another replica', async () => {
    const perf = vi.spyOn(performance, 'now')
    await armFault({
      fault_key: 'event_loop_block',
      target: { kind: 'node', node: 'other·x' },
      params: { every_s: 1 }
    })
    vi.advanceTimersByTime(5000)
    expect(perf).not.toHaveBeenCalled()
    perf.mockRestore()
  })
})

describe('memory_pressure', () => {
  it('grows toward the target share of the heap limit and never past 75%', () => {
    let used = 100 * MB
    _setHeapProbeForTests({ limit: () => 1000 * MB, used: () => used })
    const state = { chunks: [] as number[][], bytes: 0 }
    expect(growStep(state, 4 * MB, 60)).toBe(true)
    expect(state.bytes).toBe(4 * MB)
    used = 598 * MB
    expect(growStep(state, 4 * MB, 60)).toBe(false)
    used = 100 * MB
    // A target above the hard cap is held to 75%.
    state.bytes = 748 * MB
    expect(growStep(state, 4 * MB, 99)).toBe(false)
  })

  it('retains memory while armed and drops it at the window end', async () => {
    _setHeapProbeForTests({ limit: () => 1000 * MB, used: () => 100 * MB })
    await armFault({
      fault_key: 'memory_pressure',
      params: { step_mb: 4, step_s: 1, target_pct: 60 },
      seconds: 10
    })
    expect(memoryPressureBytes()).toBe(4 * MB)
    await vi.advanceTimersByTimeAsync(2000)
    expect(memoryPressureBytes()).toBe(12 * MB)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(memoryPressureBytes()).toBe(0)
  })
})

describe('clock_skew', () => {
  it('leaves the application clock alone while unarmed', () => {
    expect(clockSkewMs()).toBe(0)
    expect(appNow()).toBe(Date.now())
  })

  it('moves only the targeted replica and puts it back at the window end', async () => {
    await armFault({
      fault_key: 'clock_skew',
      target: { kind: 'node', node: 'other·x' },
      params: { offset_minutes: 30 }
    })
    expect(clockSkewMs()).toBe(0)
    await armFault({
      fault_key: 'clock_skew',
      target: { kind: 'node', node: CHAOS_NODE },
      params: { offset_minutes: -15 },
      seconds: 20
    })
    expect(appNow() - Date.now()).toBe(-15 * 60_000)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(clockSkewMs()).toBe(0)
  })

  it('caps the skew at a day and clears on Stop all', async () => {
    expect(validateParams(getFault('clock_skew')!, { offset_minutes: 99_999 }).offset_minutes).toBe(
      1440
    )
    setClockSkew(10 * MAX_SKEW_MS)
    expect(clockSkewMs()).toBe(MAX_SKEW_MS)
    setClockSkew(0)
    await armFault({
      fault_key: 'clock_skew',
      target: { kind: 'node', node: CHAOS_NODE },
      params: { offset_minutes: 120 }
    })
    expect(clockSkewMs()).toBe(120 * 60_000)
    await stopAll('test')
    expect(clockSkewMs()).toBe(0)
  })
})

describe('appNowForAuth (F3)', () => {
  it('ignores a clock set back and follows a clock set forward', async () => {
    const { appNowForAuth } = await import('../clock.js')
    setClockSkew(-24 * 3_600_000)
    expect(appNowForAuth()).toBe(Date.now())
    expect(appNow()).toBe(Date.now() - 24 * 3_600_000)
    setClockSkew(30 * 60_000)
    expect(appNowForAuth()).toBe(Date.now() + 30 * 60_000)
  })

  it('a negative skew drill never revives an expired API key, session or link', async () => {
    const { appNowForAuth } = await import('../clock.js')
    const expiredYesterday = Date.now() - 12 * 3_600_000
    await armFault({
      fault_key: 'clock_skew',
      target: { kind: 'node', node: CHAOS_NODE },
      params: { offset_minutes: -1440 }
    })
    expect(appNow()).toBeLessThan(expiredYesterday)
    expect(expiredYesterday < appNowForAuth()).toBe(true)
  })
})

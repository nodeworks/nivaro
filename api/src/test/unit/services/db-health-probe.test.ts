import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ probeOk: true, poolCalls: 0, probeCalls: 0 }))
vi.mock('../../../db/index.js', () => ({
  // The request pool is full: anything sent through it never answers.
  db: {
    raw: () => {
      state.poolCalls++
      return new Promise(() => {})
    }
  },
  probeDb: () => ({
    raw: async () => {
      state.probeCalls++
      if (!state.probeOk) throw new Error('Failed to connect to db:1433')
      return [{ '': 1 }]
    }
  })
}))

import { dbHealthState, isDbHealthy, startDbHealthProbe } from '../../../services/db-health.js'

describe('db health probe', () => {
  // One probe loop for the whole file: it is a module-level interval.
  beforeAll(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    startDbHealthProbe()
  })
  afterAll(() => vi.useRealTimers())

  it('a full request pool is not an outage: the probe never waits on it', async () => {
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(5000)
    expect(state.poolCalls).toBe(0)
    expect(state.probeCalls).toBeGreaterThanOrEqual(4)
    expect(isDbHealthy()).toBe(true)
  })

  it('a database that really fails trips after three misses and recovers on the first success', async () => {
    state.probeOk = false
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(isDbHealthy()).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(isDbHealthy()).toBe(false)
    expect(dbHealthState().error).toMatch(/Failed to connect/)
    state.probeOk = true
    await vi.advanceTimersByTimeAsync(5000)
    expect(isDbHealthy()).toBe(true)
  })
})

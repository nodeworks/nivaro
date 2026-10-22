import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetSteadyStateForTests,
  evaluateRule,
  httpFigures,
  listSamplers,
  noteChaosRequest,
  registerBuiltInSamplers,
  registerSampler,
  sampleMany,
  startWatch,
  stopWatch,
  takeBaseline,
  verdictFor,
  type WatchIo,
  watchedRuns
} from './steady-state.js'

beforeEach(() => {
  vi.useFakeTimers()
  _resetSteadyStateForTests()
})
afterEach(() => {
  _resetSteadyStateForTests()
  vi.useRealTimers()
})

function fakeIo() {
  const events: Array<Record<string, unknown>> = []
  const aborts: Array<{ runId: string; reason: string; detail: Record<string, unknown> }> = []
  let armed = true
  const io: WatchIo = {
    isArmed: () => armed,
    event: async (_r, data) => {
      events.push(data)
    },
    abort: async (runId, reason, detail) => {
      armed = false
      aborts.push({ runId, reason, detail })
    }
  }
  return { io, events, aborts, disarm: () => (armed = false) }
}

describe('evaluateRule', () => {
  it('tells crossed from past-tolerance for every operator', () => {
    expect(evaluateRule({ sampler: 'x', op: '<', limit: 10, tolerance: 2 }, 9)).toEqual({
      crossed: false,
      past_tolerance: false
    })
    expect(evaluateRule({ sampler: 'x', op: '<', limit: 10, tolerance: 2 }, 11)).toEqual({
      crossed: true,
      past_tolerance: false
    })
    expect(evaluateRule({ sampler: 'x', op: '<', limit: 10, tolerance: 2 }, 13)).toEqual({
      crossed: true,
      past_tolerance: true
    })
    expect(evaluateRule({ sampler: 'x', op: '<=', limit: 10 }, 10)).toEqual({
      crossed: false,
      past_tolerance: false
    })
    expect(evaluateRule({ sampler: 'x', op: '>', limit: 10, tolerance: 1 }, 9.5)).toEqual({
      crossed: true,
      past_tolerance: false
    })
    expect(evaluateRule({ sampler: 'x', op: '>=', limit: 10, tolerance: 1 }, 8)).toEqual({
      crossed: true,
      past_tolerance: true
    })
    expect(evaluateRule({ sampler: 'x', op: '<', limit: 10 }, null)).toEqual({
      crossed: false,
      past_tolerance: false
    })
  })
})

describe('request ring', () => {
  it('computes p95, error share, rate and save failures over a window', () => {
    const now = Date.now()
    for (let i = 0; i < 20; i++)
      noteChaosRequest({
        method: 'GET',
        path: '/api/items/a',
        status: 200,
        latencyMs: 100 + i * 10,
        at: now - i * 1000
      })
    noteChaosRequest({
      method: 'PATCH',
      path: '/api/items/a/1',
      status: 500,
      latencyMs: 900,
      at: now - 500
    })
    noteChaosRequest({
      method: 'GET',
      path: '/api/users',
      status: 503,
      latencyMs: 50,
      at: now - 400
    })
    // Outside the window: ignored.
    noteChaosRequest({
      method: 'GET',
      path: '/api/x',
      status: 500,
      latencyMs: 5000,
      at: now - 120_000
    })
    const f = httpFigures(60, now)
    expect(f.requests).toBe(22)
    expect(f.save_failures).toBe(1)
    expect(f.error_pct).toBeCloseTo(9.09, 1)
    expect(f.p95_ms).toBe(280)
    expect(f.rps).toBeCloseTo(0.37, 1)
    const five = httpFigures(300, now)
    expect(five.requests).toBe(23)
  })

  it('registers the built-in samplers and reads the HTTP ones from the ring', async () => {
    registerBuiltInSamplers()
    const keys = listSamplers().map((s) => s.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'http.p95_ms',
        'http.5xx_pct',
        'pool.main_wait_p95_ms',
        'loop.lag_ms',
        'gate.queue',
        'socket.reconnects',
        'records.save_failures'
      ])
    )
    noteChaosRequest({ method: 'GET', path: '/api/a', status: 500, latencyMs: 300 })
    const v = await sampleMany(['http.5xx_pct', 'http.p95_ms', 'nope'])
    expect(v['http.5xx_pct']).toBe(100)
    expect(v['http.p95_ms']).toBe(300)
    expect(v.nope).toBeNull()
  })
})

describe('watcher', () => {
  it('samples, records breaches and aborts after N consecutive samples past tolerance', async () => {
    let p95 = 100
    registerSampler('t.p95', 'p95', 'ms', () => p95)
    registerSampler('t.flat', 'flat', 'n', () => 1)
    const { io, events, aborts } = fakeIo()
    startWatch('run-1', 'fault-1', [{ sampler: 't.p95', op: '<', limit: 500, tolerance: 100 }], {
      io,
      intervalMs: 1000,
      abortAfter: 3
    })
    await vi.advanceTimersByTimeAsync(10)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ s: { 't.p95': 100 } })
    expect(watchedRuns()).toEqual(['run-1'])

    p95 = 550 // crossed, inside tolerance: recorded, never aborts
    await vi.advanceTimersByTimeAsync(3000)
    expect(aborts).toHaveLength(0)
    expect(events.at(-1)?.breach).toEqual({ sampler: 't.p95', value: 550, op: '<', limit: 500 })

    p95 = 700 // past tolerance: 3 in a row → abort
    await vi.advanceTimersByTimeAsync(2000)
    expect(aborts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(aborts).toHaveLength(1)
    expect(aborts[0].reason).toMatch(/t\.p95 = 700 crossed < 500/)
    expect(aborts[0].detail).toMatchObject({
      breaches: [expect.objectContaining({ sampler: 't.p95', value: 700 })]
    })
    // Stopped: no more samples.
    const n = events.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(events.length).toBe(n)
    expect(verdictFor('run-1', 'aborted')?.verdict).toBe('aborted')
    expect(watchedRuns()).toEqual([])
  })

  it('a single spike past tolerance does not abort, but makes the verdict broke', async () => {
    let v = 0
    registerSampler('t.err', 'errors', '%', () => v)
    const { io, aborts } = fakeIo()
    startWatch('run-2', 'f', [{ sampler: 't.err', op: '<', limit: 1, tolerance: 0.5 }], {
      io,
      intervalMs: 1000
    })
    await vi.advanceTimersByTimeAsync(10)
    v = 9
    await vi.advanceTimersByTimeAsync(1000)
    v = 0
    await vi.advanceTimersByTimeAsync(5000)
    expect(aborts).toHaveLength(0)
    expect(verdictFor('run-2', 'completed')).toMatchObject({
      verdict: 'broke',
      detail: { breach_count: 1 }
    })
  })

  it('holds when nothing crosses, stops itself when the fault is gone, and ignores a second start', async () => {
    registerSampler('t.ok', 'ok', 'n', () => 1)
    const { io, events, disarm } = fakeIo()
    startWatch('run-3', 'f', [{ sampler: 't.ok', op: '>', limit: 0 }], { io, intervalMs: 1000 })
    startWatch('run-3', 'f', [], { io, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(2010)
    expect(events).toHaveLength(3)
    disarm()
    await vi.advanceTimersByTimeAsync(1000)
    const n = events.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(events.length).toBe(n)
    expect(verdictFor('run-3', 'completed')).toMatchObject({ verdict: 'held' })
    expect(verdictFor('run-3', 'completed')).toBeNull()
  })

  it('takes a baseline from the ring and the samplers, and stopWatch is safe to repeat', async () => {
    registerBuiltInSamplers()
    registerSampler('t.c', 'c', 'n', () => 42)
    noteChaosRequest({ method: 'GET', path: '/api/a', status: 200, latencyMs: 120 })
    const b = await takeBaseline(['http.p95_ms', 'http.5xx_pct', 't.c', 'missing'])
    expect(b.samplers['http.p95_ms']).toEqual({ value: 120 })
    expect(b.samplers['http.5xx_pct']).toEqual({ value: 0 })
    expect(b.samplers['t.c']).toEqual({ value: 42 })
    expect(b.samplers.missing).toEqual({ value: null })
    stopWatch('nope')
    stopWatch('nope')
  })
})

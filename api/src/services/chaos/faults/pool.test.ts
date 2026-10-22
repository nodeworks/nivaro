import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getFault, validateParams } from '../catalog.js'
import {
  _resetRegistryForTests,
  armedFaults,
  armFault,
  CHAOS_NODE,
  onRegistryChange,
  stopAll
} from '../registry.js'
import {
  _resetPoolHoldsForTests,
  _setPoolSourceForTests,
  holdCap,
  holdSecondsCap,
  poolHoldStatus
} from './pool.js'

const saved = { ...process.env }

function fakePool(opts: { slow?: boolean } = {}) {
  const out = { acquired: 0, released: 0, pending: [] as Array<(c: unknown) => void> }
  const knex = {
    client: {
      acquireConnection: () =>
        new Promise<unknown>((resolve) => {
          const give = () => {
            out.acquired++
            resolve({ n: out.acquired })
          }
          if (opts.slow) out.pending.push(give)
          else give()
        }),
      releaseConnection: () => {
        out.released++
      }
    }
  }
  return { knex, out }
}

beforeEach(() => {
  vi.useFakeTimers()
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _resetPoolHoldsForTests()
})

afterEach(async () => {
  await _resetRegistryForTests()
  vi.useRealTimers()
  process.env = { ...saved }
})

describe('pool_hold', () => {
  it('holds nothing while unarmed', () => {
    expect(poolHoldStatus()).toEqual({ main: 0, background: 0 })
  })

  it('holds N connections of the chosen pool and gives them back at the window end', async () => {
    const { knex, out } = fakePool()
    const asked: string[] = []
    _setPoolSourceForTests(async (p) => {
      asked.push(p)
      return knex
    })
    await armFault({
      fault_key: 'pool_hold',
      params: { pool: 'background', connections: 3 },
      seconds: 20
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(asked).toEqual(['background'])
    expect(poolHoldStatus()).toEqual({ main: 0, background: 3 })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(out.released).toBe(3)
    expect(poolHoldStatus()).toEqual({ main: 0, background: 0 })
  })

  it('caps connections off production and the hold time at 60 s', async () => {
    expect(holdCap({ NODE_ENV: 'development' })).toBe(5)
    expect(holdCap({ NODE_ENV: 'production' })).toBe(10)
    expect(holdSecondsCap({ NODE_ENV: 'test' })).toBe(60)
    expect(holdSecondsCap({ NODE_ENV: 'production' })).toBeNull()
    expect(validateParams(getFault('pool_hold')!, { connections: 50 }).connections).toBe(10)

    const { knex, out } = fakePool()
    _setPoolSourceForTests(async () => knex)
    await armFault({ fault_key: 'pool_hold', params: { connections: 10 }, seconds: 200 })
    await vi.advanceTimersByTimeAsync(0)
    expect(out.acquired).toBe(5)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(out.released).toBe(5)
    // The fault is still armed (its window is longer) but holds nothing.
    expect(armedFaults()).toHaveLength(1)
    expect(poolHoldStatus().background).toBe(0)
  })

  it('releases on Stop all, and a connection handed over late goes straight back', async () => {
    const { knex, out } = fakePool({ slow: true })
    _setPoolSourceForTests(async () => knex)
    await armFault({ fault_key: 'pool_hold', params: { pool: 'main', connections: 2 } })
    await vi.advanceTimersByTimeAsync(0)
    out.pending.shift()?.(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(poolHoldStatus().main).toBe(1)
    await stopAll('test')
    expect(out.released).toBe(1)
    out.pending.shift()?.(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(out.released).toBe(2)
    expect(poolHoldStatus().main).toBe(0)
  })

  it('reports a missing background pool instead of holding the main one', async () => {
    _setPoolSourceForTests(async () => null)
    const reasons: string[] = []
    onRegistryChange((ev) => {
      if (ev.type === 'disarmed') reasons.push(ev.reason)
    })
    await armFault({ fault_key: 'pool_hold', params: { pool: 'background' } })
    expect(reasons[0]).toMatch(/apply failed: .*DB_POOL_BACKGROUND_MAX/)
  })

  it('holds only on the targeted replica', async () => {
    const { knex, out } = fakePool()
    _setPoolSourceForTests(async () => knex)
    await armFault({ fault_key: 'pool_hold', target: { kind: 'node', node: 'other·x' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(out.acquired).toBe(0)
    await armFault({ fault_key: 'pool_hold', target: { kind: 'node', node: CHAOS_NODE } })
    await vi.advanceTimersByTimeAsync(0)
    expect(out.acquired).toBe(3)
  })
})

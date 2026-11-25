import { EventEmitter } from 'node:events'
import type { Knex } from 'knex'
import { afterEach, describe, expect, it } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import {
  _resetAppPoolPressureForTests,
  _sampleAppPoolsForTests,
  appConcurrency,
  appPoolPressure,
  appPoolTotals,
  trackCurrentAppPool,
  underPressure
} from '../../../services/app-pool-pressure.js'
import { forgetAppState } from '../../../services/app-state.js'

// Pool pressure and concurrency per app on a Hub shared deployment: each app's own pool is
// watched (acquire waits, 5-second samples) and judged by the self-hosted rule inside that app;
// the deployment link gets the sum, never which app. An app that leaves is forgotten.

class FakePool extends EventEmitter {
  used = 0
  free = 0
  pending = 0
  constructor(public max: number) {
    super()
  }
  numUsed = () => this.used
  numFree = () => this.free
  numPendingAcquires = () => this.pending
}

const knexOf = (pool: FakePool) => ({ client: { pool } }) as unknown as Knex

function inApp<T>(app: string, pool: FakePool, fn: () => T): T {
  let out!: T
  runWithTenantDb(
    knexOf(pool),
    app,
    () => {
      out = fn()
    },
    app
  )
  return out
}

afterEach(() => _resetAppPoolPressureForTests())

describe('per-app pool pressure', () => {
  it("times each app's own acquires and samples its own pool", () => {
    const a = new FakePool(4)
    const b = new FakePool(10)
    expect(inApp('A', a, () => trackCurrentAppPool())).toBe(true)
    expect(inApp('B', b, () => trackCurrentAppPool())).toBe(true)
    for (let i = 0; i < 60; i++) {
      a.emit('acquireRequest', i)
      a.emit('acquireSuccess', i, {})
    }
    a.used = 4
    _sampleAppPoolsForTests()
    const pa = inApp('A', a, () => appPoolPressure())
    const pb = inApp('B', b, () => appPoolPressure())
    expect(pa).toMatchObject({ acquires: 60, saturated_pct: 100, peak_used: 4, max: 4 })
    expect(pb).toMatchObject({ acquires: 0, saturated_pct: 0, max: 10 })
    expect(underPressure(pa!)).toBe(true)
    expect(underPressure(pb!)).toBe(false)
  })

  it('outside any app nothing is watched', () => {
    expect(trackCurrentAppPool()).toBe(false)
    expect(appPoolPressure()).toBeNull()
  })

  it('sums every watched pool for the deployment link', () => {
    const a = new FakePool(4)
    const b = new FakePool(10)
    a.used = 2
    a.free = 1
    b.pending = 3
    inApp('A', a, () => trackCurrentAppPool())
    inApp('B', b, () => trackCurrentAppPool())
    expect(appPoolTotals()).toEqual({ apps: 2, used: 2, free: 1, pending: 3, max: 14 })
  })

  it('an app that leaves is forgotten; its pool events then do nothing; a return starts clean', () => {
    const a = new FakePool(4)
    inApp('A', a, () => trackCurrentAppPool())
    a.emit('acquireRequest', 1)
    a.emit('acquireSuccess', 1, {})
    forgetAppState('A')
    expect(appPoolTotals().apps).toBe(0)
    a.emit('acquireRequest', 2)
    a.emit('acquireSuccess', 2, {})
    inApp('A', a, () => trackCurrentAppPool())
    // one listener set only: a fresh tracker, nothing counted twice
    expect(a.listenerCount('acquireSuccess')).toBe(1)
    a.emit('acquireRequest', 3)
    a.emit('acquireSuccess', 3, {})
    expect(inApp('A', a, () => appPoolPressure())?.acquires).toBe(1)
  })
})

describe('per-app concurrency', () => {
  it("counts the app's own sockets and distinct people only", () => {
    const sockets = [
      { tenant: 'A', user: { id: 'u1' } },
      { tenant: 'A', user: { id: 'u1' } },
      { tenant: 'A', user: null },
      { tenant: 'B', user: { id: 'u2' } },
      { tenant: null, user: { id: 'u3' } }
    ]
    expect(appConcurrency(sockets, 'A')).toEqual({ sockets: 3, users: 1 })
    expect(appConcurrency(sockets, 'B')).toEqual({ sockets: 1, users: 1 })
    expect(appConcurrency(sockets, '')).toEqual({ sockets: 0, users: 0 })
  })
})

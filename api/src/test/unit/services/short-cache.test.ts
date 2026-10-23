import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShortCache } from '../../../services/short-cache.js'
import { resetSingleFlight } from '../../../services/single-flight.js'

let clock = 0
const now = () => clock

beforeEach(() => {
  clock = 1_000
  resetSingleFlight()
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('short cache with single-flight', () => {
  it('concurrent misses for one key share ONE load', async () => {
    const c = createShortCache<number>('t1', 1500, { now })
    const d = deferred<number>()
    const load = vi.fn(() => d.promise)
    const a = c.get('k', load)
    const b = c.get('k', load)
    const e = c.get('k', load)
    d.resolve(7)
    expect(await Promise.all([a, b, e])).toEqual([7, 7, 7])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('answers from the cache inside the window and loads again after it', async () => {
    const c = createShortCache<number>('t2', 1500, { now })
    let n = 0
    const load = vi.fn(async () => ++n)
    expect(await c.get('k', load)).toBe(1)
    clock += 1499
    expect(await c.get('k', load)).toBe(1)
    clock += 1
    expect(await c.get('k', load)).toBe(2)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps keys apart (tenant / viewer in the key)', async () => {
    const c = createShortCache<string>('t3', 1500, { now })
    expect(await c.get('tenantA|u1', async () => 'A1')).toBe('A1')
    expect(await c.get('tenantB|u1', async () => 'B1')).toBe('B1')
    expect(await c.get('tenantA|u2', async () => 'A2')).toBe('A2')
    expect(await c.get('tenantA|u1', async () => 'nope')).toBe('A1')
  })

  it('never remembers a failure: the waiters get it, the next caller loads again', async () => {
    const c = createShortCache<number>('t4', 1500, { now })
    const d = deferred<number>()
    const first = c.get('k', () => d.promise)
    const joined = c.get('k', () => Promise.resolve(99))
    d.reject(new Error('deadlock'))
    await expect(first).rejects.toThrow('deadlock')
    await expect(joined).rejects.toThrow('deadlock')
    expect(await c.get('k', async () => 5)).toBe(5)
  })

  it('ages an answer from when its load started', async () => {
    const c = createShortCache<number>('t5', 1500, { now })
    await c.get('k', async () => {
      clock += 1000 // a slow load
      return 1
    })
    clock += 500 // 1500 since the load started
    expect(await c.get('k', async () => 2)).toBe(2)
  })

  it('stays bounded', async () => {
    const c = createShortCache<number>('t6', 1500, { now, max: 3 })
    for (let i = 0; i < 10; i++) await c.get(`k${i}`, async () => i)
    expect(c.size()).toBeLessThanOrEqual(3)
    expect(await c.get('k9', async () => -1)).toBe(9)
  })

  it('forget drops one key or all', async () => {
    const c = createShortCache<number>('t7', 1500, { now })
    await c.get('a', async () => 1)
    await c.get('b', async () => 2)
    c.forget('a')
    expect(await c.get('a', async () => 3)).toBe(3)
    expect(await c.get('b', async () => 4)).toBe(2)
    c.forget()
    expect(c.size()).toBe(0)
  })
})

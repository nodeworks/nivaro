import { describe, expect, it } from 'vitest'
import { LoadCallBuffer } from './nav-load-buffer.js'

const info = (screen = 'admin /traffic-map') => ({ screen, caller: 'uABC', user: 'abc' })
const call = (rid: string | null, start: number, ms = 10) => ({
  rid,
  route: 'GET /api/x',
  start,
  ms,
  status: 200
})

describe('LoadCallBuffer', () => {
  it('keeps calls per load with first / last bounds and a request index', () => {
    const b = new LoadCallBuffer()
    b.note('load-0001', info(), call('r1', 1000, 20))
    b.note('load-0001', info(), call('r2', 990, 5))
    const e = b.get('load-0001')
    expect(e?.calls).toHaveLength(2)
    expect(e?.first).toBe(990)
    expect(e?.last).toBe(1020)
    expect(b.loadOfRequest('r2')?.load).toBe('load-0001')
    expect(b.get('missing')).toBeNull()
  })

  it('forgets the least recently active load past the load cap (and its request index)', () => {
    const b = new LoadCallBuffer(3, 10)
    b.note('load-a0', info(), call('ra', 1))
    b.note('load-b0', info(), call('rb', 2))
    b.note('load-c0', info(), call('rc', 3))
    // a is active again, so b is now the least recently active
    b.note('load-a0', info(), call('ra2', 4))
    b.note('load-d0', info(), call('rd', 5))
    expect(b.size).toBe(3)
    expect(b.get('load-b0')).toBeNull()
    expect(b.loadOfRequest('rb')).toBeNull()
    expect(b.get('load-a0')?.calls).toHaveLength(2)
  })

  it('caps calls per load and counts the rest as dropped', () => {
    const b = new LoadCallBuffer(10, 3)
    for (let i = 0; i < 7; i++) b.note('load-x0', info(), call(`r${i}`, i * 10, 5))
    const e = b.get('load-x0')
    expect(e?.calls).toHaveLength(3)
    expect(e?.dropped).toBe(4)
    expect(e?.last).toBe(65)
    expect(b.loadOfRequest('r6')).toBeNull()
  })

  it('a load id seen on another screen starts over', () => {
    const b = new LoadCallBuffer()
    b.note('load-s0', info('admin /a'), call('r1', 1))
    b.note('load-s0', info('admin /b'), call('r2', 2))
    const e = b.get('load-s0')
    expect(e?.screen).toBe('admin /b')
    expect(e?.calls.map((c) => c.rid)).toEqual(['r2'])
    expect(b.loadOfRequest('r1')).toBeNull()
  })

  it('lists newest first, filtered and capped', () => {
    const b = new LoadCallBuffer()
    b.note('load-p1', info('admin /a'), call(null, 100))
    b.note('load-p2', info('admin /b'), call(null, 300))
    b.note('load-p3', info('admin /a'), call(null, 200))
    expect(b.list((e) => e.screen === 'admin /a').map((e) => e.load)).toEqual([
      'load-p3',
      'load-p1'
    ])
    expect(b.list(undefined, 1).map((e) => e.load)).toEqual(['load-p2'])
  })
})

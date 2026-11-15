import { describe, expect, it } from 'vitest'
import {
  cleanPointTarget,
  createPointLimiter,
  pointTargetSockets
} from '../../../services/field-point.js'

describe('field pointing (realtime round 7 #4)', () => {
  it('lets one sender point the same person once per gap', () => {
    const l = createPointLimiter({ pairGapMs: 5000, perMinute: 10 })
    expect(l.allow('beth', 1000)).toBe(true)
    expect(l.allow('BETH', 3000)).toBe(false)
    expect(l.allow('kim', 3000)).toBe(true)
    expect(l.allow('beth', 6001)).toBe(true)
  })

  it('caps a sender per minute across people', () => {
    const l = createPointLimiter({ pairGapMs: 0, perMinute: 3 })
    expect(l.allow('a', 0)).toBe(true)
    expect(l.allow('b', 1)).toBe(true)
    expect(l.allow('c', 2)).toBe(true)
    expect(l.allow('d', 3)).toBe(false)
    expect(l.allow('d', 60_010)).toBe(true)
  })

  it('reaches only the target person, never the sender socket', () => {
    const viewers = [
      { socket: 's1', id: 'ROB' },
      { socket: 's2', id: 'beth' },
      { socket: 's3', id: 'BETH' },
      { socket: 's2', id: 'beth' },
      { socket: 's4', id: 'kim' }
    ]
    expect(pointTargetSockets(viewers, 'Beth', 's1')).toEqual(['s2', 's3'])
    expect(pointTargetSockets(viewers, 'nobody', 's1')).toEqual([])
    expect(pointTargetSockets(viewers, 'rob', 's1')).toEqual([])
  })

  it('accepts only plain ids as the target', () => {
    expect(cleanPointTarget('0F1E-22aa')).toBe('0F1E-22aa')
    expect(cleanPointTarget(42)).toBe('42')
    expect(cleanPointTarget('x; DROP')).toBeNull()
    expect(cleanPointTarget({ id: 1 })).toBeNull()
    expect(cleanPointTarget('')).toBeNull()
  })
})

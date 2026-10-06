import { describe, expect, it } from 'vitest'
import { diffRows, globMatch, sameValue } from '../../../services/quality/diff.js'

const r = (key: string, values: Record<string, unknown>, cluster?: Record<string, string>) =>
  ({ key, values, ...(cluster ? { cluster } : {}) }) as never

describe('sameValue', () => {
  it('normalises blanks and numbers', () => {
    expect(sameValue(null, '')).toBe(true)
    expect(sameValue('  ', null)).toBe(true)
    expect(sameValue(12, '12')).toBe(true)
    expect(sameValue('12.000', 12)).toBe(true)
    expect(sameValue(true, 1)).toBe(true)
    expect(sameValue('a', 'b')).toBe(false)
    expect(sameValue(100, 101)).toBe(false)
  })
  it('applies tolerance', () => {
    expect(sameValue(100, 100.5, { abs: 1 })).toBe(true)
    expect(sameValue(100, 103, { pct: 2 })).toBe(false)
    expect(sameValue(100, 101, { pct: 2 })).toBe(true)
  })
})

describe('globMatch', () => {
  it('matches * only', () => {
    expect(globMatch('workflow:*', 'workflow:12')).toBe(true)
    expect(globMatch('workflow:12', 'workflow:123')).toBe(false)
    expect(globMatch('a.b', 'aXb')).toBe(false)
  })
})

describe('diffRows', () => {
  it('classifies match, mismatch and one-sided rows', () => {
    const d = diffRows(
      {},
      [r('a', { v: 1 }), r('b', { v: 1 }), r('c', { v: 1 })],
      [r('a', { v: 1 }), r('b', { v: 2 }), r('d', { v: 1 })],
      []
    )
    expect(d.compared).toBe(4)
    expect(d.matched).toBe(1)
    expect(d.red).toBe(3)
    expect(d.baseline_only).toBe(1)
    expect(d.current_only).toBe(1)
    expect(d.status).toBe('red')
    expect(d.rows.find((x) => x.key === 'b')?.reason).toBe('v: production 1 · staging 2')
  })
  it('uses the check expected() hook for amber', () => {
    const d = diffRows(
      { expected: (b, c) => (b && !c ? 'removed duplicate' : null) },
      [r('a', { v: 1 })],
      [],
      []
    )
    expect(d.amber).toBe(1)
    expect(d.red).toBe(0)
    expect(d.status).toBe('amber')
    expect(d.rows[0].reason).toBe('removed duplicate')
  })
  it('applies known differences by key, cluster and field', () => {
    const known = [
      {
        id: 7,
        check_id: 'x',
        match: { key: 'w:*', field: 'owners', cluster: { zone: 'Z1' } },
        reason: 'teams'
      }
    ]
    const d = diffRows(
      {},
      [r('w:1', { owners: 'a' }, { zone: 'Z1' }), r('w:2', { owners: 'a' }, { zone: 'Z2' })],
      [r('w:1', { owners: 'b' }, { zone: 'Z1' }), r('w:2', { owners: 'b' }, { zone: 'Z2' })],
      known
    )
    expect(d.amber).toBe(1)
    expect(d.red).toBe(1)
    expect(d.knownHits.get(7)).toBe(1)
    expect(d.rows[0].key).toBe('w:2') // red first
  })
  it('clusters mismatches', () => {
    const d = diffRows(
      {},
      [r('1', { v: 1 }, { s: 'A' }), r('2', { v: 1 }, { s: 'A' }), r('3', { v: 1 }, { s: 'B' })],
      [r('1', { v: 2 }, { s: 'A' }), r('2', { v: 2 }, { s: 'A' }), r('3', { v: 2 }, { s: 'B' })],
      []
    )
    expect(d.clusters[0]).toEqual({ cluster: { s: 'A' }, red: 2, amber: 0 })
  })
})

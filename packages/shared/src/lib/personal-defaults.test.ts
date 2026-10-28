import { describe, expect, it } from 'vitest'
import type { CascadeRule } from '../components/item-edit/helpers'
import {
  captureContext,
  cascadeParents,
  isEmptyValue,
  orderTopDown,
  pickDefault,
  type SavedDefault
} from './personal-defaults'

const rule = (parent_field: string, upstream = false): CascadeRule => ({
  parent_field,
  filter_column: 'x',
  ...(upstream ? { upstream: true } : {})
})

const graph: Record<string, CascadeRule[]> = {
  ship_to: [rule('region')],
  region: [rule('zone'), rule('ship_to', true)],
  zone: []
}
const rulesFor = (f: string) => graph[f] ?? []

const sd = (id: number, value: unknown, context: Record<string, unknown>, at: string) =>
  ({ id, field: 'ship_to', value, context, updated_at: at }) as SavedDefault

describe('cascadeParents', () => {
  it('walks transitive parents nearest first, skipping upstream rules', () => {
    expect(cascadeParents('ship_to', rulesFor)).toEqual(['region', 'zone'])
  })
  it('is cycle safe', () => {
    const cyc = (f: string) => (f === 'a' ? [rule('b')] : f === 'b' ? [rule('a')] : [])
    expect(cascadeParents('a', cyc)).toEqual(['b'])
  })
})

describe('captureContext', () => {
  it('keeps non-empty parent values only', () => {
    expect(captureContext('ship_to', { region: 3, zone: null }, rulesFor)).toEqual({ region: 3 })
  })
  it('unwraps {id} objects', () => {
    expect(captureContext('ship_to', { region: { id: 3 }, zone: 'z' }, rulesFor)).toEqual({
      region: 3,
      zone: 'z'
    })
  })
})

describe('orderTopDown', () => {
  it('puts parents before children', () => {
    expect(orderTopDown(['ship_to', 'region', 'zone'], rulesFor)).toEqual([
      'zone',
      'region',
      'ship_to'
    ])
  })
  it('keeps input order for unrelated fields', () => {
    expect(orderTopDown(['b', 'a', 'c'], () => [])).toEqual(['b', 'a', 'c'])
  })
})

describe('pickDefault', () => {
  it('exact match', () => {
    const c = sd(1, 10, { region: 3, zone: 2 }, '2026-01-01')
    const r = pickDefault([c], { region: '3', zone: 2 })
    expect(r).toEqual({ pick: c, fillParents: {}, blockedBy: null })
  })
  it('empty draft parents are reported in fillParents', () => {
    const c = sd(1, 10, { region: 3, zone: 2 }, '2026-01-01')
    const r = pickDefault([c], { region: null, zone: 2 })
    expect(r.pick).toBe(c)
    expect(r.fillParents).toEqual({ region: 3 })
  })
  it('mismatch excludes and reports blockedBy', () => {
    const c = sd(1, 10, { region: 3, zone: 2 }, '2026-01-01')
    const r = pickDefault([c], { region: 3, zone: 9 })
    expect(r).toEqual({ pick: null, fillParents: {}, blockedBy: 'zone' })
  })
  it('most specific context wins', () => {
    const a = sd(1, 10, { region: 3 }, '2026-02-01')
    const b = sd(2, 11, { region: 3, zone: 2 }, '2026-01-01')
    expect(pickDefault([a, b], { region: 3, zone: 2 }).pick).toBe(b)
  })
  it('tie goes to newest', () => {
    const a = sd(1, 10, { region: 3 }, '2026-01-01')
    const b = sd(2, 11, { region: 3 }, '2026-02-01')
    expect(pickDefault([a, b], { region: 3 }).pick).toBe(b)
  })
  it('multi-value compares sorted id lists', () => {
    const c = sd(1, 10, { zones: [2, 1] }, '2026-01-01')
    expect(pickDefault([c], { zones: ['1', '2'] }).pick).toBe(c)
    expect(pickDefault([c], { zones: [1, 3] }).pick).toBeNull()
  })
  it('no candidates', () => {
    expect(pickDefault([], {})).toEqual({ pick: null, fillParents: {}, blockedBy: null })
  })
})

describe('isEmptyValue', () => {
  it('flags null, undefined, empty string and empty array', () => {
    expect([null, undefined, '', []].every(isEmptyValue)).toBe(true)
    expect([0, false, 'x', [1]].some(isEmptyValue)).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetCatalogForTests,
  clampSeconds,
  describeTarget,
  faultsAtPoint,
  getFault,
  listFaults,
  registerFault,
  validateParams,
  validateTarget
} from './catalog.js'

beforeEach(() => _resetCatalogForTests())
afterEach(() => _resetCatalogForTests())

const def = () =>
  registerFault({
    key: 'demo',
    label: 'Demo',
    proves: 'demo',
    claim_keys: ['demo.claim'],
    targets: ['all', 'route', 'share'],
    params: {
      n: { type: 'number', label: 'N', min: 1, max: 10, default: 5 },
      mode: { type: 'enum', label: 'Mode', options: ['a', 'b'], default: 'a' },
      on: { type: 'boolean', label: 'On', default: false },
      name: { type: 'string', label: 'Name', max_length: 5 }
    },
    max_seconds: 120,
    points: ['demo.point']
  })

describe('catalog', () => {
  it('registers, lists, indexes by point and rejects bad keys', () => {
    def()
    expect(listFaults().map((f) => f.key)).toEqual(['demo'])
    expect(getFault('demo')?.label).toBe('Demo')
    expect(faultsAtPoint('demo.point')).toHaveLength(1)
    expect(faultsAtPoint('other')).toHaveLength(0)
    expect(() =>
      registerFault({
        key: 'Bad Key',
        label: '',
        proves: '',
        claim_keys: [],
        targets: [],
        params: {},
        max_seconds: 1,
        points: ['p']
      })
    ).toThrow(/bad fault key/)
    expect(() =>
      registerFault({
        key: 'nothing',
        label: '',
        proves: '',
        claim_keys: [],
        targets: [],
        params: {},
        max_seconds: 1,
        points: []
      })
    ).toThrow(/does nothing/)
  })

  it('caps seconds and params silently, refuses wrong enums and types', () => {
    const d = def()
    expect(clampSeconds(d, undefined)).toBe(60)
    expect(clampSeconds(d, 9999)).toBe(120)
    expect(clampSeconds(d, 1)).toBe(5)
    expect(clampSeconds(d, 'abc')).toBe(60)
    expect(validateParams(d, { n: 999, mode: 'b', on: 'true', name: 'abc' })).toEqual({
      n: 10,
      mode: 'b',
      on: true,
      name: 'abc'
    })
    expect(validateParams(d, {})).toEqual({ n: 5, mode: 'a', on: false, name: '' })
    expect(() => validateParams(d, { mode: 'z' })).toThrow(/mode must be one of a, b/)
    expect(() => validateParams(d, { n: 'x' })).toThrow(/n must be a number/)
    expect(() => validateParams(d, { name: 'toolong' })).toThrow(/too long/)
    expect(validateParams(d, { unknown: 1 })).not.toHaveProperty('unknown')
  })

  it('validates targets against the fault and the shape', () => {
    const d = def()
    expect(validateTarget(d, undefined)).toEqual({ kind: 'all' })
    expect(validateTarget(d, { kind: 'route', pattern: '/api/items/*' })).toEqual({
      kind: 'route',
      pattern: '/api/items/*'
    })
    expect(() => validateTarget(d, { kind: 'route', pattern: 'nope' })).toThrow(/pattern/)
    expect(() => validateTarget(d, { kind: 'share', share_pct: 0 })).toThrow(/share_pct/)
    expect(() => validateTarget(d, { kind: 'user', user_id: 'x' })).toThrow(/cannot target user/)
    expect(describeTarget({ kind: 'share', share_pct: 10 })).toBe('10% of traffic')
    expect(describeTarget({ kind: 'user', user_id: 'x' })).toBe('one person')
  })
})

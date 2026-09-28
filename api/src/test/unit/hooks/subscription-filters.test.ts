import { describe, expect, it } from 'vitest'
import { filterMatches, parseSubFilters } from '../../../hooks/notification-subscriptions.js'

describe('parseSubFilters (#797)', () => {
  it('reads the stored JSON list and keeps only well-formed entries', () => {
    const raw = JSON.stringify([
      { field: 'divisions', op: 'intersects', value: [2] },
      { field: '', op: 'eq', value: 1 },
      { op: 'eq', value: 1 },
      null,
      'nonsense'
    ])
    expect(parseSubFilters(raw)).toEqual([{ field: 'divisions', op: 'intersects', value: [2] }])
  })

  it('yields nothing for a malformed or absent column', () => {
    expect(parseSubFilters(null)).toEqual([])
    expect(parseSubFilters('{not json')).toEqual([])
    expect(parseSubFilters('{"field":"x","op":"eq"}')).toEqual([])
  })

  it('accepts an already-parsed array', () => {
    expect(parseSubFilters([{ field: 'a', op: 'null' }])).toEqual([{ field: 'a', op: 'null' }])
  })
})

describe('filterMatches on every event type', () => {
  it('a record watch passes its own id filter and fails another record', () => {
    expect(filterMatches('eq', 371367, '371367')).toBe(true)
    expect(filterMatches('eq', 371368, '371367')).toBe(false)
  })
  it('intersects over an M2M id array', () => {
    expect(filterMatches('intersects', [1, 2], ['2'])).toBe(true)
    expect(filterMatches('intersects', [1, 3], ['2'])).toBe(false)
    expect(filterMatches('intersects', [], ['2'])).toBe(false)
  })
  it('an unresolved path (undefined) fails eq/in/nnull and passes null', () => {
    expect(filterMatches('eq', undefined, 'x')).toBe(false)
    expect(filterMatches('in', undefined, ['x'])).toBe(false)
    expect(filterMatches('nnull', undefined, undefined)).toBe(false)
    expect(filterMatches('null', undefined, undefined)).toBe(true)
  })
})

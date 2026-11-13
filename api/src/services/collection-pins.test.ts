import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))

import { describePinChange, normalizePinList, parseStoredPins, pinsKey } from './collection-pins.js'

describe('normalizePinList', () => {
  it('keeps order, drops repeats and blank entries', () => {
    expect(normalizePinList(['b', 'a', 'b', ' ', 'c'])).toEqual({ list: ['b', 'a', 'c'] })
  })
  it('refuses something that is not a list or holds a non-name', () => {
    expect('error' in normalizePinList('a')).toBe(true)
    expect('error' in normalizePinList(['a; drop table x'])).toBe(true)
    expect('error' in normalizePinList([1])).toBe(true)
  })
  it('refuses more than 24 pins', () => {
    const many = Array.from({ length: 25 }, (_, i) => `t${i}`)
    expect('error' in normalizePinList(many)).toBe(true)
  })
})

describe('parseStoredPins', () => {
  it('reads a stored list and tolerates junk', () => {
    expect(parseStoredPins('["a","b"]')).toEqual(['a', 'b'])
    expect(parseStoredPins('not json')).toEqual([])
    expect(parseStoredPins(null)).toEqual([])
    expect(parseStoredPins('{"a":1}')).toEqual([])
  })
})

describe('pinsKey', () => {
  it('the default workspace keeps the plain key; others are keyed by id', () => {
    expect(pinsKey('00000000-0000-0000-0000-000000000001')).toBe('collection_pins')
    expect(pinsKey(null)).toBe('collection_pins')
    expect(pinsKey('ABCDEF00-0000-0000-0000-000000000002')).toBe(
      'collection_pins:abcdef00-0000-0000-0000-000000000002'
    )
  })
})

describe('describePinChange', () => {
  it('says what was pinned, unpinned and reordered', () => {
    expect(describePinChange(['a', 'b'], ['b', 'c'])).toBe(
      'Pinned collections: pinned c; unpinned a'
    )
    expect(describePinChange(['a', 'b'], ['b', 'a'])).toBe('Pinned collections: reordered (b, a)')
    expect(describePinChange(['a'], ['a'])).toBeNull()
  })
})

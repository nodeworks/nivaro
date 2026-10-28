import { describe, expect, it } from 'vitest'
import { compareByMatch, pickerMatchTier } from './picker-rank'

describe('picker option ranking', () => {
  it('puts the exact person first while typing', () => {
    const labels = ['Glo Dendy', 'Robert Dowdrick', 'Robert Goldman', 'Robert Lee', 'Robert Sass']
    expect([...labels].sort((a, b) => compareByMatch(a, b, 'Robert Lee'))[0]).toBe('Robert Lee')
  })

  it('tiers: exact, prefix, word prefixes, contains, other', () => {
    expect(pickerMatchTier('Robert Lee', ' robert  lee ')).toBe(0)
    expect(pickerMatchTier('Robert Leeds', 'robert lee')).toBe(1)
    expect(pickerMatchTier('Lee, Robert', 'rob lee')).toBe(2)
    expect(pickerMatchTier('Mr Robert Lee', 'bert lee')).toBe(3)
    expect(pickerMatchTier('Glo Dendy', 'robert lee')).toBe(4)
  })

  it('keeps label order with no query, and honours descending', () => {
    expect(['b', 'a', 'c'].sort((a, b) => compareByMatch(a, b, ''))).toEqual(['a', 'b', 'c'])
    expect(['b', 'a', 'c'].sort((a, b) => compareByMatch(a, b, '', true))).toEqual(['c', 'b', 'a'])
  })
})

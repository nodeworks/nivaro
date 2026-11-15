import { describe, expect, it } from 'vitest'
import { PEOPLE_LIST_KEYS, PERSON_KEYS, peopleQueryMatches } from './user-sync'

describe('people:changed → which queries refetch', () => {
  it('people lists always refetch', () => {
    expect(peopleQueryMatches(['users', 'mention-search', 'an'], new Set(['X']))).toBe(true)
    expect(peopleQueryMatches(['nvr-chat-directory'], null)).toBe(true)
  })

  it('a person’s card or avatar refetches only when that person is named', () => {
    const named = new Set(['AAA'])
    expect(peopleQueryMatches(['user-card', 'aaa'], named)).toBe(true)
    expect(peopleQueryMatches(['user-card', 'bbb'], named)).toBe(false)
    expect(peopleQueryMatches(['user-avatar', 'bbb'], null)).toBe(true)
  })

  it('anything else is left alone', () => {
    expect(peopleQueryMatches(['item', 'workflows', '1'], null)).toBe(false)
    expect(peopleQueryMatches([42], null)).toBe(false)
  })

  it('the two key lists do not overlap', () => {
    for (const k of PERSON_KEYS) expect(PEOPLE_LIST_KEYS.has(k)).toBe(false)
  })
})

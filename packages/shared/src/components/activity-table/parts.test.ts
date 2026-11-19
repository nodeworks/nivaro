import { describe, expect, it } from 'vitest'
import { personInitials } from './parts'

describe('personInitials', () => {
  it('reads the name, not the account note in brackets', () => {
    expect(personInitials('Pat Lee (deleted user)')).toBe('PL')
    expect(personInitials('Deleted user')).toBe('DU')
    expect(personInitials('Redacted person')).toBe('RP')
    expect(personInitials('')).toBe('?')
  })
})

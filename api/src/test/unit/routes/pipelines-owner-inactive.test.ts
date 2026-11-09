import { describe, expect, it } from 'vitest'
import { isRedactedPerson, ownerInactiveKind } from '../../../routes/pipelines.js'

// army 11 0.3.95 check: a redacted owner read "Redacted Redacted · suspended".
describe('owner inactive kind', () => {
  it('a redacted account is a former user even when its status says suspended', () => {
    expect(ownerInactiveKind({ status: 'suspended', is_redacted: 1 })).toBe('former')
    expect(
      ownerInactiveKind({ status: 'suspended', first_name: 'Redacted', last_name: 'Redacted' })
    ).toBe('former')
    expect(isRedactedPerson({ first_name: ' redacted', last_name: 'REDACTED ' })).toBe(true)
  })
  it('suspended stays suspended; an active person is null', () => {
    expect(ownerInactiveKind({ status: 'suspended', first_name: 'Joseph' })).toBe('suspended')
    expect(ownerInactiveKind({ status: 'archived' })).toBe('former')
    expect(ownerInactiveKind({ status: 'active', first_name: 'Nick' })).toBeNull()
  })
})
